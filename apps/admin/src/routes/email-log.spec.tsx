import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EmailLogPage from './email-log';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const SENT_ROW = {
  id: 'e1',
  recipient: 'buyer@example.com',
  type: 'order_confirmation',
  subject: 'Your order is confirmed',
  status: 'sent',
  attempts: 1,
  error: null,
  providerMessageId: 'msg_123',
  sentAt: '2026-06-20T10:00:00Z',
  createdAt: '2026-06-20T09:59:00Z',
};

const FAILED_ROW = {
  id: 'e2',
  recipient: 'oops@example.com',
  type: 'refund_issued',
  subject: 'Your refund',
  status: 'failed',
  attempts: 3,
  error: 'SMTP timeout',
  providerMessageId: null,
  sentAt: null,
  createdAt: '2026-06-20T11:00:00Z',
};

const RESPONSE = { data: [SENT_ROW, FAILED_ROW], total: 2, page: 1, pageSize: 20 };

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

describe('EmailLogPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    asAdmin();
  });

  it('lists emails with recipient, subject and status badges', async () => {
    vi.mocked(apiFetch).mockResolvedValue(RESPONSE);
    render(<EmailLogPage />, { wrapper: wrapper() });

    await waitFor(() => expect(screen.getByText('buyer@example.com')).toBeInTheDocument());
    expect(screen.getByText('Your order is confirmed')).toBeInTheDocument();
    expect(screen.getByText('oops@example.com')).toBeInTheDocument();
    // Status badges live in table cells (not the <option> elements of the filter).
    const cells = screen.getAllByRole('cell');
    expect(cells.some((c) => c.textContent === 'Sent')).toBe(true);
    expect(cells.some((c) => c.textContent === 'Failed')).toBe(true);
  });

  it('shows a Resend action only on failed rows', async () => {
    vi.mocked(apiFetch).mockResolvedValue(RESPONSE);
    render(<EmailLogPage />, { wrapper: wrapper() });

    await waitFor(() => expect(screen.getByText('buyer@example.com')).toBeInTheDocument());
    // Exactly one Resend button — for the failed row.
    expect(screen.getAllByRole('button', { name: 'Resend' })).toHaveLength(1);
  });

  it('passes the status filter to the query', async () => {
    vi.mocked(apiFetch).mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    render(<EmailLogPage />, { wrapper: wrapper() });

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await user.selectOptions(screen.getByLabelText('Status filter'), 'failed');

    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(expect.stringContaining('status=failed')),
    );
  });

  it('passes the type filter to the query', async () => {
    vi.mocked(apiFetch).mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    render(<EmailLogPage />, { wrapper: wrapper() });

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await user.selectOptions(screen.getByLabelText('Type filter'), 'order_shipped');

    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        expect.stringContaining('type=order_shipped'),
      ),
    );
  });

  it('resends a failed email via POST and refetches', async () => {
    vi.mocked(apiFetch).mockResolvedValue(RESPONSE);
    const user = userEvent.setup();
    render(<EmailLogPage />, { wrapper: wrapper() });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resend' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Resend' }));

    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        '/admin/v1/emails/e2/resend',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('shows an empty state when there are no emails', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
    render(<EmailLogPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('No emails found.')).toBeInTheDocument());
  });
});
