import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DiscountsPage from './discounts';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const ROWS = [
  {
    id: 'd1',
    name: 'Summer',
    code: 'SUMMER',
    type: 'percentage',
    value: 1000,
    currency: null,
    appliesTo: 'all',
    targetIds: null,
    minCartAmount: null,
    stackable: false,
    active: true,
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
function setRole(role: string) {
  useAuthStore.setState({
    accessToken: 'tok',
    user: { id: 'u', email: 'a@x', name: 'A', role, totpEnabled: false },
    isAuthenticated: true,
    isLoading: false,
  });
}

describe('DiscountsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(ROWS as unknown as never);
  });

  it('lists discounts and shows the formatted percentage value (admin can create)', async () => {
    setRole('admin');
    render(<DiscountsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('Summer')).toBeInTheDocument());
    expect(screen.getByText('SUMMER')).toBeInTheDocument();
    expect(screen.getByText('10.00%')).toBeInTheDocument(); // value 1000 → 10.00%
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
  });

  it('hides create/edit for a role without settings:write (staff)', async () => {
    setRole('staff');
    render(<DiscountsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('Summer')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Create/ })).not.toBeInTheDocument();
  });

  it('builds a correct create body (POST /discounts) from the form', async () => {
    setRole('admin');
    const user = userEvent.setup();
    render(<DiscountsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('Summer')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Create/ }));
    await user.type(screen.getByLabelText('Name'), 'Winter');
    await user.type(screen.getByLabelText(/Value/), '1500');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => {
      const call = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (c) =>
            c[0] === '/admin/v1/discounts' && (c[1] as RequestInit | undefined)?.method === 'POST',
        );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        name: 'Winter',
        type: 'percentage',
        value: 1500,
        appliesTo: 'all',
      });
      expect(body.targetIds).toBeNull(); // scope 'all' clears targets
    });
  });
});
