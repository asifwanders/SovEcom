/**
 * EmailConfirmClient tests. AUTH/CREDENTIAL-CRITICAL.
 *
 * Drives the PUBLIC `POST /store/v1/customers/me/email/confirm` (no Bearer) via a mocked
 * createBrowserClient. The token comes from `useSearchParams()`. Mirrors the CheckoutSuccess harness
 * (mock next/navigation + @/i18n/navigation + @/lib/browser-client).
 *
 * Proven here:
 *   - token present → 200 → success state;
 *   - 400 → expired/invalid state;
 *   - 409 → taken state;
 *   - other (e.g. 429) → generic error state;
 *   - missing/empty token → expired state WITHOUT calling the API (no wasted round-trip, no oracle);
 *   - the raw token is never rendered to the DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// ── search-params ────────────────────────────────────────────────────────────────────────────────
let searchParams = new URLSearchParams('token=tok-abc');
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ── browser-client ───────────────────────────────────────────────────────────────────────────────
const request = vi.fn();
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({ request }),
}));

import { EmailConfirmClient } from './EmailConfirmClient';

function statusErr(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  request.mockReset();
  searchParams = new URLSearchParams('token=tok-abc');
});

describe('EmailConfirmClient', () => {
  it('token present → 200 → success state, calls confirm with the token', async () => {
    request.mockResolvedValue(undefined);
    await act(async () => {
      renderWithIntl(<EmailConfirmClient />, 'en');
    });

    await waitFor(() =>
      expect(screen.getByText(/your email address has been updated/i)).toBeInTheDocument(),
    );
    expect(request).toHaveBeenCalledWith('post', '/store/v1/customers/me/email/confirm', {
      body: { token: 'tok-abc' },
    });
    // the raw token must never be rendered
    expect(screen.queryByText(/tok-abc/)).not.toBeInTheDocument();
  });

  it('400 → expired/invalid state', async () => {
    request.mockRejectedValue(statusErr(400));
    await act(async () => {
      renderWithIntl(<EmailConfirmClient />, 'en');
    });

    await waitFor(() =>
      expect(screen.getByText(/link is invalid or has expired/i)).toBeInTheDocument(),
    );
  });

  it('409 → taken state', async () => {
    request.mockRejectedValue(statusErr(409));
    await act(async () => {
      renderWithIntl(<EmailConfirmClient />, 'en');
    });

    await waitFor(() => expect(screen.getByText(/already in use/i)).toBeInTheDocument());
  });

  it('other (429) → generic error state', async () => {
    request.mockRejectedValue(statusErr(429));
    await act(async () => {
      renderWithIntl(<EmailConfirmClient />, 'en');
    });

    await waitFor(() => expect(screen.getByText(/could not confirm/i)).toBeInTheDocument());
  });

  it('missing token → expired state WITHOUT calling the API', async () => {
    searchParams = new URLSearchParams('');
    await act(async () => {
      renderWithIntl(<EmailConfirmClient />, 'en');
    });

    await waitFor(() =>
      expect(screen.getByText(/link is invalid or has expired/i)).toBeInTheDocument(),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('empty token param → expired state WITHOUT calling the API', async () => {
    searchParams = new URLSearchParams('token=');
    await act(async () => {
      renderWithIntl(<EmailConfirmClient />, 'en');
    });

    await waitFor(() =>
      expect(screen.getByText(/link is invalid or has expired/i)).toBeInTheDocument(),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('renders the FR success copy', async () => {
    request.mockResolvedValue(undefined);
    await act(async () => {
      renderWithIntl(<EmailConfirmClient />, 'fr');
    });

    await waitFor(() =>
      expect(screen.getByText(/votre adresse e-mail a été mise à jour/i)).toBeInTheDocument(),
    );
  });
});
