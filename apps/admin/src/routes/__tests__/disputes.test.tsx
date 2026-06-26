/**
 * Disputes queue admin screen specs (consumes the existing /admin/v1/disputes API).
 *
 * Mocks `apiFetch`, renders the list inside a fresh QueryClient + router. Asserts:
 * rows render with money formatted from minor units, the status filter refetches
 * with the right query string, pagination advances the page param, and the
 * "Unfreeze fulfilment" action (open disputes only) confirms then POSTs unfreeze.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {
    constructor(
      msg: string,
      public status: number,
      public body: unknown,
    ) {
      super(msg);
    }
  },
}));

import { useAuthStore } from '@/lib/auth';
import DisputesPage from '../disputes';

function setRole(role: string | null) {
  useAuthStore
    .getState()
    .setUser(role ? { id: 'u1', email: 'u@x.io', name: 'U', role, totpEnabled: false } : null);
}

const OPEN_DISPUTE = {
  id: 'd1',
  orderId: 'o1',
  amount: 1234,
  currency: 'EUR',
  reason: 'fraudulent',
  status: 'open',
  providerStatus: 'needs_response',
  evidenceDueBy: '2026-07-01T00:00:00.000Z',
  providerDisputeId: 'dp_123',
  createdAt: '2026-06-20T00:00:00.000Z',
};
const LOST_DISPUTE = {
  id: 'd2',
  orderId: 'o2',
  amount: 5000,
  currency: 'EUR',
  reason: null,
  status: 'lost',
  providerStatus: 'lost',
  evidenceDueBy: null,
  providerDisputeId: 'dp_456',
  createdAt: '2026-06-19T00:00:00.000Z',
};

function listResponse(rows: unknown[], total = rows.length) {
  return { data: rows, total, page: 1, pageSize: 20 };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/disputes']}>
        <Routes>
          <Route path="/disputes" element={<DisputesPage />} />
          <Route path="/orders/:id" element={<div>Order page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  localStorage.clear();
  // Default to admin so the money-sensitive unfreeze action is surfaced.
  setRole('admin');
});

describe('DisputesPage (queue)', () => {
  it('renders rows with money formatted from minor units and a status badge', async () => {
    apiFetch.mockResolvedValue(listResponse([OPEN_DISPUTE, LOST_DISPUTE]));
    renderPage();

    expect(await screen.findByText('€12.34')).toBeInTheDocument();
    expect(screen.getByText('€50.00')).toBeInTheDocument();
    expect(screen.getByText('fraudulent')).toBeInTheDocument();
    // First call hits the paginated list endpoint.
    expect(apiFetch).toHaveBeenCalledWith('/admin/v1/disputes?page=1&pageSize=20');
  });

  it('refetches with a status filter when the status select changes', async () => {
    apiFetch.mockResolvedValue(listResponse([OPEN_DISPUTE]));
    renderPage();
    await screen.findByText('€12.34');

    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'open');

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/disputes?page=1&pageSize=20&status=open');
    });
  });

  it('advances the page param when paginating', async () => {
    apiFetch.mockResolvedValue(listResponse([OPEN_DISPUTE], 40));
    renderPage();
    await screen.findByText('€12.34');

    await userEvent.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/disputes?page=2&pageSize=20');
    });
  });

  it('navigates to the order when a row is clicked', async () => {
    apiFetch.mockResolvedValue(listResponse([OPEN_DISPUTE]));
    renderPage();
    await screen.findByText('€12.34');

    await userEvent.click(screen.getByText('€12.34'));
    expect(await screen.findByText('Order page')).toBeInTheDocument();
  });

  it('unfreezes an OPEN dispute via confirm → POST', async () => {
    apiFetch.mockResolvedValue(listResponse([OPEN_DISPUTE]));
    renderPage();
    await screen.findByText('€12.34');

    await userEvent.click(screen.getByRole('button', { name: /unfreeze fulfil/i }));

    const dialog = await screen.findByRole('dialog');
    apiFetch.mockResolvedValueOnce({ orderId: 'o1' }); // the unfreeze POST
    await userEvent.click(within(dialog).getByRole('button', { name: /unfreeze/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/disputes/d1/unfreeze-fulfillment', {
        method: 'POST',
      });
    });
  });

  it('does not surface an unfreeze action on a closed (lost) dispute', async () => {
    apiFetch.mockResolvedValue(listResponse([LOST_DISPUTE]));
    renderPage();
    await screen.findByText('€50.00');

    expect(screen.queryByRole('button', { name: /unfreeze/i })).not.toBeInTheDocument();
  });

  it('hides the unfreeze action for staff (no orders:write)', async () => {
    setRole('staff');
    apiFetch.mockResolvedValue(listResponse([OPEN_DISPUTE]));
    renderPage();
    await screen.findByText('€12.34');

    expect(screen.queryByRole('button', { name: /unfreeze/i })).not.toBeInTheDocument();
  });
});
