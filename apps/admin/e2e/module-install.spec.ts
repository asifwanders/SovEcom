/**
 * "Module: admin installs a module, customer uses it on the storefront", ADMIN HALF.
 * Drives the REAL admin SPA: install the bundled `reviews` module from its `.tgz` through the Modules
 * page upload dialog, enable it, see it reflected as Enabled, then confirm the Slots page shows the
 * resulting slot binding (`product-detail-reviews-section` → reviews → review-list). The storefront
 * half (`apps/storefront-next/e2e/module-render.spec.ts`) then asserts the widget actually renders on
 * the PDP. Install persists in the DB, so the two specs share state — THIS spec must install before
 * the storefront spec asserts (documented ordering dependency).
 *
 * IDEMPOTENT + re-runnable: a re-install of an already-installed module is a 409 the UI surfaces and we
 * tolerate (the module is present either way); enable is a no-op when already enabled. So a second run
 * needs no reseed — it converges on the same installed+enabled end-state.
 *
 * ⚠️ SCENARIO 16 IS COMBINED-STACK COVERAGE (READ BEFORE ASSUMING A FAILURE). This admin spec and the
 * storefront `module-render.spec.ts` are TWO HALVES of ONE scenario that share ONE database + API: this
 * spec installs+enables `reviews`, the storefront spec asserts the resulting render against the SAME
 * stack. They are designed for the ORCHESTRATED local E2E stack (one shared API/DB), where this spec runs
 * FIRST. In the CURRENT split CI topology they DO NOT fully run together: the `admin-e2e` and
 * `storefront-e2e` jobs spin up SEPARATE fresh Postgres instances, so a module installed in admin-e2e is
 * invisible to storefront-e2e (→ `module-render.spec.ts` skips in CI). The `admin-e2e` job DOES exercise
 * the install here — it now sets a writable `MODULES_DATA_PATH` (`/tmp/sovecom-admin-e2e-modules`, real
 * dir on the Linux runner — not symlinked) and packs the bundled `.tgz` (`pnpm pack:bundled-modules`) so
 * the upload has a tarball. Full cross-app coverage needs a single combined job (one DB, admin install
 * then storefront render) — deliberately NOT added yet (the storefront descriptor-serve half can't be
 * validated locally on macOS; see below + module-render.spec.ts). This skip is HONEST, not a silent gap.
 *
 * HONEST SKIP (mirrors the storefront fixtures' empty-catalog / unprovisioned posture): if the running
 * API cannot install a module at all — the `MODULES_DATA_PATH` blocker (defaults to `/data`, which is
 * read-only on most hosts; `probeReviewsInstallable` reports the exact reason) — this whole file
 * `test.skip`s with that diagnostic rather than failing. It activates fully when the API has a writable
 * `MODULES_DATA_PATH`.
 *
 * MODULE CHOICE: `reviews` is the only bundled module whose storefront widget (`review-list`) renders
 * without customer/guest-identity-into-island wiring — it is read-only + anonymous
 * (`personalized:false`). The personalized widgets (wishlist/recently-viewed/notify) need that
 * identity to populate, so they're out of scope here. See module-helpers.ts for the full rationale.
 *
 * Login/navigation harness reused from admin.spec.ts: one login per FILE (rate-limited), serial on a
 * shared page, sidebar (client-side) navigation only — the in-memory token doesn't survive a reload.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, navTo } from './helpers';
import {
  REVIEWS_MODULE,
  REVIEWS_SLOT,
  REVIEWS_WIDGET,
  REVIEWS_TGZ_PATH,
  probeReviewsInstallable,
} from './module-helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;
// Resolved in beforeAll: whether the stack can install a module (else every test below skips).
let provision: { ready: boolean; reason: string } = { ready: false, reason: 'not probed' };

test.beforeAll(async ({ browser }) => {
  // Probe FIRST (cheap admin-API round-trip): can this stack install at all? READINESS-ONLY — it does
  // NOT install (it inspects the tarball, the verify+extract path WITHOUT persist), so the UI test below
  // performs the REAL upload-and-install when reviews isn't already present (the scenario's acceptance
  // gate). If the install path is blocked (the MODULES_DATA_PATH issue), every test here skips.
  provision = await probeReviewsInstallable();
  // Only stand up the page + log in when the stack can actually exercise the flow. If provisioning is
  // unavailable (the documented MODULES_DATA_PATH blocker — or a stack whose admin CORS preflight isn't
  // configured for the :4173 origin, which would itself break the SPA login), every test below skips,
  // so we MUST NOT log in here — a failing login in beforeAll would error the file instead of skipping.
  // This mirrors the storefront fixtures' posture: never FAIL on an unprovisioned/misconfigured stack.
  if (!provision.ready) return;
  page = await browser.newPage();
  await login(page);
});

test.afterAll(async () => {
  await page?.close();
});

test('admin installs the reviews module via the Modules page upload dialog', async () => {
  test.skip(!provision.ready, `module install unavailable on this stack: ${provision.reason}`);

  await navTo(page, 'Modules', /\/modules$/);

  // Wait for the modules list to FINISH loading before deciding whether to install — the query is async,
  // so the table (or the empty-state card) isn't in the DOM the instant we navigate. We settle on one of
  // the two terminal states: the reviews row present, OR the empty-state card. (Checking `row.count()`
  // immediately races the fetch and would wrongly enter the install branch on an already-installed module.)
  const row = page.getByRole('row', { name: new RegExp(REVIEWS_MODULE, 'i') });
  await expect
    .poll(
      async () => (await row.count()) > 0 || (await page.getByText(/no modules/i).count()) > 0,
      {
        timeout: 10_000,
      },
    )
    .toBe(true);

  if ((await row.count()) === 0) {
    // Not installed yet → drive the real upload dialog. BOTH the page header button AND the dialog's
    // submit button read "Install module" (same i18n `modules.install` label) — but only the HEADER one
    // exists until the dialog opens, so `.first()` before opening unambiguously targets it; the dialog
    // submit is then scoped to the dialog.
    const dialog = page.getByRole('dialog');
    await page
      .getByRole('button', { name: /^Install module$/i })
      .first()
      .click();
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="file"]#module-file').setInputFiles(REVIEWS_TGZ_PATH);
    await dialog.getByRole('button', { name: /^Install module$/i }).click();
    // On success the dialog closes. On a 409 (a concurrent/prior install raced us — idempotent re-run)
    // it stays open showing a "Conflict" alert: the module is installed either way, so cancel out and
    // proceed to the presence assertion below.
    const conflict = dialog.getByText(/conflict|already installed/i);
    await Promise.race([
      expect(dialog).toBeHidden({ timeout: 15_000 }),
      expect(conflict).toBeVisible({ timeout: 15_000 }),
    ]);
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: /^Cancel$/i }).click();
      await expect(dialog).toBeHidden();
    }
  }

  // The reviews row is now present in the installed-modules table (installed via the UI just now, or
  // already-installed on an idempotent re-run).
  await expect(page.getByRole('cell', { name: REVIEWS_MODULE, exact: true })).toBeVisible();
});

test('admin enables the reviews module and sees it reflected as Enabled', async () => {
  test.skip(!provision.ready, `module install unavailable on this stack: ${provision.reason}`);

  await navTo(page, 'Modules', /\/modules$/);

  const row = page.getByRole('row', { name: new RegExp(REVIEWS_MODULE, 'i') });
  await expect(row).toBeVisible();

  // If it shows an Enable action, click it (a fresh install lands disabled); if it already reads
  // Enabled (idempotent re-run), this is a no-op.
  const enableBtn = row.getByRole('button', { name: /^Enable$/ });
  if (await enableBtn.isVisible().catch(() => false)) {
    await enableBtn.click();
  }

  // End-state assertion: the row's status badge reads "Enabled".
  await expect(row.getByText('Enabled', { exact: true })).toBeVisible({ timeout: 10_000 });
});

test('the reviews slot binding appears on the Slots page (resolved, no conflict)', async () => {
  test.skip(!provision.ready, `module install unavailable on this stack: ${provision.reason}`);

  await navTo(page, 'Slots', /\/slots$/);

  // reviews is the sole module targeting product-detail-reviews-section, so it resolves CLEANLY (no
  // conflict, no admin pick needed) — it lands in the Resolved table. Assert the full binding row:
  // slot → module → component.
  const resolvedRow = page.getByRole('row', { name: new RegExp(REVIEWS_SLOT) });
  await expect(resolvedRow).toBeVisible({ timeout: 10_000 });
  await expect(resolvedRow.getByText(REVIEWS_MODULE, { exact: true })).toBeVisible();
  await expect(resolvedRow.getByText(REVIEWS_WIDGET, { exact: true })).toBeVisible();
});
