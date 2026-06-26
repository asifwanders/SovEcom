import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LoginPage from '../routes/login';
import { useAuthStore } from '../lib/auth';
import { z } from 'zod';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders login form', () => {
    render(<LoginPage />, { wrapper: Wrapper });
    expect(screen.getByText('Sign in to SovEcom')).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeInTheDocument();
  });

  it('shows validation errors for empty fields', async () => {
    const user = userEvent.setup();
    render(<LoginPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => {
      expect(screen.getAllByText(/Required/)).toHaveLength(2);
    });
  });

  it('validates email with zod schema', () => {
    const schema = z.object({
      email: z.string().min(1, 'Required').email('Invalid email address'),
      password: z.string().min(1, 'Required'),
    });
    const result = schema.safeParse({ email: 'not-an-email', password: 'somepassword' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i: { message: string }) => i.message === 'Invalid email address'),
      ).toBe(true);
    }
  });

  it('submits login and redirects on success', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'token-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(<LoginPage />, { wrapper: Wrapper });
    await user.type(screen.getByLabelText(/Email address/), 'admin@example.com');
    await user.type(screen.getByLabelText(/Password/), 'password123');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => {
      expect(useAuthStore.getState().accessToken).toBe('token-123');
    });
  });

  it('redirects to 2FA when required', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ requires2FA: true, challengeId: 'challenge-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(<LoginPage />, { wrapper: Wrapper });
    await user.type(screen.getByLabelText(/Email address/), 'admin@example.com');
    await user.type(screen.getByLabelText(/Password/), 'password123');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/2fa');
    });
  });

  it('shows error on 401', async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(<LoginPage />, { wrapper: Wrapper });
    await user.type(screen.getByLabelText(/Email address/), 'admin@example.com');
    await user.type(screen.getByLabelText(/Password/), 'wrong');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => {
      expect(screen.getByText(/Invalid credentials/)).toBeInTheDocument();
    });
  });
});
