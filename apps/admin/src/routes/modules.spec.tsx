import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ModulesPage from './modules';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const MODULES = [
  {
    id: 'm1',
    name: 'reviews',
    version: '1.2.0',
    grantedPermissions: ['read:products'],
    slots: [],
    enabled: true,
    installedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'm2',
    name: 'wishlist',
    version: '0.9.0',
    grantedPermissions: [],
    slots: [],
    enabled: false,
    installedAt: '2026-01-02T00:00:00.000Z',
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

describe('ModulesPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    setRole('admin');
  });

  it('renders the empty state when no modules are installed', async () => {
    vi.mocked(apiFetch).mockResolvedValue([] as unknown as never);
    render(<ModulesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText(/No modules installed/i)).toBeInTheDocument());
  });

  it('lists modules; badges enabled/disabled and shows the matching action', async () => {
    vi.mocked(apiFetch).mockResolvedValue(MODULES as unknown as never);
    render(<ModulesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('reviews')).toBeInTheDocument());
    expect(screen.getByText('wishlist')).toBeInTheDocument();

    // Enabled module (reviews): Enabled badge + a Disable action.
    const reviewsRow = screen.getByText('reviews').closest('tr')!;
    expect(within(reviewsRow).getByText('Enabled')).toBeInTheDocument();
    expect(within(reviewsRow).getByRole('button', { name: 'Disable' })).toBeInTheDocument();

    // Disabled module (wishlist): Disabled badge + an Enable action.
    const wishlistRow = screen.getByText('wishlist').closest('tr')!;
    expect(within(wishlistRow).getByText('Disabled')).toBeInTheDocument();
    expect(within(wishlistRow).getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('enabling a disabled module POSTs /enable then refetches', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(MODULES as unknown as never) // initial GET
      .mockResolvedValueOnce(undefined as unknown as never) // POST /enable (204)
      .mockResolvedValueOnce(
        // refetch: wishlist now enabled
        MODULES.map((m) => (m.name === 'wishlist' ? { ...m, enabled: true } : m)) as unknown as never,
      );
    render(<ModulesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('wishlist')).toBeInTheDocument());

    const wishlistRow = screen.getByText('wishlist').closest('tr')!;
    await userEvent.click(within(wishlistRow).getByRole('button', { name: 'Enable' }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/modules/wishlist/enable', {
        method: 'POST',
      }),
    );
    // After the refetch, wishlist's row shows a Disable action (it is now enabled).
    await waitFor(() =>
      expect(
        within(screen.getByText('wishlist').closest('tr')!).getByRole('button', { name: 'Disable' }),
      ).toBeInTheDocument(),
    );
  });

  it('disabling an enabled module POSTs /disable then refetches', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(MODULES as unknown as never)
      .mockResolvedValueOnce(undefined as unknown as never)
      .mockResolvedValueOnce(MODULES as unknown as never);
    render(<ModulesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('reviews')).toBeInTheDocument());

    const reviewsRow = screen.getByText('reviews').closest('tr')!;
    await userEvent.click(within(reviewsRow).getByRole('button', { name: 'Disable' }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/modules/reviews/disable', {
        method: 'POST',
      }),
    );
  });

  it('uninstall confirms then calls DELETE for the chosen module', async () => {
    vi.mocked(apiFetch).mockResolvedValue(MODULES as unknown as never);
    render(<ModulesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('wishlist')).toBeInTheDocument());
    const wishlistRow = screen.getByText('wishlist').closest('tr')!;
    await userEvent.click(within(wishlistRow).getByRole('button', { name: /Uninstall module/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/modules/wishlist', { method: 'DELETE' }),
    );
  });

  it('install posts multipart FormData to /install', async () => {
    vi.mocked(apiFetch).mockResolvedValue([] as unknown as never);
    render(<ModulesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText(/No modules installed/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Install module' }));

    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText(/Module package/i) as HTMLInputElement;
    const file = new File(['x'], 'module.tgz', { type: 'application/gzip' });
    await userEvent.upload(input, file);
    // Scope the submit to the dialog (there is also the page-level Install button).
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install module' }));

    await waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find((c) => c[0] === '/admin/v1/modules/install');
      expect(call).toBeTruthy();
      expect(call![1]?.method).toBe('POST');
      expect(call![1]?.body).toBeInstanceOf(FormData);
    });
  });

  it('hides write actions (install/enable/disable/uninstall) for staff without modules:write', async () => {
    setRole('staff');
    vi.mocked(apiFetch).mockResolvedValue(MODULES as unknown as never);
    render(<ModulesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('reviews')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Install module' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Uninstall module/i })).not.toBeInTheDocument();
  });
});
