# recently-viewed — SovEcom reference module (AGPL-3.0)

Tracks the products a shopper looks at and surfaces their most-recently-viewed ones as a
**"Recently viewed"** rail (slot `home-page-bottom`). It is a worked example of a **per-viewer**,
low-sensitivity module on the sandboxed runtime: the permissions it declares (and only those) gate
every capability, and the core broker enforces them.

## Permissions (least-privilege)

| Permission         | Why                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------- |
| `write:own_tables` | Store views in the module's own `mod_recently-viewed_views` table (parameterized SQL). |
| `read:products`    | Enrich the list (title/slug/status) and optionally verify a product exists on record.  |

No `read:orders`, no `read:customers`, no `email:*`, no `subscribe:events`, no `http:outbound` — the
module needs none of them. (Note `read:categories` is **not** declared either; see "Category
exclusion" below for why it would not help anyway.)

## Identity — who is a "viewer"?

A recently-viewed history is **per viewer**. The module resolves the viewer key from exactly two
honest, non-overlapping sources (`src/identity/viewer.ts`):

1. **Account (primary, fully supported).** A logged-in shopper. The viewer key is the
   **core-verified** `req.customer.id` — set by core from a customer JWT it verified itself. It is
   **never** read from the body/query/headers. This is the secure, per-customer path the integration
   suite drives end-to-end.

2. **Guest (opt-in, storefront-managed).** An anonymous shopper. **Guest cookies are a storefront concern** — the sandboxed module does not and must
   not manage storefront cookies. So instead of inventing an insecure scheme, the module accepts an
   **opaque, high-entropy guest token the storefront supplies**. The token **is** the viewer key.

   **Send it in the `x-rv-guest` HEADER.** The shipped slot component does exactly that. The server
   also accepts `?guest=` as a documented **last resort**, but a query-string token leaks via access
   logs, the `Referer` header, and browser history (no secrets in URL/query/logs), so a correct
   client uses the header.

   Recently-viewed history is **low-sensitivity** (not PII), but the module still must never let one
   guest read another's by a guessable id. So it requires the token to clear a length floor
   (`MIN_GUEST_TOKEN_LEN`, 16 chars) **and** carry no control characters — a short/empty/control-char
   token is **rejected**, never silently shared. The storefront is expected to mint a real
   high-entropy value (e.g. a 128-bit random, base64url).

A verified customer **always wins** over any supplied guest token (you cannot impersonate by sending
a guest token while logged in). When neither yields a usable key there is **no viewer**: a write
returns `401`, a read returns an empty list (a read leaks nothing).

### Key namespacing (no customer/guest collision)

The customer id and the guest token share the one `viewer_key` column, so the resolved key is
**namespace-prefixed by kind**: a customer → `cust:<id>`, a guest → `guest:<token>`. Without this a
guest could supply `?guest=<a known customer's UUID>` (≥16 chars → accepted) and the raw key would
**collide** with that customer's, reading + polluting their history. The prefixes make the two key
spaces disjoint by construction — `cust:<id>` can never equal `guest:<token>` — so a guest token,
whatever string it is, can never address a customer. Proven on real PG (`int-spec`: the
"namespace collision guard" case).

### Guest-cookie deferral

**Minting, storing, and rotating the guest cookie is the storefront's job.** This module only
consumes whatever opaque token the host forwards. Guest tracking works for any caller that supplies a
valid high-entropy token; account-based tracking works fully today.

## Endpoints (store surface only)

This module has **no admin surface** — the feature is entirely store-facing. Core proxies
`/store/v1/modules/recently-viewed/*` here.

- `POST /store/v1/modules/recently-viewed/views` — body `{ productId }`. Records (or refreshes) a
  view for the viewer. Requires a viewer (`401 login_required` when anonymous with no token).
  Validates `productId`. **Dedupe + bump:** re-viewing the same product never adds a second row — it
  moves the existing row to the top (newest) via `ON CONFLICT (viewer_key, product_id) DO UPDATE SET
viewed_at = now()`. Returns `204`. (When `verifyProductExists` is enabled, an unknown product is a
  `404 product_not_found`; off by default — recording a view is a cheap signal and a stale id simply
  never enriches on read.)
- `GET /store/v1/modules/recently-viewed/recent?exclude=<id>` — the viewer's most-recently-viewed
  products, **newest first**, capped at `maxItems`, excluding the optional `?exclude` product (the
  one currently on screen) and any product in an excluded category. Each item is enriched via
  `read:products` (best-effort: a gone/unpublished product degrades to `product: null`, never dropped).
  An unresolved viewer gets `200` with an empty list.

## Per-viewer isolation

Every SQL statement binds `viewer_key` as a parameter (sourced from the resolved viewer, never free
client input). A read/write is **always** scoped to one `viewer_key`, so viewer A can never see or
mutate viewer B's history — for accounts and guests alike. The integration suite proves this against
real Postgres (customer↔customer, guest↔customer, guest↔guest).

## Settings

`settings.schema.json` (resolved + clamped in `src/settings.ts`):

| Setting             | Type     | Default | Bounds / behaviour                                                                                       |
| ------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `enabled`           | boolean  | `true`  | When `false`, every endpoint returns `404`.                                                              |
| `maxItems`          | integer  | `8`     | How many items `GET /recent` returns. Clamped to `[1, 50]`.                                              |
| `excludeCategories` | string[] | `[]`    | Category ids whose products are never surfaced. De-duped, each entry length-capped, list bounded to 100. |

A missing/garbage value can never break the read surface — every field is clamped to a safe range.

> **Settings wiring (runtime gap):** the runtime does not yet thread the admin-configured settings
> bag into `activate(sdk)`. Until it does, `activate()` calls `resolveSettings(undefined)` → safe
> defaults. When the bag is exposed, pass it at that single call site — nothing else changes.

## Category exclusion

Admins can hide products in certain categories from the rail. To support this the module must, for a
candidate product, learn **which category it belongs to**. The gated `read:products` surface carries
that signal:

- `ModuleProductDto` now includes the product's **primary category** —
  `category?: { id, slug, name }` — populated by core from `product_categories`/`categories`
  (lowest-`position`, id-tiebroken). It rides the **existing `read:products` grant** — no new
  permission, no PII (a category is catalog metadata). A product with no category omits it.

So a product's category **is** resolvable end-to-end through `sdk.store.products(productId)`. The
filter stays a single injectable **seam** — `ProductCategoryResolver`
(`src/category/category-filter.ts`) — so tests can stub it. The **runtime default**
(`storeProductCategoryResolver`) reads `ModuleProductDto.category.id` from the catalog read and
excludes a product whose category id is in `excludeCategories`. The retained `excludeNothingResolver`
is the honest "categories unknown → exclude nothing" fallback for callers with no catalog read. The
unit + integration suites drive the exclude both end-to-end (real DTO category) and via an injected
stub.

> Operator note: `excludeCategories` is a **UX preference**, not a compliance / age-gating mechanism.
> It **fails OPEN** — if the category read errors (e.g. a catalog outage), the product is shown rather
> than hidden, because for a "recently viewed" rail availability beats hiding. Do **not** rely on it to
> keep a sensitive/age-restricted category off-screen; enforce that in the catalog/storefront itself.

## Storefront slot — data-descriptor widget

The module contributes storefront UI by returning a typed **widget descriptor** `{ type, props }` —
**DATA only, never code/HTML** — from its existing store mount:

```
GET /store/v1/modules/recently-viewed/slot?slot=home-page-bottom&route=/
```

It maps to the storefront's MIT **`product-carousel`** widget (READ-ONLY). The handler
([`src/slot/recently-viewed-slot.ts`](src/slot/recently-viewed-slot.ts)) resolves the visitor with the
existing identity seam (core-verified `req.customer.id`, else the high-entropy `x-rv-guest` token — so it
is **visitor-scoped**), enriches the recent products via the gated `read:products` read, and returns
`{ type: 'product-carousel', props: { items: [{ productId, slug, title }] } }`, capped at ≤24 items. No
resolvable visitor / empty history / unknown slot → **204** (decline). The storefront validates the body
with `parseWidget` and renders its OWN component — **no module code/HTML ever enters the storefront
bundle**.

> The guest token is still supplied by the storefront in the `x-rv-guest` HEADER (never the query
> string); minting/rotating that cookie remains the storefront's job.

## Storage

The module's own `mod_recently-viewed_views` table (the hyphenated module name makes the identifier
illegal **unquoted**, so it is double-quoted everywhere — `src/db/schema.ts`). One row per
`(viewer_key, product_id)`, `UNIQUE(viewer_key, product_id)` for dedupe, a `(viewer_key, viewed_at
DESC)` index backing the newest-first read. All access is parameterized SQL via `sdk.tables` under
the module's low-privilege DB role — it can never touch a core table.

## Tests

- **Unit** (`test/`, mocked SDK): settings clamping; identity resolution (account/guest/none, token
  floor, customer-wins); category-filter seam; handlers — record/dedupe/bump, validation,
  guest+account, newest-first/cap/`?exclude`/`excludeCategories`, enrichment degrade, per-viewer
  isolation, routing (disabled → 404, admin surface → 404).
- **Integration** (`apps/api/test/integration/modules/recently-viewed.int-spec.ts`, real Postgres):
  install → migrate → POST views as an authenticated customer over the real broker → GET recent
  (newest-first, capped, deduped, enriched); per-viewer isolation (customer↔customer, guest↔customer,
  guest↔guest); `excludeCategories` filter via the seam; `?exclude`; anonymous handling; unknown
  product (`read:products` end-to-end); migration; `write:own_tables` enforcement.
- `module-contract-tests .` passes (manifest valid, tables namespaced, permissions sufficient,
  core-version compatible).

## License

AGPL-3.0-only. See `LICENSE`.
