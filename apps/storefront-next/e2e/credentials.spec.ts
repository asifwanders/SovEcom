/**
 * Customer credential-flows E2E. The browser-level acceptance gate
 * for the self-service credential surface the C1–C6 chunks shipped — the criteria jsdom/Vitest cannot
 * run: real navigation + a real session across change-password, change-email (initiate → confirm), and
 * the unauth forgot/reset flow, including the credential FLIP (old password stops working, new one
 * works) and the email SWAP (login with the new address) verified end-to-end against the live API.
 *
 * SELF-CONTAINED, per-test throwaway (no shared-state drift): the `account.spec.ts` suite depends on
 * the SHARED `e2e-account` seed customer, so these tests NEVER touch it. Each test REGISTERS its own
 * disposable customer via the API (`registerThrowawayCustomer`) and operates only on that throwaway —
 * idempotent + rerun-safe (unique email per test). The throwaway's `id` keys the per-customer Redis
 * token sink, so each test reads ONLY its own confirm/reset token.
 *
 * TOKEN SINKS: the C5/C3 services mirror the plaintext single-use token to Redis under
 * `NODE_ENV=test` + the sink flags (CI `storefront-e2e` sets both). The sink-dependent tests guard on
 * `skipIfNoSink()` so the suite stays GREEN when pointed at a non-test stack (e.g. the prod VPS domain)
 * — mirroring `account.spec.ts`'s `loginOrSkip` empty-stack posture. The no-token client-validation
 * cases (B's no-token confirm, C's no-token reset + invalid-email) run on EVERY stack.
 *
 * Runs at BOTH viewports (desktop + mobile projects) under `--workers=1` (CI). All flows are EN — the
 * credential UIs are locale-agnostic and `account.spec.ts` already covers the FR section nav.
 */
import { test, expect } from '@playwright/test';
import { localePath, loginAsCustomer, loginExpectingFailure } from './helpers';
import {
  apiBaseUrl,
  registerThrowawayCustomer,
  readResetTokenSink,
  readEmailChangeTokenSink,
  skipIfNoSink,
  THROWAWAY_PASSWORD,
} from './credentials-helpers';

/** A strong new password that passes min-12 + the breached denylist (used by the change-password flip). */
const NEW_PASSWORD = 'E2e-NewPass-2026!x';
/** A strong new password for the reset flip (distinct from NEW_PASSWORD for clarity). */
const RESET_PASSWORD = 'E2e-ResetPass-2026!x';

/** Sign out from the account nav (button → logout() → router.replace('/')); wait until off the account area. */
async function signOut(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL((url) => !url.pathname.includes('/account'), { timeout: 15_000 });
}

test.describe('customer credential flows', () => {
  // ── A. Change password (authed) — success banner + session survival + credential flip ──────────────
  test('A — change password: success, session survives, old fails + new works', async ({
    page,
    request,
  }) => {
    skipIfNoSink();
    const c = await registerThrowawayCustomer(request, { emailPrefix: 'e2e-cred-pw' });

    await loginAsCustomer(page, c.email, c.password);
    await page.goto(localePath('en', 'account/security'));

    const section = page.getByTestId('change-password');
    await expect(section).toBeVisible();
    await section.getByLabel(/current password/i).fill(c.password);
    await section.getByLabel(/^new password$/i).fill(NEW_PASSWORD);
    await section.getByLabel(/confirm new password/i).fill(NEW_PASSWORD);
    await section.getByRole('button', { name: /change password/i }).click();

    // Success banner.
    await expect(page.getByTestId('change-password-success')).toBeVisible();

    // Session SURVIVES the "log out everywhere" (the endpoint returned a fresh token swapped in-place):
    // a reload of a gated route stays authed — no redirect back to /login.
    await page.reload();
    await expect(page.getByTestId('change-password')).toBeVisible();
    expect(page.url()).toContain('/account/security');

    // Credential FLIP: sign out, then the OLD password fails and the NEW password works.
    await signOut(page);
    await loginExpectingFailure(page, c.email, c.password);
    await loginAsCustomer(page, c.email, NEW_PASSWORD);
    // Landed authenticated: the account dashboard greeting renders.
    await page.goto(localePath('en', 'account'));
    await expect(
      page.getByRole('heading', { level: 1, name: /welcome back|my account/i }),
    ).toBeVisible();
  });

  // ── B. Change email (authed, verify-before-switch) — initiate → confirm → swap ─────────────────────
  test('B — change email: initiate pending, confirm via sink token, login with new email', async ({
    page,
    request,
  }) => {
    skipIfNoSink();
    const c = await registerThrowawayCustomer(request, { emailPrefix: 'e2e-cred-em' });
    const newEmail = `e2e-cred-em-new-${Date.now().toString(36)}@test.local`;

    await loginAsCustomer(page, c.email, c.password);
    await page.goto(localePath('en', 'account/security'));

    const section = page.getByTestId('change-email');
    await expect(section).toBeVisible();
    await section.getByLabel(/new email address/i).fill(newEmail);
    await section.getByLabel(/current password/i).fill(c.password);
    await section.getByRole('button', { name: /send verification link/i }).click();

    // Uniform 202 "check your new inbox" success + the pending banner reflects the in-flight change.
    await expect(section.getByTestId('change-email-success')).toBeVisible();
    await expect(section.getByTestId('change-email-success')).toContainText(newEmail);

    // Read the email-change token from the per-customer sink and confirm via the ungated route.
    const token = await readEmailChangeTokenSink(c.id);
    expect(token, 'email-change token should be mirrored to the sink').toBeTruthy();
    await page.goto(
      localePath('en', `account/email-confirm?token=${encodeURIComponent(token as string)}`),
    );
    const confirm = page.getByTestId('email-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/your email address has been updated/i);

    // The swap took: sign out, then login with the NEW email + the same password succeeds — which only
    // happens if `customers.email` was actually swapped (the login lookup is by email). The login itself
    // is the swap proof; we then assert the authed dashboard renders. The OLD email no longer logs in.
    //
    // The email-confirm route is UNGATED (not under the `(account)` group), so it has no AccountNav /
    // sign-out button. Confirm does NOT revoke the session (no token_version bump — the original cookie
    // still re-mints the token on this full-document load), so the customer is still authed: navigate to
    // a GATED account page (which renders the nav) before signing out.
    await page.goto(localePath('en', 'account'));
    await signOut(page);

    // The OLD email is now dead; the NEW email + same password logs in and lands on the dashboard.
    await loginExpectingFailure(page, c.email, c.password);
    await loginAsCustomer(page, newEmail, c.password);
    await page.goto(localePath('en', 'account'));
    await expect(
      page.getByRole('heading', { level: 1, name: /welcome back|my account/i }),
    ).toBeVisible();
  });

  // ── B'. Email-confirm with NO token → invalid/expired state (no sink needed; runs on every stack) ──
  test("B' — email-confirm with no token shows the invalid/expired state", async ({ page }) => {
    // A missing/empty token must short-circuit to the invalid/expired state WITHOUT calling the API
    // (no wasted round-trip, no oracle). Fail the test if the confirm endpoint is ever hit — mirroring
    // C''s no-API-call rigor for the forgot path.
    let confirmCalled = false;
    await page.route(`${apiBaseUrl()}/store/v1/customers/me/email/confirm`, (route) => {
      confirmCalled = true;
      return route.abort();
    });

    await page.goto(localePath('en', 'account/email-confirm'));
    const confirm = page.getByTestId('email-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/this link is invalid or has expired/i);
    expect(
      confirmCalled,
      'no /me/email/confirm API call should be made when the token is absent',
    ).toBe(false);
  });

  // ── C. Forgot / reset (unauth) — uniform banner → reset via sink token → credential flip ───────────
  test('C — forgot then reset via sink token: success, old fails + new works', async ({
    page,
    request,
  }) => {
    skipIfNoSink();
    const c = await registerThrowawayCustomer(request, { emailPrefix: 'e2e-cred-fp' });

    // FORGOT: the uniform, enumeration-safe banner (shown regardless of existence).
    await page.goto(localePath('en', 'forgot'));
    await page.getByLabel(/email address/i).fill(c.email);
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByTestId('forgot-password-success')).toBeVisible();

    // RESET: read the reset token from the per-customer sink, set a new password twice, submit.
    const token = await readResetTokenSink(c.id);
    expect(token, 'reset token should be mirrored to the sink').toBeTruthy();
    await page.goto(localePath('en', `reset?token=${encodeURIComponent(token as string)}`));
    const resetForm = page.getByTestId('reset-password');
    await expect(resetForm).toBeVisible();
    await resetForm.getByLabel(/^new password$/i).fill(RESET_PASSWORD);
    await resetForm.getByLabel(/confirm new password/i).fill(RESET_PASSWORD);
    await resetForm.getByRole('button', { name: /reset password/i }).click();
    await expect(page.getByTestId('reset-password-success')).toBeVisible();

    // Credential FLIP: the NEW password logs in, the OLD (registration) password fails.
    await loginExpectingFailure(page, c.email, THROWAWAY_PASSWORD);
    await loginAsCustomer(page, c.email, RESET_PASSWORD);
    await page.goto(localePath('en', 'account'));
    await expect(
      page.getByRole('heading', { level: 1, name: /welcome back|my account/i }),
    ).toBeVisible();
  });

  // ── C'. Reset with NO token → invalidLink; forgot invalid email → inline client error (no API) ─────
  test("C' — reset with no token is invalidLink; forgot invalid email is an inline client error", async ({
    page,
  }) => {
    // Reset with no token: the form short-circuits to the invalid-link state WITHOUT any API call.
    await page.goto(localePath('en', 'reset'));
    const resetForm = page.getByTestId('reset-password');
    await expect(resetForm).toBeVisible();
    await expect(resetForm).toContainText(/this link is invalid or has expired/i);

    // Forgot with a malformed email: client-side validation fires inline BEFORE any network round-trip.
    // Fail the test if a /forgot request is ever issued for an invalid email (proves client-side gating).
    let forgotCalled = false;
    await page.route(`${apiBaseUrl()}/store/v1/customers/forgot`, (route) => {
      forgotCalled = true;
      return route.abort();
    });
    await page.goto(localePath('en', 'forgot'));
    await page.getByLabel(/email address/i).fill('not-an-email');
    await page.getByRole('button', { name: /send reset link/i }).click();
    // The inline field error renders and no success banner appears.
    await expect(page.getByText(/enter a valid email address/i)).toBeVisible();
    await expect(page.getByTestId('forgot-password-success')).toHaveCount(0);
    expect(forgotCalled, 'no /forgot API call should be made for a malformed email').toBe(false);
  });
});
