import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthGuard } from './auth-guard';
import { useAuthStore } from '@/lib/auth';

describe('AuthGuard', () => {
  it('renders children when authenticated', () => {
    useAuthStore.setState({
      accessToken: 'token',
      user: null,
      isAuthenticated: true,
      isLoading: false,
    });
    render(
      <MemoryRouter>
        <Routes>
          <Route
            path="/"
            element={
              <AuthGuard>
                <div>Protected</div>
              </AuthGuard>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Protected')).toBeInTheDocument();
  });

  it('redirects to login when not authenticated', () => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/login" element={<div>Login</div>} />
          <Route
            path="/dashboard"
            element={
              <AuthGuard>
                <div>Dashboard</div>
              </AuthGuard>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Login')).toBeInTheDocument();
  });

  it('renders a loading state (no redirect) while bootstrap is in flight', () => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: true, // bootstrap in progress
    });
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/login" element={<div>Login</div>} />
          <Route
            path="/dashboard"
            element={
              <AuthGuard>
                <div>Dashboard</div>
              </AuthGuard>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    // Must NOT redirect to login during bootstrap
    expect(screen.queryByText('Login')).toBeNull();
    // Must NOT show protected content
    expect(screen.queryByText('Dashboard')).toBeNull();
    // Must show a loading indicator
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
