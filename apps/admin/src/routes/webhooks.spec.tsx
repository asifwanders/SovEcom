import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WebhooksPage from './webhooks';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const SUBS = [
  {
    id: 's1',
    url: 'https://hook.test/x',
    events: ['order.created'],
    active: true,
    createdAt: '2026-06-13T00:00:00Z',
  },
];
const DELIVERIES = {
  data: [
    {
      id: 'dl1',
      subscriptionId: 's1',
      event: 'order.created',
      status: 'failed',
      attempts: 2,
      responseCode: 500,
      lastError: 'HTTP 500',
      createdAt: '2026-06-13T00:00:00Z',
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
function mockApi() {
  vi.mocked(apiFetch).mockImplementation(
    (path: string) =>
      Promise.resolve(path.includes('/deliveries') ? DELIVERIES : SUBS) as Promise<unknown>,
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

describe('WebhooksPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    mockApi();
    setRole('admin');
  });

  it('renders subscriptions + the delivery log with a status badge', async () => {
    render(<WebhooksPage />, { wrapper: wrapper() });
    await waitFor(() =>
      expect(screen.getAllByText('https://hook.test/x').length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.getByText('1 event(s)')).toBeInTheDocument();
    expect(screen.getByText('order.created')).toBeInTheDocument(); // delivery row
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('creates a subscription and shows the signing secret once', async () => {
    vi.mocked(apiFetch).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/admin/v1/webhooks/subscriptions' && init?.method === 'POST') {
        return Promise.resolve({
          id: 's2',
          url: 'https://new.test',
          events: ['order.paid'],
          active: true,
          createdAt: 'x',
          secret: 'whsec_TOPSECRET',
        }) as Promise<unknown>;
      }
      return Promise.resolve(path.includes('/deliveries') ? DELIVERIES : SUBS) as Promise<unknown>;
    });
    const user = userEvent.setup();
    render(<WebhooksPage />, { wrapper: wrapper() });
    await waitFor(() =>
      expect(screen.getAllByText('https://hook.test/x').length).toBeGreaterThanOrEqual(1),
    );

    await user.click(screen.getByRole('button', { name: /Create/ }));
    await user.type(screen.getByLabelText(/Endpoint URL/), 'https://new.test');
    await user.click(screen.getByLabelText('order.paid'));
    // After the form opens both the header and the form submit read "Create" — submit the last one.
    await user.click(screen.getAllByRole('button', { name: /^Create$/ }).at(-1)!);

    await waitFor(() => expect(screen.getByText('Subscription created')).toBeInTheDocument());
    expect((screen.getByLabelText('Signing secret') as HTMLInputElement).value).toBe(
      'whsec_TOPSECRET',
    );
  });

  it('retries a failed delivery (POST .../retry)', async () => {
    const user = userEvent.setup();
    render(<WebhooksPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Retry delivery' }));
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        '/admin/v1/webhooks/deliveries/dl1/retry',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('hides create/delete/retry for staff (no settings:write)', async () => {
    setRole('staff');
    render(<WebhooksPage />, { wrapper: wrapper() });
    await waitFor(() =>
      expect(screen.getAllByText('https://hook.test/x').length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.queryByRole('button', { name: /Create/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).not.toBeInTheDocument();
  });
});
