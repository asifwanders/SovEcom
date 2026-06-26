# Wishlist — a SovEcom reference module

A per-customer wishlist for SovEcom. A logged-in shopper adds product variants to a personal list,
views it, and removes from it; an opt-in **weekly digest** emails them when a wishlisted item's
price drops. This is **AGPL-3.0 reference code** — it is meant to be read and forked. It is a worked
example of a _customer-scoped_ module on the sandboxed runtime: it declares the minimum permissions,
reads a **core-verified** customer identity, stores data in its **own** namespaced tables, and sends
email through the gated mail capability.

## What's here

```
wishlist/
├── sovecom.module.json       # manifest: name, permissions, slot, settings ref, tables
├── settings.schema.json      # JSON Schema for the admin-configurable settings
├── package.json              # depends on @sovecom/module-sdk; builds to a CJS dist/index.js
├── tsconfig.json             # worker build (CommonJS); excludes tests
├── src/
│   ├── index.ts              # defineModule({ activate(sdk) }) — migration, serve, subscribe
│   ├── settings.ts           # resolve + clamp the settings bag (pure)
│   ├── db/
│   │   ├── schema.ts         # mod_wishlist_* table names + idempotent migration DDL
│   │   └── repository.ts     # parameterized SQL over sdk.tables (customer-scoped)
│   ├── api/handlers.ts       # add (POST /items, POST /items/:id/add) / remove (DELETE + POST /items/:id/remove) / list (GET) / slot (GET)
│   ├── events/subscriptions.ts # subscribes to product.price_changed → digest (see "Digest wiring")
│   ├── digest/digest.ts      # the directly-invokable price-drop digest (idempotent, opt-in)
│   └── slot/wishlist-slot.ts # the product-card slot DATA handler (toggle-button descriptor)
├── test/                     # unit tests (handlers/digest/settings vs a mocked SDK)
├── README.md
├── .gitignore
└── LICENSE                   # AGPL-3.0
```

## Endpoints

Core mounts these under `/store/v1/modules/wishlist/*` and proxies them to the module worker.

| Method   | Path                | Body                   | Result                              |
| -------- | ------------------- | ---------------------- | ----------------------------------- |
| `POST`   | `/items`            | `{ productVariantId }` | `201` added / `200` already present |
| `GET`    | `/items`            | —                      | `200 { items: [...] }` (enriched)   |
| `DELETE` | `/items/:variantId` | —                      | `204` removed / `404` not found     |

**All three require a logged-in customer.** When no valid customer token is presented the endpoint
returns **`401 { error: "login_required" }`**. Adding past the configured cap returns
`409 { error: "max_items_reached" }` (a repeat add of an existing item is idempotent and never
counts against the cap).

### How the customer identity is trusted

The module reads the buyer **only** from `req.customer.id`. That field is set by the core store
proxy from a customer JWT **core verified itself**: absent for anonymous callers, and a
_presented-but-bad_ token is rejected with `401` before the request ever reaches the module. The raw token is stripped; the module only ever sees `{ id }`. A
`customer` field in the request body/query/headers **cannot** influence this. Because every SQL
statement binds `customer_id` as a parameter, one customer can never read or mutate another's items.

## Permissions (and why each)

Declared in `sovecom.module.json` — the **minimum** the code uses (default-deny; the core broker
enforces them and the SDK cannot widen them):

| Permission         | Why it's needed                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `write:own_tables` | Store wishlist rows + the digest idempotency ledger in `mod_wishlist_*`.                                 |
| `read:products`    | Enrich the list response with product slug/title/status via `sdk.store`.                                 |
| `subscribe:events` | Subscribe to `product.price_changed` to drive the price-drop digest (and `product.updated` as a signal). |
| `email:send`       | Send the opt-in weekly price-drop digest via core's mail service.                                        |

We do **not** request `read:customers` (the field-limited DTO has no email, so it wouldn't help),
`emit:events`, or `http:outbound` — none are used.

## Tables

Both are namespaced `mod_wishlist_*` (the hard rule: a module never touches core tables) and
declared in the manifest:

- **`mod_wishlist_items`** — `(id, customer_id, product_variant_id, created_at)`, with
  `UNIQUE(customer_id, product_variant_id)` (makes "add" idempotent).
- **`mod_wishlist_digest_log`** — the digest idempotency ledger,
  `UNIQUE(customer_id, product_variant_id, digest_run_id)` (so a digest re-run never double-sends).

The migration is `CREATE TABLE IF NOT EXISTS …` run at `activate()`, so it is safe on every worker
start. **Uninstall data deletion:** dropping the module schema is handled by the core uninstall path
(`DELETE …/wishlist?dropData=true`) — the module declares its tables and core owns their lifecycle.

## Digest wiring

The weekly digest is **opt-in** and **idempotent**, and its **trigger is event-driven**:

- Core emits an **observational** `product.price_changed` event carrying
  `{ eventId, productId, variantId, oldPriceMinor, newPriceMinor, currency }` after a variant's price
  **actually** changes (never on a no-op). Prices are **public** catalog data, so carrying old+new
  is safe and is exactly what drop detection needs. `eventId` is a core-assigned, **unique-per-emit**
  opaque id — the correct idempotency key.
- `src/events/subscriptions.ts` subscribes to it (gated by `subscribe:events`) and, on a real
  **drop** (`newPriceMinor < oldPriceMinor`), feeds a single candidate to the existing idempotent
  `runPriceDropDigest`, keying the digest run on `eventId`. The price comparison no longer needs an
  out-of-band trigger — the event drives it. The per-`(customer, variant, run)` ledger makes
  reprocessing the SAME event a no-op, while two genuinely distinct drops of the same magnitude (a
  flash-sale cycle) each carry a different `eventId` and so each fire.

`runPriceDropDigest` (exported from the package) stays directly-invokable too, so a scheduled
backfill / admin job / test can still drive it with a batch of candidates — the event path and the
direct path share the same idempotent core.

**Email — `sdk.email.sendToCustomer`.** The digest does not need to resolve an address itself. It calls `sdk.email.sendToCustomer({ customerId, subject, text })`: the
module supplies **only the customer id** and **never sees the email**. **Core** resolves the
recipient by the `(tenant, customerId)` composite (tenant from the broker context — a foreign-tenant
id resolves to nothing), honours **marketing consent** (`accepts_marketing`) and **RGPD erasure**
(`deleted_at` / `anonymized_at`), validates + rate-limits + audits, and either **sends**
(`{ queued: true }`) or **suppresses** (`{ queued: false }`). The module **cannot learn why** a send
was suppressed (no consent/existence oracle). It rides the existing `email:send` permission — no new
grant. The per-`(customer, variant, run)` ledger consumes the claim on a queued **or** suppressed
send (so an opted-out customer is not retried each run) and rolls it back only if the send **throws**
an `RpcError` (so a transient failure is retried). The old injected `resolveEmail` seam is **gone**.

`src/events/subscriptions.ts` also still subscribes to `product.updated` as a lightweight
"a product changed" log signal, kept for parity; the price path is the live one.

## Slot UI — data-descriptor widget

The module contributes storefront UI by returning a typed **widget descriptor** `{ type, props }` —
**DATA only, never code/HTML** — from its existing store mount:

```
GET /store/v1/modules/wishlist/slot?slot=product-card-actions&route=<productId>
```

It maps to the storefront's MIT **`toggle-button`** widget (PERSONALIZED — rendered as a client island).
The handler ([`src/slot/wishlist-slot.ts`](src/slot/wishlist-slot.ts)) reads the verified customer ONLY
from `req.customer.id`: an **anonymous visitor → 204** (a wishlist needs an account); a signed-in
customer → `{ type: 'toggle-button', props: { initialOn: has(customerId, productId), onAction, offAction,
labels, icon: 'heart' } }`. Because the proxy reads the customer only from a **Bearer** token, the
storefront island attaches the in-memory access token as `Authorization: Bearer …` on the slot GET (and
on the toggle's POST-back); a guest sends none.

The toggle posts back (no body) to **this module's OWN mount** — the bodyless path-based aliases:
`POST /store/v1/modules/wishlist/items/<productId>/add` and `…/items/<productId>/remove` (the original
`POST /items` body-keyed add + `DELETE /items/:id` remove are retained). The storefront pins both action
paths to the wishlist module (own-mount) and validates the whole descriptor with `parseWidget` — **no
module code/HTML ever enters the storefront bundle**.

## Settings wiring

`settings.schema.json` documents the admin-configurable settings (`enabled`,
`maxItemsPerCustomer`, `weeklyDigest`). `resolveSettings()` parses + clamps a settings bag to safe
ranges (the per-customer cap can never be disabled or made absurd). Until the runtime threads a
typed settings object into `activate(sdk)`, the module resolves safe defaults; swap in the
admin-supplied bag at that one call site when the runtime exposes it.

## Develop

```bash
pnpm install
pnpm --filter @sovecom/module-wishlist build       # tsc → dist/index.js (CommonJS)
pnpm --filter @sovecom/module-wishlist test        # unit tests (mocked SDK)
pnpm --filter @sovecom/module-wishlist contract     # module-contract-tests conformance
```

The built `dist/index.js` is what the SovEcom runtime loads
(`SOVECOM_MODULE_MAIN=<dir>/index.js`).

## License

AGPL-3.0. See `LICENSE`. As a network-served module, the AGPL's §13 source-availability obligation
applies — keep your forked source available to its users.
