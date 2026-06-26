# reviews — SovEcom reference module (AGPL-3.0)

Purchase-gated, moderated, **text-only** product reviews (v1). A logged-in shopper who **purchased**
a product may leave one rating (1–5) plus a short text review. Reviews are **moderated** — a new
review is `pending` until an admin approves it, and only `approved` reviews are public (along with
the approved-only average). This is a worked example of a customer-scoped, purchase-gated, moderated
module on the sandboxed runtime: the permissions it declares (and only those) gate every capability,
and the core broker enforces them.

## Permissions (least-privilege)

| Permission         | Why                                                                                |
| ------------------ | ---------------------------------------------------------------------------------- |
| `write:own_tables` | Store reviews in the module's own `mod_reviews_reviews` table (parameterized SQL). |
| `read:products`    | Reject a review for a product the catalog does not have (`404 product_not_found`). |
| `read:orders`      | The purchase gate (see below) probes the gated orders surface.                     |

No `email:*`, no `subscribe:events`, no `http:outbound` — the module needs none of them.

## Endpoints

The handler branches on `req.surface` (`store` = public; `admin` = admin-JWT + `modules:use`, gated
by the core proxy mount).

### Store (public)

- `POST /store/v1/modules/reviews/reviews` — body `{ productId, rating, body }`. Requires a
  logged-in customer (`401 login_required` if anonymous). **Purchase-gated** (`403 not_purchased`).
  Validates `rating ∈ [1,5]` integer and the body length against settings (control-char-safe).
  Rejects a duplicate `(customer, product)` review with `409 already_reviewed`. Stores `pending`
  (or `approved` when `autoApprove` is set). `201` on success.
- `GET /store/v1/modules/reviews/reviews?productId=<id>` — **public**. Returns ONLY `approved`
  reviews plus `{ average, count }` computed from approved reviews only. No customer id is exposed.

### Admin (moderation)

- `GET /admin/v1/modules/reviews/queue` — the pending-review moderation queue.
- `POST /admin/v1/modules/reviews/:id/approve` — approve (idempotent → `204`).
- `POST /admin/v1/modules/reviews/:id/reject` — reject (idempotent → `204`).

The admin paths are reachable ONLY on the admin surface; the same paths on the public store surface
return `404`, so a public caller can never moderate.

## Purchase gate

The purchase gate requires that a review be left ONLY by a customer who **purchased** the product.
The module gets the core-verified `req.customer.id`, so it knows _who_ is asking — and the gated
`read:orders` surface lets it confirm that customer bought _this_ product:

- `sdk.commerce.hasPurchased(customerId, productId)` returns a **bare boolean**: `true` iff the
  tenant has a paid (or later — fulfilled/shipped/…/refunded) order for that customer containing that
  product. It is **gated by the existing `read:orders` permission** (default-deny: `FORBIDDEN`
  without it), **tenant-scoped** from the broker context (never module input), and returns **only the
  boolean** — no order rows, ids, or amounts cross the boundary (least-privilege).

So a `(customer, product)` purchase is now **genuinely verifiable** through the module surface.

**How this module uses it:** the entire purchase decision is funnelled through ONE seam,
`hasPurchased(commerce, customerId, productId, verifier)` in
[`src/purchase/purchase-gate.ts`](src/purchase/purchase-gate.ts):

- the seam delegates to an injected `PurchaseVerifier`; the **default**
  (`commercePurchaseVerifier`) calls `sdk.commerce.hasPurchased` and returns its real verdict — a
  purchaser → `pending` (moderated), a non-purchaser → `403 not_purchased`. A thrown/refused probe
  (e.g. `read:orders` not granted) degrades to **deny** — an unprovable purchase is never a pass
  (secure-by-default). The retained `denyUnverifiablePurchaseVerifier` is a closed fallback.
- the seam stays **injectable** so tests can pin a deterministic verdict; the integration suite drives
  the gate end-to-end against a real seeded paid order.

> Operator note (refunded orders count): `hasPurchased` treats `refunded` / `partially_refunded`
> orders as purchases — a customer who received the product and was later refunded still bought it, so
> they remain review-eligible. If your policy is stricter (no reviews after a refund), that is a
> future core change to the purchased-status set, not a module setting.

> **Known limitation (since-hard-deleted variant):** a purchase is matched through the order line's
> `variant → product` relation. An order line keeps its fiscal snapshot but its `variant_id` is set
> to `NULL` if the variant is later hard-deleted for invoice-retention reasons, and the line carries
> no `product_id`. So a customer who bought a product whose variant was since hard-deleted cannot
> review _that_ product — the gate returns `403 not_purchased`. This is rare and **fails secure
> (deny)** — it can never let a non-purchaser through.

> Operator note: an operator who deliberately wants open reviews (no purchase requirement) can inject
> a permissive verifier at the `activate()` wiring site, but that is an explicit, documented opt-out
> of the doc-13 purchase requirement — not the default.

## Settings

Resolved + clamped in [`src/settings.ts`](src/settings.ts) (schema:
[`settings.schema.json`](settings.schema.json)):

| Key           | Default | Meaning                                                           |
| ------------- | ------- | ----------------------------------------------------------------- |
| `enabled`     | `true`  | Master on/off; disabled → every endpoint is `404`.                |
| `minTextLen`  | `10`    | Minimum body length (code points). Clamped to `[0, maxTextLen]`.  |
| `maxTextLen`  | `2000`  | Maximum body length (code points). Clamped to `[1, 5000]`.        |
| `autoApprove` | `false` | When `true`, new reviews are stored `approved` (skip moderation). |

### Settings wiring (deferred)

The runtime does not yet thread the admin-configured settings bag into `activate(sdk)`. Until then
`resolveSettings(undefined)` yields safe defaults; when the runtime exposes the bag, pass it at the
single call site in [`src/index.ts`](src/index.ts) — nothing else changes.

## Storage

One namespaced table, `mod_reviews_reviews`, created by the idempotent migration in
[`src/db/schema.ts`](src/db/schema.ts). `UNIQUE(customer_id, product_id)` enforces one review per
customer per product; a DB `CHECK` constrains `rating ∈ [1,5]` and `status ∈ {pending, approved,
rejected}` as defense-in-depth. Every statement is parameterized and runs under the module's
low-privilege DB role — the module can never touch a core table. The approved-only public reads +
averages are enforced in SQL.

- The public read returns the approved rows and their `{ count, average }` from ONE consistent
  snapshot (a window aggregate), so a concurrent approval can never make the two disagree.
- The admin moderation queue is bounded (`LIMIT`, default 200 / max 500) with `?limit` / `?offset`
  paging, so a large/spam backlog can never return an unbounded result set. Its response omits
  `customer_id` — an admin moderates the content, so the reviewer's id is kept out (PII minimisation).
- The ids (`id`, `customer_id`, `product_id`) are `text` deliberately: a module treats core ids as
  opaque strings and does not couple to core's internal uuidv7 format.

## Slot UI — data-descriptor widget

The module contributes storefront UI by returning a typed **widget descriptor** `{ type, props }` —
**DATA only, never code/HTML** — from its existing store mount:

```
GET /store/v1/modules/reviews/slot?slot=product-detail-reviews-section&route=<productId>
```

It maps to the storefront's MIT **`review-list`** widget (the manifest `slots[].component` names that
widget type). The handler ([`src/slot/reviews-slot.ts`](src/slot/reviews-slot.ts)) reuses the existing
approved-only read (`approvedWithSummary`) — **only approved reviews surface** — and returns
`{ type: 'review-list', props: { items: [{ id, rating, body, createdAt }] } }`, anonymous (no author /
customer id) and capped at ≤50 items with body ≤2000 code points. An unknown slot / missing route →
**204** (the module declines; the storefront renders nothing). The storefront validates the body with
`parseWidget` and renders its OWN component — **no module code/HTML ever enters the storefront bundle**.

## Develop

```bash
pnpm build          # tsc → dist/ (worker build, includes the slot DATA handler)
pnpm typecheck      # tsc --noEmit
pnpm lint
pnpm test           # vitest unit tests (mocked SDK), incl. test/slot.spec.ts
pnpm contract       # module-contract-tests .
```

The real-Postgres end-to-end path is covered by
`apps/api/test/integration/modules/reviews.int-spec.ts`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
