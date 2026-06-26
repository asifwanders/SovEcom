import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { createMockApi } from './test-utils';
import { PROGRESS_KEY, TOKEN_KEY } from './wizard/storage';

/**
 * THE headline test: drive ALL 11 steps end-to-end against a mocked API,
 * asserting each advances, every step hits its endpoint, and the final /complete fires +
 * redirects to /admin. Also covers the already-installed boot screen and a mid-flow
 * refresh resuming from localStorage. Not shallow — it exercises the real components, the
 * real machine, persistence, and the real inline-validation gates.
 */

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

/** A mock API that records every gated POST path so we can assert the full sequence. */
function makeFlowApi() {
  const posted: string[] = [];
  let adminPhase: 'start' | 'verify' = 'start';
  const mock = createMockApi({
    post: () => Promise.resolve({ ok: true }),
  });
  // Wrap post to record the path + drive the two-phase admin flow.
  mock.post.mockImplementation(async (path: string) => {
    posted.push(path);
    if (path === '/setup/v1/admin-account/start') {
      adminPhase = 'verify';
      return { sent: true };
    }
    if (path === '/setup/v1/tax/configure') return { ok: true, vatStatus: 'valid' };
    void adminPhase;
    return { ok: true };
  });
  return { ...mock, posted };
}

const STRONG_PASSWORD = 'correct-horse-battery-staple-92';

describe('Setup wizard — full happy path', () => {
  it('drives all 11 steps → complete → redirect to /admin', async () => {
    const user = userEvent.setup();
    const { api, posted, post, postMultipart, complete } = makeFlowApi();
    render(<App api={api} />);

    // ── Step 1: Welcome — enter + verify the setup token ──────────────────────────
    await screen.findByRole('heading', { name: /welcome to sovecom/i });
    await user.type(screen.getByLabelText(/setup token/i), 'good-token');
    await user.click(screen.getByRole('button', { name: /verify & continue/i }));

    // ── Step 2: Brand — continue with defaults (multipart) ────────────────────────
    await screen.findByRole('heading', { name: /your brand/i });
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(postMultipart).toHaveBeenCalled());

    // ── Step 3: Database — bundled Postgres (default) ─────────────────────────────
    await screen.findByRole('heading', { name: /^database$/i });
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // ── Step 4: Email — Brevo + from address ──────────────────────────────────────
    await screen.findByRole('heading', { name: /email delivery/i });
    await user.type(screen.getByLabelText(/brevo api key/i), 'xkeysib-abc');
    await user.type(screen.getByLabelText(/from address/i), 'store@example.com');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // ── Step 5: Payments — none selected ──────────────────────────────────────────
    await screen.findByRole('heading', { name: /^payments$/i });
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // ── Step 6: Tax — EU country auto-defaults to EU VAT ──────────────────────────
    await screen.findByRole('heading', { name: /^tax$/i });
    await user.selectOptions(screen.getByLabelText(/business country/i), 'FR');
    await user.type(screen.getByLabelText(/eu vat number/i), 'FR12345678901');
    await user.click(screen.getByRole('button', { name: /validate & continue/i }));

    // ── Step 7: Compliance — privacy-first defaults ───────────────────────────────
    await screen.findByRole('heading', { name: /privacy & compliance/i });
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // ── Step 8: Theme — first theme pre-selected ──────────────────────────────────
    await screen.findByRole('heading', { name: /storefront theme/i });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^continue$/i })).not.toBeDisabled(),
    );
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // ── Step 9: Modules — built-in catalog, Skip (optional) ───────────────────────
    await screen.findByRole('heading', { name: /^modules$/i });
    await user.click(screen.getByRole('button', { name: /^skip$/i }));

    // ── Step 10: Admin — request the OTP, then verify ─────────────────────────────
    await screen.findByRole('heading', { name: /your admin account/i });
    await user.type(screen.getByLabelText(/your name/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    // code + password
    await screen.findByLabelText(/verification code/i);
    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm password/i), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    // ── Step 11: Done — finish + redirect ─────────────────────────────────────────
    await screen.findByRole('heading', { name: /you’re all set|you're all set/i });
    // The summary reflects what we collected.
    expect(screen.getByText(/ada@example\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/EU VAT/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /finish setup/i }));
    await waitFor(() => expect(complete).toHaveBeenCalled());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin'));

    // Storage cleared on completion.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();

    // Every step's endpoint was hit, in order.
    expect(posted).toEqual([
      '/setup/v1/database/configure',
      '/setup/v1/smtp/configure',
      '/setup/v1/payments/configure',
      '/setup/v1/tax/configure',
      '/setup/v1/compliance/configure',
      '/setup/v1/themes/activate',
      '/setup/v1/modules/install',
      '/setup/v1/admin-account/start',
      '/setup/v1/admin-account/verify',
    ]);
    // Brand went via multipart, not the JSON post.
    expect(postMultipart).toHaveBeenCalledWith('/setup/v1/brand', expect.anything());
    expect(post).toHaveBeenCalled();
  });

  it('shows the already-installed boot screen and never the wizard', async () => {
    const { api } = createMockApi({ status: { installed: true } });
    render(<App api={api} />);

    // The "already set up → go to admin" screen.
    expect(await screen.findByRole('heading', { name: /already set up/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to admin/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /welcome to sovecom/i })).not.toBeInTheDocument();
  });

  it('resumes mid-flow from localStorage on refresh (remount)', async () => {
    // Seed progress on the Tax step (index 5) with a token, as if a refresh happened.
    localStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({ currentIndex: 5, data: { email: { provider: 'brevo' } } }),
    );
    sessionStorage.setItem(TOKEN_KEY, 'good-token');

    const { api } = createMockApi();
    const { unmount } = render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: /^tax$/i })).toBeInTheDocument();
    // The "step 6 of 11" counter reflects the resumed position.
    expect((await screen.findAllByText(/step 6 of 11/i)).length).toBeGreaterThan(0);

    // Remount (a fresh App, simulating a browser refresh) — still on Tax.
    unmount();
    const { api: api2 } = createMockApi();
    render(<App api={api2} />);
    expect(await screen.findByRole('heading', { name: /^tax$/i })).toBeInTheDocument();
  });
});

// Keep `within` referenced for future per-region assertions without an unused import.
void within;
