import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { createMockApi } from '../test-utils';
import { SetupApiError } from '../lib/api';
import { PROGRESS_KEY, TOKEN_KEY } from '../wizard/storage';

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

/** Seed progress on the Done step (index 10) with collected data + a live token. */
function seedDone(data: Record<string, unknown> = {}) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 10, data }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

const FULL_DATA = {
  brand: { primary: '#00B9A0', secondary: '#0F172A' },
  tax: { businessCountry: 'FR', defaultCurrency: 'EUR', taxMode: 'eu_vat' },
  admin: { email: 'ada@example.com' },
  database: { mode: 'bare_metal' },
};

describe('DoneStep', () => {
  it('renders a summary pulling the collected wizard data', async () => {
    seedDone(FULL_DATA);
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(
      await screen.findByRole('heading', { name: /you’re all set|you're all set/i }),
    ).toBeInTheDocument();
    // Admin email, tax regime, and currency surface in the summary.
    expect(screen.getByText(/ada@example\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/EU VAT/i)).toBeInTheDocument();
    expect(screen.getByText(/EUR/i)).toBeInTheDocument();
  });

  it('completes, clears storage, and redirects to /admin on Finish', async () => {
    seedDone(FULL_DATA);
    const user = userEvent.setup();
    const { api, complete } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /you’re all set|you're all set/i });

    await user.click(screen.getByRole('button', { name: /finish setup/i }));

    await waitFor(() => expect(complete).toHaveBeenCalled());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin'));
    // Token + progress are cleared.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  });

  it('treats a post-install 404 as installed (still redirects)', async () => {
    seedDone(FULL_DATA);
    const user = userEvent.setup();
    // The real client maps a 404 to { installed: true }; the mock does the same here.
    const { api } = createMockApi({ complete: async () => ({ installed: true }) });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /you’re all set|you're all set/i });

    await user.click(screen.getByRole('button', { name: /finish setup/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin'));
  });

  it('lists missing preconditions on a 422 and does not redirect', async () => {
    seedDone(FULL_DATA);
    const user = userEvent.setup();
    const { api } = createMockApi({
      complete: async () => {
        throw new SetupApiError(
          422,
          'setup is not complete',
          {},
          {
            message: 'setup is not complete',
            missing: ['admin_account', 'tax_configuration'],
          },
        );
      },
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /you’re all set|you're all set/i });

    await user.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(await screen.findByText(/create your admin account/i)).toBeInTheDocument();
    expect(screen.getByText(/choose your tax settings/i)).toBeInTheDocument();
    // Two "Fix this" affordances back to the relevant steps.
    expect(screen.getAllByRole('button', { name: /fix this/i })).toHaveLength(2);
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows loading on Finish while completing', async () => {
    seedDone(FULL_DATA);
    const user = userEvent.setup();
    let resolve!: (v: { installed: true }) => void;
    const { api } = createMockApi({
      complete: () => new Promise<{ installed: true }>((r) => (resolve = r)),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /you’re all set|you're all set/i });

    const btn = screen.getByRole('button', { name: /finish setup/i });
    await user.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'true'));
    resolve({ installed: true });
  });
});
