import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { createMockApi } from '../test-utils';
import { PROGRESS_KEY, TOKEN_KEY } from '../wizard/storage';

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: () => {} },
  });
});

/** Seed progress directly onto the Database step (index 2) with a live token. */
function seedDatabase() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 2, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

describe('DatabaseStep', () => {
  it('renders the bundled / external choice, bundled selected by default', async () => {
    seedDatabase();
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /^database$/i })).toBeInTheDocument();
    const bundled = screen.getByRole('radio', { name: /bundled postgres/i });
    expect(bundled).toBeChecked();
    // No URL field until external is chosen.
    expect(screen.queryByLabelText(/connection url/i)).not.toBeInTheDocument();
  });

  it('bundled mode configures without a test and advances', async () => {
    seedDatabase();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^database$/i });

    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![0]).toBe('/setup/v1/database/configure');
    expect(post.mock.calls[0]![1]).toEqual({ mode: 'bare_metal' });
    expect((await screen.findAllByText(/step 4 of 11/i)).length).toBeGreaterThan(0);
  });

  it('external mode requires a valid URL before Continue', async () => {
    seedDatabase();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^database$/i });

    await user.click(screen.getByRole('radio', { name: /external database/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/enter your database connection url/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('test connection shows loading then an inline success', async () => {
    seedDatabase();
    const user = userEvent.setup();
    let resolve!: (v: { ok: true }) => void;
    const { api } = createMockApi({
      post: () => new Promise<{ ok: true }>((r) => (resolve = r)),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^database$/i });

    await user.click(screen.getByRole('radio', { name: /external database/i }));
    await user.type(screen.getByLabelText(/connection url/i), 'postgresql://u:p@host:5432/db');

    const testBtn = screen.getByRole('button', { name: /test connection/i });
    await user.click(testBtn);
    // Loading: the button is busy.
    await waitFor(() => expect(testBtn).toHaveAttribute('aria-busy', 'true'));

    resolve({ ok: true });
    expect(await screen.findByText(/^connected$/i)).toBeInTheDocument();
  });

  it('test connection shows the sanitized error inline on failure', async () => {
    seedDatabase();
    const user = userEvent.setup();
    const { api } = createMockApi({
      post: async () => ({ ok: false, error: 'Connection refused.' }),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^database$/i });

    await user.click(screen.getByRole('radio', { name: /external database/i }));
    await user.type(screen.getByLabelText(/connection url/i), 'postgresql://u:p@host:5432/db');
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/connection refused/i)).toBeInTheDocument();
  });

  it('external mode posts {mode, url} and advances', async () => {
    seedDatabase();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^database$/i });

    await user.click(screen.getByRole('radio', { name: /external database/i }));
    await user.type(screen.getByLabelText(/connection url/i), 'postgresql://u:p@host:5432/db');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/setup/v1/database/configure', {
        mode: 'external',
        url: 'postgresql://u:p@host:5432/db',
      }),
    );
    expect((await screen.findAllByText(/step 4 of 11/i)).length).toBeGreaterThan(0);
  });
});
