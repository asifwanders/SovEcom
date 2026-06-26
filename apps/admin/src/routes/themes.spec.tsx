import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ThemesPage from './themes';
import { useAuthStore } from '@/lib/auth';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const THEMES = [
  {
    id: 't1',
    name: 'aurora',
    version: '1.2.0',
    slots: {},
    settings: { primary: '#000' },
    isActive: true,
    installedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 't2',
    name: 'nimbus',
    version: '0.9.0',
    slots: {},
    settings: {},
    isActive: false,
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

describe('ThemesPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    setRole('admin');
  });

  it('renders the empty state + bundled-themes note when no themes are installed', async () => {
    vi.mocked(apiFetch).mockResolvedValue([] as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText(/No themes installed/i)).toBeInTheDocument());
    expect(screen.getByText(/not listed here yet/i)).toBeInTheDocument();
  });

  it('lists themes; badges the active one and disables its Activate button', async () => {
    vi.mocked(apiFetch).mockResolvedValue(THEMES as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('aurora')).toBeInTheDocument());
    expect(screen.getByText('nimbus')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();

    // Active theme (aurora) row: its Activate button is disabled.
    const auroraRow = screen.getByText('aurora').closest('tr')!;
    expect(within(auroraRow).getByRole('button', { name: 'Activate' })).toBeDisabled();
    // Inactive theme (nimbus) row: its Activate button is enabled.
    const nimbusRow = screen.getByText('nimbus').closest('tr')!;
    expect(within(nimbusRow).getByRole('button', { name: 'Activate' })).toBeEnabled();
  });

  it('activate calls POST /activate for the chosen theme', async () => {
    vi.mocked(apiFetch).mockResolvedValue(THEMES as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('nimbus')).toBeInTheDocument());
    const nimbusRow = screen.getByText('nimbus').closest('tr')!;
    await userEvent.click(within(nimbusRow).getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/themes/nimbus/activate', {
        method: 'POST',
      }),
    );
  });

  it('delete confirms then calls DELETE for the chosen theme', async () => {
    vi.mocked(apiFetch).mockResolvedValue(THEMES as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('nimbus')).toBeInTheDocument());
    const nimbusRow = screen.getByText('nimbus').closest('tr')!;
    await userEvent.click(within(nimbusRow).getByRole('button', { name: /Uninstall theme/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/themes/nimbus', { method: 'DELETE' }),
    );
  });

  it('install posts multipart FormData to /install', async () => {
    vi.mocked(apiFetch).mockResolvedValue([] as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText(/No themes installed/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Install theme' }));

    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText(/Theme package/i) as HTMLInputElement;
    const file = new File(['x'], 'theme.tgz', { type: 'application/gzip' });
    await userEvent.upload(input, file);
    // Scope the submit to the dialog (there is also the page-level Install button).
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install theme' }));

    await waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find((c) => c[0] === '/admin/v1/themes/install');
      expect(call).toBeTruthy();
      expect(call![1]?.method).toBe('POST');
      expect(call![1]?.body).toBeInstanceOf(FormData);
    });
  });

  it('settings dialog rejects invalid JSON before submitting', async () => {
    vi.mocked(apiFetch).mockResolvedValue(THEMES as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('aurora')).toBeInTheDocument());
    const auroraRow = screen.getByText('aurora').closest('tr')!;
    await userEvent.click(within(auroraRow).getByRole('button', { name: /Edit settings/i }));

    const textarea = screen.getByLabelText(/Settings \(JSON\)/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '{{not json');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText(/must be valid JSON/i)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/settings'),
      expect.anything(),
    );
  });

  it('settings dialog submits valid JSON as PATCH with { settings } body', async () => {
    vi.mocked(apiFetch).mockResolvedValue(THEMES as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('aurora')).toBeInTheDocument());
    const auroraRow = screen.getByText('aurora').closest('tr')!;
    await userEvent.click(within(auroraRow).getByRole('button', { name: /Edit settings/i }));

    // fireEvent.change avoids user-event's `{`/`}` escaping for raw JSON entry.
    const textarea = screen.getByLabelText(/Settings \(JSON\)/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"primary":"#fff","logo":"a.png"}' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/themes/aurora/settings', {
        method: 'PATCH',
        body: JSON.stringify({ settings: { primary: '#fff', logo: 'a.png' } }),
      }),
    );
  });

  it('settings dialog rejects valid JSON that is not an object (array / null)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(THEMES as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('aurora')).toBeInTheDocument());
    const auroraRow = screen.getByText('aurora').closest('tr')!;
    await userEvent.click(within(auroraRow).getByRole('button', { name: /Edit settings/i }));
    const textarea = screen.getByLabelText(/Settings \(JSON\)/i) as HTMLTextAreaElement;

    // Array — valid JSON but wrong shape: must be rejected with no API call.
    fireEvent.change(textarea, { target: { value: '[1,2,3]' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/must be valid JSON/i)).toBeInTheDocument();

    // null — also valid JSON, also wrong shape.
    fireEvent.change(textarea, { target: { value: 'null' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/must be valid JSON/i)).toBeInTheDocument();

    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/settings'),
      expect.anything(),
    );
  });

  it('hides write actions (install/activate/delete) for staff without themes:write', async () => {
    setRole('staff');
    vi.mocked(apiFetch).mockResolvedValue(THEMES as unknown as never);
    render(<ThemesPage />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText('aurora')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Install theme' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Uninstall theme/i })).not.toBeInTheDocument();
  });
});
