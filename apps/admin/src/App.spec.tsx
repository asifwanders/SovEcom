import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';
import { useAuthStore } from './lib/auth';

describe('App', () => {
  beforeEach(() => {
    // The session bootstrap (App.tsx) calls /admin/v1/auth/refresh on mount. Mock it to fail
    // so the app resolves to the unauthenticated state.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })),
    );
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the loading gate first, then the login page once the bootstrap resolves unauthenticated', async () => {
    render(<App />);
    // isLoading starts TRUE so a protected-route hard load shows "Loading…" (NOT a premature
    // redirect to /login) while the async refresh runs. Once it resolves (401 → logout), the
    // guard renders the login page.
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText('Sign in to SovEcom')).toBeInTheDocument();
  });
});
