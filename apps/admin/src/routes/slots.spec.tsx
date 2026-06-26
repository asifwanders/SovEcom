import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SlotsPage from './slots';
import { ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const RESOLVED = [{ slot: 'header.banner', module: 'promo', component: 'PromoBanner' }];
const CONFLICTS = [
  {
    slot: 'footer.cta',
    candidates: [
      { module: 'newsletter', component: 'NewsletterCta' },
      { module: 'social', component: 'SocialLinks' },
    ],
  },
];

const FULL = { resolved: RESOLVED, conflicts: CONFLICTS };
const ALL_RESOLVED = { resolved: RESOLVED, conflicts: [] };
const EMPTY = { resolved: [], conflicts: [] };

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

function setRole(role: string) {
  useAuthStore.setState({
    accessToken: 'tok',
    user: { id: 'u', email: 'a@x', name: 'A', role, totpEnabled: false },
    isAuthenticated: true,
    isLoading: false,
  });
}

describe('SlotsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    setRole('admin');
  });

  it('renders resolved slots (slot → winning module + component)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(FULL as unknown as never);
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('header.banner')).toBeInTheDocument());
    const row = screen.getByText('header.banner').closest('tr')!;
    expect(within(row).getByText('promo')).toBeInTheDocument();
    expect(within(row).getByText('PromoBanner')).toBeInTheDocument();
  });

  it('renders conflicts with each candidate module + a "Use this module" action', async () => {
    vi.mocked(apiFetch).mockResolvedValue(FULL as unknown as never);
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('footer.cta')).toBeInTheDocument());
    expect(screen.getByText('newsletter')).toBeInTheDocument();
    expect(screen.getByText('social')).toBeInTheDocument();
    // One "Use this module" button per candidate.
    expect(screen.getAllByRole('button', { name: /Use this module/i })).toHaveLength(2);
  });

  it('clicking "Use this module" PUTs the resolution with the right slot + module, then refetches', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(FULL as unknown as never) // initial GET
      .mockResolvedValueOnce(undefined as unknown as never) // PUT (204)
      .mockResolvedValueOnce(ALL_RESOLVED as unknown as never); // refetch GET
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('footer.cta')).toBeInTheDocument());

    const newsletterRow = screen.getByText('newsletter').closest('tr')!;
    await userEvent.click(within(newsletterRow).getByRole('button', { name: /Use this module/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/slots/footer.cta/resolution', {
        method: 'PUT',
        body: JSON.stringify({ module: 'newsletter' }),
      }),
    );
    // After the refetch, the conflict is gone (slot moved to Resolved).
    await waitFor(() => expect(screen.queryByText('footer.cta')).not.toBeInTheDocument());
  });

  it('a 404 stale-pick response shows the friendly message and refetches (no crash)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(FULL as unknown as never) // initial GET
      .mockRejectedValueOnce(new ApiError('module not enabled', 404, null)) // PUT 404
      .mockResolvedValueOnce(FULL as unknown as never); // refetch GET
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('footer.cta')).toBeInTheDocument());

    const socialRow = screen.getByText('social').closest('tr')!;
    await userEvent.click(within(socialRow).getByRole('button', { name: /Use this module/i }));

    await waitFor(() => expect(screen.getByText(/no longer a candidate/i)).toBeInTheDocument());
    // Refetch fired (3 calls: GET, PUT, GET).
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBe(3));
    // No raw error text / crash — the page still shows the conflict section.
    expect(screen.getByText('footer.cta')).toBeInTheDocument();
  });

  it('a 422 stale-pick response shows the friendly message and refetches (no crash)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(FULL as unknown as never)
      .mockRejectedValueOnce(new ApiError('does not target slot', 422, null))
      .mockResolvedValueOnce(FULL as unknown as never);
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('footer.cta')).toBeInTheDocument());

    const socialRow = screen.getByText('social').closest('tr')!;
    await userEvent.click(within(socialRow).getByRole('button', { name: /Use this module/i }));

    await waitFor(() => expect(screen.getByText(/no longer a candidate/i)).toBeInTheDocument());
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBe(3));
  });

  it('shows "All slots resolved" when there are zero conflicts', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ALL_RESOLVED as unknown as never);
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('header.banner')).toBeInTheDocument());
    expect(screen.getByText(/All slots resolved/i)).toBeInTheDocument();
  });

  it('shows a sensible empty state when there are zero slots at all', async () => {
    vi.mocked(apiFetch).mockResolvedValue(EMPTY as unknown as never);
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText(/No module slots/i)).toBeInTheDocument());
  });

  it('renders the error UI (no crash) when the initial GET /admin/v1/slots fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError('boom', 500, null));
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() =>
      expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument(),
    );
    // The actionable conflict UI is NOT rendered on a failed load.
    expect(screen.queryByRole('button', { name: /Use this module/i })).not.toBeInTheDocument();
  });

  it('hides the resolve action for staff without themes:write (read-only page)', async () => {
    setRole('staff');
    vi.mocked(apiFetch).mockResolvedValue(FULL as unknown as never);
    render(<SlotsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('footer.cta')).toBeInTheDocument());
    // The conflict is still visible (read-only), but no resolve action is offered.
    expect(screen.queryByRole('button', { name: /Use this module/i })).not.toBeInTheDocument();
  });
});
