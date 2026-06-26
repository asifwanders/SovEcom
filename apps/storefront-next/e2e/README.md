# Storefront E2E

Browser-level acceptance harness for the storefront — the gate for criteria jsdom/Vitest cannot
run: real **a11y** (axe), real **JSON-LD** parsing from the rendered DOM, the mobile+desktop
**smoke** flow, and (in CI) a **Lighthouse** score check (PageSpeed ≥ 90).

## Running locally

The suite needs **two** processes: the API (the storefront's data source) and the storefront itself.

1. Start + seed the API against a local Postgres/Redis/Meilisearch (see `docker-compose.dev`):
   ```sh
   pnpm --filter @sovecom/api migrate:up
   pnpm --filter @sovecom/api seed
   API_PORT=3000 pnpm --filter @sovecom/api start
   ```
2. Run the E2E suite. Playwright's `webServer` builds + starts the storefront for you
   (`pnpm build && pnpm start`, :3001) when `E2E_SKIP_WEBSERVER` is unset:
   ```sh
   NEXT_PUBLIC_API_BASE_URL=http://localhost:3000 \
   NEXT_PUBLIC_SITE_URL=http://localhost:3001 \
   pnpm --filter @sovecom/storefront-next test:e2e
   ```
   (First run: `pnpm --filter @sovecom/storefront-next exec playwright install --with-deps chromium`.)

In CI the `storefront-e2e` job starts the storefront itself and sets `E2E_SKIP_WEBSERVER=1`, so
Playwright reuses the running server.

## What the seed produces — and what that means for the specs

The API install seed (`apps/api/src/database/seed.ts`) creates:

- the default tenant + an admin-user shell + `system_state`,
- EU-27 standard VAT rates + a default FR shipping zone/rate,
- **12 published legal `pages`** — `privacy`, `terms`, `cookies`, `legal-notice`, `withdrawal`,
  each in **`en` + `fr`** (`seedDefaultPages`).

By default it creates **no products and no categories**, so:

- **Always-present, asserted unconditionally:** home chrome, the products/category index + search
  (empty-but-valid states), the 5 legal pages × 2 locales (real content), `/robots.txt`,
  `/sitemap.xml`, and the site-wide `Organization` + `WebSite` JSON-LD (emitted by the layout).
- **Catalog-dependent, guarded:** a per-product **PDP** and a category **PLP** have no seeded fixture
  to load. The `Product`/`Offer`/`BreadcrumbList` JSON-LD spec discovers a product slug from
  `/sitemap.xml` and `test.skip`s when the catalog is empty — so it validates fully the moment a
  product exists, but never fails on the empty CI seed. Per-product/PLP a11y is covered by the
  in-house component Vitest+axe specs (Chunks B–E).

## The E2E catalog fixture (`SEED_E2E_FIXTURE=1`)

The transactional cart/checkout specs (`cart-checkout.spec.ts`, `cart-checkout-a11y.spec.ts`) need a
DETERMINISTIC product to navigate. Setting **`SEED_E2E_FIXTURE=1`** when running the API seed adds an
idempotent fixture (`apps/api/src/database/seeds/e2e/seed-e2e-fixture.ts`):

- a published product `slug='e2e-tee'` ("E2E Test Tee"),
- an **in-stock** variant (`E2E-TEE-M`, Size M, €19.99, stock 50) — the happy-path add-to-cart target,
- a **sold-out** variant (`E2E-TEE-OOS`, Size XL, stock 0, no backorder) — the out-of-stock path.

The seeded FR Colissimo shipping rate + EU VAT complete the checkout. The fixture is OFF for a real
install and harmless to the catalog-resilient specs (they assert only always-present chrome). The
cart/checkout specs are themselves **fixture-guarded** (`hasFixture()` → `test.skip` on an empty
catalog), so a local run that forgets the flag skips them cleanly rather than failing.

The CI `storefront-e2e` job sets `SEED_E2E_FIXTURE=1` (and `STORE_ORIGIN=http://localhost:3001` so the
credentialed cross-origin cart calls aren't CORS-blocked). To run the transactional specs locally:

```sh
SEED_E2E_FIXTURE=1 pnpm --filter @sovecom/api seed
STORE_ORIGIN=http://localhost:3001 API_PORT=3000 pnpm --filter @sovecom/api start
```

## The discount fixture (`cart-checkout-discount.spec.ts`)

The discount spec needs a deterministic, total-reducing promo code. Rather than baking it into the API
seed (which would force a reseed/restart of an already-running E2E stack), the spec **provisions it via
the admin API in its own `beforeAll`** (`ensureCartDiscount` in `fixtures.ts`): admin-login → create the
`E2E-CART-10PCT` 10%-off (`appliesTo: 'all'`) discount if absent, idempotent (a 409 on a re-run is
success). It hits the API at `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:3000`) with the seed's
admin creds (`admin@default.local` / `E2e-Admin-2026`). The spec is **double-guarded** — it `test.skip`s
if the catalog fixture is absent OR the discount can't be provisioned — so it never fails on an
unprovisioned env, exactly like the other catalog-fixture-guarded specs.

## Stripe payment in CI (no live secret)

The payment step needs the storefront's `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (a `pk_test_*` — NOT a
secret) to render past its config-error state; CI sets a clearly-fake test placeholder. The **API**,
however, needs a Stripe SECRET key to mint a real PaymentIntent `clientSecret`, which CI does NOT have.
So the **default run asserts the flow REACHES the payment step** (review → proceed → the payment step
mounts/attempts the intent) — it does NOT require a live PaymentIntent. The actual `<PaymentElement>`
mount + confirm is gated behind **`E2E_STRIPE_LIVE=1`** (a runner that wired a `sk_test_*` into the
API); without it the live test `test.skip`s with an explicit, logged reason (no silent cap).

If a future release seeds a demo catalog (or an API seed seam is added), the guarded PDP assertions
activate automatically with no change here.

## Lighthouse

The CI job runs `@lhci/cli autorun` against the started storefront for the home + category index +
search routes. It is a **soft/non-blocking** check (`assertions` warn, the step is `continue-on-error`)
— Lighthouse scores are environment-sensitive (runner CPU contention makes the ≥90 bar flaky as a
hard gate). The scores are reported in the job log + uploaded as an artifact so regressions are
visible; promoting it to a hard gate is a follow-up once the CI runner's variance is characterised.
`/search` is `noindex` by design, so its SEO category score is expected to reflect that.

## Cross-theme matrix

The storefront ships two bundled themes (`default`, `boutique`). The suite runs per theme, selected by
the **server-runtime** `STOREFRONT_THEME` env (read in `resolveActiveThemeName`, RSC-only — **no
rebuild** to switch themes). Which specs run on which theme:

- **Both themes** (`THEME=default` and `THEME=boutique`): `smoke`, `a11y`, `json-ld`, `theme`, `visual`.
  These target always-present chrome / static routes and pass on either theme. `theme.spec.ts` asserts
  the theme-DISTINGUISHING markers (boutique → `page-link` cart `<a>` + serif `--font-heading`;
  default → drawer cart `<button>` + non-serif heading), so it confirms the boutique chrome actually
  takes effect.
- **Default theme ONLY**: `cart-checkout` + `cart-checkout-a11y` (the transactional money path). They
  drive the **drawer** cart affordance (`openCartDrawer` / `gotoCartPageViaDrawer`); the boutique theme
  uses the `page-link` cart (a plain link to `/cart`, no drawer), so both self-`test.skip` on
  `THEME=boutique`. **Follow-up:** make the cart flow affordance-agnostic so it runs on boutique too.

So a `THEME=boutique` run exercises the theme-agnostic specs + the boutique markers and cleanly skips the
drawer-only transactional specs — the matrix passes as documented on both themes.

### Wire-delivered theme templates (CI/deploy-only)

`GET /store/v1/theme` returns an optional `templates?: Record<PageType, ThemeTemplate>` for an
active **installed** theme; the storefront consumes them: a wire template for a page wins over the
bundled set (still defensively re-validated at render — `fetchActiveTheme` drops invalid/page-mismatched
ones, and `renderSections`/`CartPageView` re-validate + fall back to bundled). The two bundled themes
(`default`, `boutique`) carry NO wire templates — they resolve from the bundled sets — so the existing
cross-theme matrix above does NOT exercise this path.

A real wire-delivered-theme E2E needs an **installed fixture theme via the API** (a theme whose
manifest declares `templates[]`, installed + activated so the endpoint returns a non-empty `templates`
map). That requires booting BOTH the app and the API with an install seed, so it is **CI/deploy-only**
and is NOT scaffolded as a runnable local spec here (no app+API boot locally). When that fixture lands
(mirroring `SEED_E2E_FIXTURE`), add a spec that:

1. boots the API with the fixture theme installed + active (a distinguishing section/marker on, say, the
   `home` template that neither bundled theme renders);
2. loads `/` and asserts that distinguishing marker is present — proving the wire `home` template (not
   the bundled `default`) drove the render;
3. (defense-in-depth) optionally installs a fixture whose wire template names a section type this
   storefront build lacks and asserts the page still renders (the unknown section is skipped, no 500).

Until that API seam exists, the defensive consume path is fully covered by the Vitest specs
(`src/lib/theme.spec.ts` — drop/keep/parity; `src/lib/sections/renderSections.spec.tsx` — override /
parity / invalid-fallback / unknown-section-skip; `src/components/cart/CartPageView.spec.tsx` — wire
cart override + empty-state).

Locally, one theme per run (Playwright's `webServer` passes the theme through as `STOREFRONT_THEME`):

```sh
pnpm --filter @sovecom/storefront-next test:e2e:default    # THEME=default
pnpm --filter @sovecom/storefront-next test:e2e:boutique   # THEME=boutique
```

In CI run them as a matrix: start the storefront once per theme with `STOREFRONT_THEME=<theme>` +
`E2E_SKIP_WEBSERVER=1`, and pass `THEME=<theme>` to `playwright test` so the specs branch + the
projects/snapshots are theme-scoped (`desktop-chromium-boutique`, etc.).

## Visual regression

`visual.spec.ts` pixel-diffs home / products-PLP / category / cart-shell (+ the fixture PDP) against
committed baselines, **per theme × per viewport** (the two projects). The threshold + animation freeze
live in `playwright.config.ts` (`expect.toHaveScreenshot`: `maxDiffPixelRatio: 0.02`,
`animations: 'disabled'`).

Baselines are **generated on the first run** (they can't be produced without booting the app, so they
are NOT in the repo yet). Generate + commit them per theme:

```sh
pnpm --filter @sovecom/storefront-next test:e2e:update-snapshots            # THEME=default
pnpm --filter @sovecom/storefront-next test:e2e:update-snapshots:boutique   # THEME=boutique
```

This writes `e2e/visual.spec.ts-snapshots/` (one PNG per theme × viewport × page). Because rendering is
runner-dependent, generate the COMMITTED baselines on the **same CI image** that runs the gate (run the
update step once on CI, commit the artifacts), then subsequent CI runs diff against them.

## PageSpeed gate

Two Lighthouse-CI configs, run against a started/deployed storefront (NOT in unit CI):

- `lighthouserc.json` — **default** theme, performance ≥ **0.90**: `pnpm --filter … lhci`
- `lighthouserc.boutique.json` — **boutique** theme, performance ≥ **0.85** (its editorial hero + serif
  webfont justify a slightly lower floor): start the storefront with `STOREFRONT_THEME=boutique`, then
  `pnpm --filter … lhci:boutique`

a11y / best-practices / SEO stay at ≥ 0.90 for both. Both remain **soft** (warn + continue-on-error) for
the runner-variance reason above. Against the live domain, point the configs' `collect.url` at it (or
pass `--collect.url=`), or run `npx lighthouse <url> --form-factor=mobile`.
