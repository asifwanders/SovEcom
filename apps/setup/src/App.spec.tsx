import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { createMockApi } from './test-utils';
import { PROGRESS_KEY, TOKEN_KEY } from './wizard/storage';

// window.location.assign is called on completion / already-installed CTAs; stub it so
// jsdom doesn't throw "not implemented".
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: () => {} },
  });
});

describe('App boot', () => {
  it('shows a loader, then the wizard rail + Welcome step on a fresh (not-installed) system', async () => {
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(screen.getByText(/checking setup status/i)).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: /welcome to sovecom/i })).toBeInTheDocument();
    // The rail is a <nav> labelled "Setup progress"; the current step is announced.
    // Both the desktop rail and the mobile top-bar render (CSS hides one per viewport),
    // so the counter legitimately appears twice in jsdom.
    const rails = screen.getAllByRole('navigation', { name: /setup progress/i });
    expect(rails.length).toBe(2);
    expect(screen.getAllByText(/step 1 of 11/i).length).toBeGreaterThan(0);
  });

  it('renders the already-installed screen (never the wizard) when status.installed is true', async () => {
    const { api } = createMockApi({ status: { installed: true } });
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /already set up/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to admin/i })).toBeInTheDocument();
    // The wizard must not render.
    expect(screen.queryByText(/step 1 of 11/i)).not.toBeInTheDocument();
  });

  it('shows a retryable error when the status check fails', async () => {
    const { api, status } = createMockApi();
    status.mockRejectedValueOnce(new Error('network'));
    render(<App api={api} />);

    expect(
      await screen.findByRole('heading', { name: /can’t reach the server/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

describe('Welcome step — token gating', () => {
  it('blocks advance and shows an inline error when the token is invalid', async () => {
    const user = userEvent.setup();
    const { api, verifyToken } = createMockApi({
      verifyToken: { valid: false, expiresAt: null },
    });
    render(<App api={api} />);

    await screen.findByRole('heading', { name: /welcome to sovecom/i });
    await user.type(screen.getByLabelText(/setup token/i), 'bad-token');
    await user.click(screen.getByRole('button', { name: /verify & continue/i }));

    expect(verifyToken).toHaveBeenCalledWith('bad-token');
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
    // Still on Welcome.
    expect(screen.getByRole('heading', { name: /welcome to sovecom/i })).toBeInTheDocument();
    // The bad token was NOT persisted.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('blocks advance until a token is entered (required-field validation)', async () => {
    const user = userEvent.setup();
    const { api, verifyToken } = createMockApi();
    render(<App api={api} />);

    await screen.findByRole('heading', { name: /welcome to sovecom/i });
    await user.click(screen.getByRole('button', { name: /verify & continue/i }));

    expect(await screen.findByText(/enter your setup token to continue/i)).toBeInTheDocument();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('stores the token in sessionStorage (NOT localStorage) and advances on a valid token', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);

    await screen.findByRole('heading', { name: /welcome to sovecom/i });
    await user.type(screen.getByLabelText(/setup token/i), 'good-token');
    await user.click(screen.getByRole('button', { name: /verify & continue/i }));

    // Advanced to step 2 (Brand placeholder).
    expect((await screen.findAllByText(/step 2 of 11/i)).length).toBeGreaterThan(0);
    // Token is a short-lived secret → sessionStorage only, never localStorage.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('good-token');
    expect(localStorage.getItem('sovecom.setup.token')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('good-token');
  });
});

describe('Navigation + persistence', () => {
  async function advancePastWelcome(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole('heading', { name: /welcome to sovecom/i });
    await user.type(screen.getByLabelText(/setup token/i), 'good-token');
    await user.click(screen.getByRole('button', { name: /verify & continue/i }));
    await screen.findAllByText(/step 2 of 11/i);
  }

  it('next/back updates the rail counter and persists currentIndex to localStorage', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await advancePastWelcome(user);

    // Advance Brand → Database.
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    expect((await screen.findAllByText(/step 3 of 11/i)).length).toBeGreaterThan(0);

    const persisted = JSON.parse(localStorage.getItem(PROGRESS_KEY)!);
    expect(persisted.currentIndex).toBe(2);

    // Back to Brand.
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect((await screen.findAllByText(/step 2 of 11/i)).length).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!).currentIndex).toBe(1);
  });

  it('resumes at the saved step after a remount (refresh-safe)', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi();
    const { unmount } = render(<App api={api} />);
    await advancePastWelcome(user);
    // Move forward a couple of steps.
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await screen.findAllByText(/step 3 of 11/i);
    expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!).currentIndex).toBe(2);

    // Simulate a page refresh: fully unmount and re-render a brand-new App.
    unmount();
    const { api: api2 } = createMockApi();
    render(<App api={api2} />);

    // Resumes at step 3 (Database) — reading localStorage, not back at Welcome.
    expect((await screen.findAllByText(/step 3 of 11/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /^database$/i })).toBeInTheDocument();
  });

  it('shows a Skip control on the optional Modules step', async () => {
    // Seed progress directly onto the Modules step (index 8) to avoid clicking through all.
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 8, data: {} }));
    sessionStorage.setItem(TOKEN_KEY, 'good-token');
    const { api } = createMockApi();
    render(<App api={api} />);

    expect((await screen.findAllByText(/step 9 of 11/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^skip$/i })).toBeInTheDocument();
  });
});

describe('Done step — completion', () => {
  it('calls complete(), clears token + progress, and redirects to /admin', async () => {
    const user = userEvent.setup();
    let redirected = '';
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: (url: string) => (redirected = url) },
    });

    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 10, data: {} }));
    sessionStorage.setItem(TOKEN_KEY, 'good-token');
    const { api, complete } = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /you’re all set/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /finish setup/i }));

    await waitFor(() => expect(complete).toHaveBeenCalled());
    await waitFor(() => expect(redirected).toBe('/admin'));
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  });

  it('has no Back button on the Done step', async () => {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 10, data: {} }));
    sessionStorage.setItem(TOKEN_KEY, 'good-token');
    const { api } = createMockApi();
    render(<App api={api} />);

    await screen.findByRole('heading', { name: /you’re all set/i });
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
  });
});

describe('Accessibility wiring', () => {
  it('marks the current rail step with aria-current="step"', async () => {
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /welcome to sovecom/i });

    const rail = screen
      .getAllByRole('navigation', { name: /setup progress/i })
      .find((n) => within(n).queryByText(/step 1 of 11/i))!;
    const current = within(rail).getByText('Welcome').closest('[aria-current]');
    expect(current).toHaveAttribute('aria-current', 'step');
  });
});
