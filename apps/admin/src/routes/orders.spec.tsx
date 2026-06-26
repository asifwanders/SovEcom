import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrdersPage from './orders';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

describe('OrdersPage', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('renders the orders table with formatted totals and a frozen badge', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      data: [
        {
          id: 'o1',
          orderNumber: 'SO-1001',
          email: 'a@b.test',
          status: 'paid',
          currency: 'EUR',
          totalAmount: 2900,
          refundedAmount: 0,
          fulfillmentFrozen: true,
          createdAt: '2026-06-13T00:00:00Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    render(<OrdersPage />, { wrapper: wrapper() });

    await waitFor(() => expect(screen.getByText('SO-1001')).toBeInTheDocument());
    expect(screen.getByText('a@b.test')).toBeInTheDocument();
    expect(screen.getByText('€29.00')).toBeInTheDocument(); // minor-units formatting
    expect(screen.getByLabelText('Fulfillment frozen')).toBeInTheDocument();
  });

  it('shows an empty state when there are no orders', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
    render(<OrdersPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('No orders found.')).toBeInTheDocument());
  });
});
