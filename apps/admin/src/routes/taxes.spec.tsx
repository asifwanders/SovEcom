import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaxesPage from './taxes';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const SETTINGS = {
  taxMode: 'eu_vat',
  pricesIncludeTax: true,
  ossPosture: 'below_threshold',
  euVatRegistration: { originCountry: 'FR', vatNumber: 'FR123' },
};
const RATES = [{ id: 'tr1', country: 'FR', region: null, rate: '0.2000', name: 'Standard VAT' }];

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

describe('TaxesPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(
      (path: string) =>
        Promise.resolve(path.includes('/settings') ? SETTINGS : RATES) as Promise<unknown>,
    );
    useAuthStore.setState({
      accessToken: 'tok',
      user: { id: 'u', email: 'a@x', name: 'A', role: 'admin', totpEnabled: false },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it('renders the settings (origin from euVatRegistration) and the rate as a percentage', async () => {
    render(<TaxesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expect((screen.getByLabelText('Origin country') as HTMLInputElement).value).toBe('FR');
    expect(screen.getByText('Standard VAT')).toBeInTheDocument();
    expect(screen.getByText('20.00%')).toBeInTheDocument(); // rate "0.2000" → 20.00%
  });

  it('hides settings save + rate create for staff (no settings:write)', async () => {
    useAuthStore.setState({
      user: { id: 'u2', email: 's@x', name: 'S', role: 'staff', totpEnabled: false },
    } as never);
    render(<TaxesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create/ })).not.toBeInTheDocument();
  });
});
