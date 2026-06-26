import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrderDetailPage from './order-detail';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const ORDER = {
  order: {
    id: 'o1',
    orderNumber: 'SO-1001',
    email: 'a@b.test',
    status: 'paid',
    currency: 'EUR',
    subtotalAmount: 2000,
    discountAmount: 0,
    shippingAmount: 500,
    taxAmount: 400,
    totalAmount: 2900,
    refundedAmount: 0,
    fulfillmentFrozen: true,
    shippingAddress: {
      name: 'Alice',
      line1: '1 rue',
      city: 'Paris',
      postalCode: '75001',
      country: 'FR',
    },
    billingAddress: null,
    createdAt: '2026-06-13T00:00:00Z',
  },
  items: [
    {
      id: 'i1',
      productTitle: 'Widget',
      sku: 'W1',
      quantity: 2,
      unitPriceAmount: 1000,
      lineTotalAmount: 2000,
      refundedQuantity: 0,
    },
  ],
  history: [
    {
      id: 'h1',
      fromStatus: 'pending_payment',
      toStatus: 'paid',
      note: null,
      createdAt: '2026-06-13T00:00:00Z',
    },
  ],
};
const DISPUTE = {
  data: [
    {
      id: 'd1',
      status: 'open',
      reason: 'fraudulent',
      amount: 2900,
      currency: 'EUR',
      providerStatus: 'needs_response',
      evidenceDueBy: '2026-06-20T00:00:00Z',
    },
  ],
};

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/orders/o1']}>
        <Routes>
          <Route path="/orders/:id" element={<OrderDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OrderDetailPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(
      (path: string) =>
        Promise.resolve(path.includes('/disputes') ? DISPUTE : ORDER) as Promise<unknown>,
    );
    useAuthStore.setState({
      accessToken: 'tok',
      user: { id: 'u1', email: 'admin@x', name: 'A', role: 'admin', totpEnabled: false },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it('renders order summary, line items, timeline, and the dispute panel', async () => {
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /SO-1001/ })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Widget/)).toBeInTheDocument();
    expect(screen.getByText('€29.00')).toBeInTheDocument(); // total (minor-units)
    expect(screen.getByText('Dispute')).toBeInTheDocument();
    expect(screen.getByText(/pending payment → paid/)).toBeInTheDocument(); // timeline entry
    // paid → can mark fulfilled + cancel; frozen → unfreeze button
    expect(screen.getByRole('button', { name: 'Mark fulfilled' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unfreeze fulfillment' })).toBeInTheDocument();
  });

  it('opens the refund modal and posts a full refund with an idempotency key', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /SO-1001/ })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'Refund' }));
    expect(screen.getByText('Restock refunded items')).toBeInTheDocument(); // modal opened
    await user.click(screen.getByRole('button', { name: 'Issue refund' }));

    await waitFor(() => {
      const refundCall = vi
        .mocked(apiFetch)
        .mock.calls.find((c) => String(c[0]).endsWith('/refunds'));
      expect(refundCall).toBeTruthy();
      const body = JSON.parse((refundCall![1] as RequestInit).body as string);
      expect(body.idempotencyKey).toBeTruthy();
      expect(body.restock).toBe(true);
      expect(body.items).toBeUndefined(); // full refund
    });
  });

  it('hides write actions for a read-only (staff) role', async () => {
    useAuthStore.setState({
      user: { id: 'u2', email: 's@x', name: 'S', role: 'staff', totpEnabled: false },
    } as never);
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /SO-1001/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Mark fulfilled' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
  });
});
