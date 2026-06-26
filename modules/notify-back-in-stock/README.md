# Notify-back-in-stock — a SovEcom reference module

A guest-friendly **back-in-stock notifier** for SovEcom. A shopper — logged in or not — asks to be
emailed when an out-of-stock product variant is available again. This is **AGPL-3.0 reference code**
— meant to be read and forked. It is a worked example of an **email-keyed, anonymous-capable**
module on the sandboxed runtime: it declares the minimum permissions, accepts a subscriber-supplied
email it validates against header-injection at the boundary, stores data in its **own** namespaced
table, and sends email through the gated mail capability.

It mirrors the bundled **Wishlist** module's structure and contracts.

## What's here

```
notify-back-in-stock/
├── sovecom.module.json          # manifest: name, permissions, slot, settings ref, tables
├── settings.schema.json         # JSON Schema for the admin-configurable settings
├── package.json                 # depends on @sovecom/module-sdk; builds to a CJS dist/index.js
├── tsconfig.json                # worker build (CommonJS); excludes tests
├── src/
│   ├── index.ts                 # defineModule({ activate(sdk) }) — migration, serve, subscribe
│   ├── settings.ts              # resolve + clamp the settings bag (pure)
│   ├── db/
│   │   ├── schema.ts            # mod_notify-back-in-stock_* table name + idempotent migration DDL
│   │   └── repository.ts        # parameterized SQL over sdk.tables (email-keyed)
│   ├── api/
│   │   ├── handlers.ts          # subscribe (POST /subscriptions, POST /subscriptions/:variantId) / unsubscribe (DELETE) / slot (GET)
│   │   └── email-validation.ts  # mirrors the email-port's header-injection-safe rule
│   ├── events/subscriptions.ts  # subscribes to product.stock_changed → notifier (see "Restock wiring")
│   ├── notify/notify.ts         # the directly-invokable restock runner (idempotent, batch-capped)
│   └── slot/notify-slot.ts      # the product-detail slot DATA handler (submit-form descriptor)
├── test/                        # unit tests (handlers/runner/settings/subscriptions vs a mocked SDK)
├── README.md
├── .gitignore
└── LICENSE                      # AGPL-3.0
```

## Endpoints

Core mounts these under `/store/v1/modules/notify-back-in-stock/*` and proxies them to the module
worker.

| Method   | Path                        | Body                   | Result                          |
| -------- | --------------------------- | ---------------------- | ------------------------------- |
| `POST`   | `/subscriptions`            | `{ variantId, email }` | `201` subscribed (idempotent)   |
| `DELETE` | `/subscriptions/:variantId` | `{ email }`            | `204` removed / `404` not found |

**Subscribe is GUEST-FRIENDLY — login is NOT required.** The subscriber supplies
their own email; the subscription is therefore **email-keyed**, not customer-keyed. A malformed
`variantId` or `email` returns `400`. A repeat subscribe to the same `(email, variant)` is a no-op
that **resets `notified_at` to NULL**, so a returning shopper who was already notified once is
eligible to be notified again on the **next** restock.

### Email is untrusted input — validated against header injection at the boundary

The email is validated with the **same rule the core email port uses** before it is stored: a
single, syntactically-valid address, **no CR/LF/comma/semicolon** (the header-injection /
multi-recipient guard), bounded to `EMAIL_TO_MAX` (254) chars. The check runs on the **raw** value
before any trimming, so a trailing CR/LF can never be silently trimmed into a "valid" address. The
core email port re-validates the recipient at send time (it is the single source of truth — nothing
here can weaken it); validating early just turns an abusive address into a clean `400` instead of a
stored row that fails later.

**Abuse note (guest subscribe):** because subscribe is anonymous, a shopper could enter **someone
else's** address. This is standard for an email-keyed restock notifier and is deliberately bounded:
the blast radius of a bogus subscription is a single transactional "back in stock" email, the core
mail port **rate-limits and audits** every module send, and the email itself is plain and
unsubscribe-able. A double-opt-in confirmation step is a sensible future enhancement.

### How a logged-in customer is recorded

When `req.customer` is present (the core-verified principal the store proxy set from a customer JWT
it checked itself — the 3.10-i.5 bridge), the module records `customer_id` alongside the row. It is
**never the key** and **never read from the body** — the email remains the identity.

## Permissions (and why each)

Declared in `sovecom.module.json` — the **minimum** the code uses (default-deny; the core broker
enforces them and the SDK cannot widen them):

| Permission         | Why it's needed                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `write:own_tables` | Store subscriptions in `mod_notify-back-in-stock_subscriptions`.                                        |
| `read:products`    | Resolve the product title for the email subject/body via `sdk.store`.                                   |
| `subscribe:events` | Subscribe to `product.stock_changed` to drive the restock notifier (and `product.updated` as a signal). |
| `email:send`       | Send the back-in-stock notification via core's mail service.                                            |

We do **not** request `read:customers` — the field-limited DTO has no email (and the subscription is
email-keyed anyway, so it wouldn't help) — nor `emit:events` or `http:outbound`.

> **Static-scan advisory.** `module-contract-tests` flags `read:products` and `email:send` as
> "never used in source". That is a known limitation of the static scan: both are used through the
> **directly-invokable** `runBackInStockNotifications(input, { store, email, … })` (the caller passes
> `sdk.store` / `sdk.email`), not via a literal `sdk.store.*` / `sdk.email.*` chain in the worker
> entrypoint. Both permissions are genuinely required at runtime — the integration suite exercises
> them — and the broker is the real enforcer. (Wishlist shows the identical `email:send` advisory
> for the same reason.)

## Tables

One table, namespaced `mod_notify-back-in-stock_*` (the hard rule: a module never touches core
tables) and declared in the manifest:

- **`mod_notify-back-in-stock_subscriptions`** —
  `(id, customer_email, product_variant_id, customer_id NULL, created_at, notified_at NULL)`, with
  `UNIQUE(customer_email, product_variant_id)` (idempotent subscribe; `notified_at` is the restock
  idempotency anchor).

> **Identifier quoting.** This module's name (`notify-back-in-stock`) contains hyphens, so the
> derived schema/table identifiers are **not** legal unquoted SQL. The runtime double-quotes the
> schema, and this module double-quotes the table name everywhere (`"mod_notify-back-in-stock_…"`).
> Quoting is injection-proof: the module-name slug forbids `"`/whitespace/backslash by construction.

The migration is `CREATE TABLE IF NOT EXISTS …` run at `activate()`, so it is safe on every worker
start. **Uninstall data deletion** is handled by the core uninstall path (`DELETE …?dropData=true`)
— the module declares its table and core owns the lifecycle.

## Restock wiring

The restock notification is **idempotent**, and its **trigger is now event-driven**:

- Core emits an **observational** `product.stock_changed` event carrying
  `{ eventId, productId, variantId, available }` when a variant's availability **flips across zero**.
  Crucially the payload is a back-in-stock **boolean only** — it **never** exposes the exact stock
  level / quantity (that would leak competitive inventory info to a sandboxed module), which is all
  this notifier needs. Inventory still lives entirely in the transactional path the module cannot
  touch; the module only **observes** the flip after it commits.
- `available` reflects **physical** stock crossing zero (`stock_quantity > 0` OR the variant allows
  backorder) — **not** stock-minus-active-reservations. A variant whose physical units are all held
  by live cart reservations still reports `available: true`; the no-oversell engine (not this signal)
  governs whether a checkout can actually proceed.
- `src/events/subscriptions.ts` subscribes to it (gated by `subscribe:events`) and, on a back-IN-
  stock flip (`available === true`), runs the existing idempotent `runBackInStockNotifications` for
  that variant's subscribers. A depletion flip (`available === false`) is a no-op here. The trigger
  no longer needs an out-of-band scheduler.

`runBackInStockNotifications` (exported from the package) stays directly-invokable too, so a
scheduled backfill / admin job / test can still drive it with a batch of variant ids — the event
path and the direct path share the same idempotent core (find not-yet-notified subscriptions,
**reserve** each via `notified_at` NULL → `now()`, resolve the title, and `sdk.email.send` one
bounded email per subscription within the per-run `batchSize` cap).

`src/events/subscriptions.ts` also still subscribes to `product.updated` as a lightweight
"a product changed" log signal, kept for parity; the stock path is the live one.

**Idempotency.** Each subscription's `notified_at` is the anchor. `markNotified(id)` flips NULL →
`now()` and returns the row only when **this** call did the flip, so a re-run (a retry, a duplicate
trigger) sends nothing further. Marking **before** sending biases toward "no duplicate over no loss".

**One-shot per subscription (intentional v1 behavior).** A subscription is notified **exactly once**:
after its `notified_at` is stamped it is never re-notified, even if the variant goes OOS and restocks
again later. To be notified on a **future** out-of-stock → restock cycle, the shopper **re-subscribes**
(the subscribe endpoint resets `notified_at` to NULL on a same-email+variant re-subscribe). This keeps
a single restock event from re-spamming everyone who ever subscribed, and matches the "tell me when
it's back" mental model — it is a deliberate v1 choice, not a gap.

**Partial-failure tolerance.** Each per-subscription `sdk.email.send` is wrapped in try/catch: one
bad recipient is **counted** (`RunResult.failed`) and the batch **continues** — a single transport
rejection never aborts the run or discards the partial result. A failed sub stays reserved (marked)
and is not retried this run, consistent with "no duplicate over no loss". A reserved sub consumes a
`batchSize` slot whether its send succeeded or threw.

## Title resolution (known limitation)

The back-in-stock email resolves the product title via `sdk.store.products.get(...)`, but that read
is keyed by **product id** while the subscription stores a **variant id**, and the field-limited
`ModuleProductDto` exposes no variant→product mapping. So for most subscribers the lookup **misses**
and the email falls back to a **generic** title ("an item on your wishlist") — it only resolves a
real title when the subscribed id happens to be a product id. We do **not** fabricate a title; the
generic fallback is honest. A faithful title needs a future SDK that resolves a variant id (or
exposes the parent product on the variant). See the comment on `resolveTitle` in `src/notify/notify.ts`.

## Slot UI — data-descriptor widget

The module contributes storefront UI by returning a typed **widget descriptor** `{ type, props }` —
**DATA only, never code/HTML** — from its existing store mount:

```
GET /store/v1/modules/notify-back-in-stock/slot?slot=product-detail-actions&route=<variantId>
```

It maps to the storefront's MIT **`submit-form`** widget — a **guest-friendly email-capture** form (the
module is email-keyed, so this is identical signed-in or anonymous). The handler
([`src/slot/notify-slot.ts`](src/slot/notify-slot.ts)) returns a single-`email`-field form whose
`action.path` targets **this module's OWN** subscribe mount, with the variant id in the PATH (the form
posts only its declared fields): `POST /store/v1/modules/notify-back-in-stock/subscriptions/<variantId>`
(body `{ email }`; the original body-keyed `POST /subscriptions` with `{ variantId, email }` is retained).
An unknown slot / invalid route → **204** (decline). The storefront pins the action path to this module
(own-mount) and validates the descriptor with `parseWidget` — **no module code/HTML ever enters the
storefront bundle**. The old `src/slot/notify-button.tsx` "ships code" path +
`tsconfig.slot.json` are **removed**.

> The "render only when out of stock" gating that the old `.tsx` did locally is now a storefront concern
> (the host decides where/whether to mount the `product-detail-actions` slot); the module simply supplies
> the form descriptor when asked.

## Settings wiring

`settings.schema.json` documents the admin-configurable settings (`enabled`, `batchSize`,
`subjectTemplate`). `resolveSettings()` parses + clamps a settings bag to safe ranges (the per-run
cap can never be disabled or made absurd; the subject template is control-char-stripped and
length-bounded). Until the runtime threads a typed settings object into `activate(sdk)`, the module
resolves safe defaults; swap in the admin-supplied bag at that one call site when the runtime
exposes it.

## Develop

```bash
pnpm install
pnpm --filter @sovecom/module-notify-back-in-stock build      # tsc → dist/index.js (CommonJS)
pnpm --filter @sovecom/module-notify-back-in-stock test       # unit tests (mocked SDK)
pnpm --filter @sovecom/module-notify-back-in-stock contract   # module-contract-tests conformance
```

The built `dist/index.js` is what the SovEcom runtime loads (`SOVECOM_MODULE_MAIN=<dir>/index.js`).

## License

AGPL-3.0. See `LICENSE`. As a network-served module, the AGPL's §13 source-availability obligation
applies — keep your forked source available to its users.
