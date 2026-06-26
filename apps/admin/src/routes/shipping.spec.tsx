import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ShippingPage from './shipping';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const ZONES = [{ id: 'z1', name: 'EU', countries: ['FR', 'DE'] }];
const RATES = [
  {
    id: 'r1',
    zoneId: 'z1',
    name: 'Standard',
    type: 'flat',
    amount: 500,
    currency: 'EUR',
    freeOverAmount: null,
    weightMinGrams: null,
    weightMaxGrams: null,
  },
];

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

describe('ShippingPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(
      (path: string) =>
        Promise.resolve(path.includes('/zones') ? ZONES : RATES) as Promise<unknown>,
    );
    useAuthStore.setState({
      accessToken: 'tok',
      user: { id: 'u', email: 'a@x', name: 'A', role: 'admin', totpEnabled: false },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it('renders zones and rates (rate amount in minor units, resolved zone name)', async () => {
    render(<ShippingPage />, { wrapper: wrapper() });
    // 'EU' appears in both the zone row and the rate's resolved-zone column.
    await waitFor(() => expect(screen.getAllByText('EU').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('FR, DE')).toBeInTheDocument();
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('€5.00')).toBeInTheDocument(); // amount 500 minor units
  });
});
