import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReturnsPage from './returns';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const REQUESTED = {
  data: [
    {
      id: 'r1',
      orderId: 'o1',
      type: 'withdrawal',
      status: 'requested',
      items: [{ orderItemId: 'i1', quantity: 1 }],
      reason: 'changed mind',
      withinWithdrawalWindow: true,
      requestedAt: '2026-06-13T00:00:00Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

function asAdmin() {
  useAuthStore.setState({
    accessToken: 'tok',
    user: { id: 'u1', email: 'a@x', name: 'A', role: 'admin', totpEnabled: false },
    isAuthenticated: true,
    isLoading: false,
  });
}

describe('ReturnsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    asAdmin();
  });

  it('lists requested returns with the withdrawal-window badge and approve/reject actions', async () => {
    vi.mocked(apiFetch).mockResolvedValue(REQUESTED);
    render(<ReturnsPage />, { wrapper: wrapper() });

    await waitFor(() => expect(screen.getByText('In window')).toBeInTheDocument());
    expect(screen.getByText('changed mind')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('D3: clicking Approve opens a confirmation dialog before posting', async () => {
    vi.mocked(apiFetch).mockResolvedValue(REQUESTED);
    const user = userEvent.setup();
    render(<ReturnsPage />, { wrapper: wrapper() });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument(),
    );

    // Click the row Approve button — should open confirmation dialog, NOT mutate yet
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The approve endpoint must NOT have been called yet
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith(
      '/admin/v1/returns/r1/approve',
      expect.anything(),
    );
  });

  it('D3: confirming the approve dialog sends the POST', async () => {
    vi.mocked(apiFetch).mockResolvedValue(REQUESTED);
    const user = userEvent.setup();
    render(<ReturnsPage />, { wrapper: wrapper() });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    // Confirm in the dialog
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    await user.click(confirmBtn);
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        '/admin/v1/returns/r1/approve',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('reject requires a reason and posts it', async () => {
    vi.mocked(apiFetch).mockResolvedValue(REQUESTED);
    const user = userEvent.setup();
    render(<ReturnsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    // The dialog's Reject button is disabled until a reason is entered.
    const dialogReject = screen.getAllByRole('button', { name: 'Reject' }).at(-1)!;
    expect(dialogReject).toBeDisabled();

    await user.type(screen.getByLabelText('Reason'), 'outside policy');
    expect(dialogReject).toBeEnabled();
    await user.click(dialogReject);
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        '/admin/v1/returns/r1/reject',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('hides actions for a read-only (staff) role', async () => {
    useAuthStore.setState({
      user: { id: 'u2', email: 's@x', name: 'S', role: 'staff', totpEnabled: false },
    } as never);
    vi.mocked(apiFetch).mockResolvedValue(REQUESTED);
    render(<ReturnsPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('changed mind')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
