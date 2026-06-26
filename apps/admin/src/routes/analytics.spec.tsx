import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AnalyticsPage from './analytics';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

/** The body of the most recent PUT to apiFetch (GET refetches also call apiFetch). */
function lastPutBody(): Record<string, unknown> {
  const put = vi
    .mocked(apiFetch)
    .mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')
    .at(-1);
  return JSON.parse((put![1] as RequestInit).body as string);
}

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

const EMPTY = { plausibleDomain: null, ga4Id: null, metaPixelId: null };

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    setRole('admin');
  });

  it('saves the Plausible domain with no RGPD acknowledgement (privacy-friendly)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(EMPTY as unknown as never);
    render(<AnalyticsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByLabelText(/plausible domain/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/plausible domain/i), 'shop.example.com');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/admin/v1/analytics',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    expect(lastPutBody()).toEqual({
      plausibleDomain: 'shop.example.com',
      ga4Id: null,
      metaPixelId: null,
      rgpdAcknowledged: false, // no GA4/Meta being set → no acknowledgement asserted
    });
  });

  it('shows an RGPD warning when GA4 is entered and blocks saving until acknowledged', async () => {
    vi.mocked(apiFetch).mockResolvedValue(EMPTY as unknown as never);
    render(<AnalyticsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByLabelText(/measurement id/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/measurement id/i), 'G-ABC123');
    expect(screen.getByText(/sends visitor data to google/i)).toBeInTheDocument();

    // Save without acknowledging → blocked (no PUT, error shown).
    vi.mocked(apiFetch).mockClear();
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/acknowledge the rgpd warning/i)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();

    // Acknowledge → save goes through.
    await userEvent.click(screen.getByRole('checkbox', { name: /google analytics/i }));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const body = lastPutBody();
    expect(body.ga4Id).toBe('G-ABC123');
    expect(body.rgpdAcknowledged).toBe(true); // client sends the ack the server now requires
  });

  it('clears the acknowledge error as soon as the ack box is ticked', async () => {
    vi.mocked(apiFetch).mockResolvedValue(EMPTY as unknown as never);
    render(<AnalyticsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByLabelText(/measurement id/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/measurement id/i), 'G-ABC123');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/acknowledge the rgpd warning/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: /google analytics/i }));
    expect(screen.queryByText(/acknowledge the rgpd warning/i)).toBeNull();
  });

  it('hides the Save button for a role without settings:write', async () => {
    setRole('staff');
    vi.mocked(apiFetch).mockResolvedValue(EMPTY as unknown as never);
    render(<AnalyticsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByLabelText(/plausible domain/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });
});
