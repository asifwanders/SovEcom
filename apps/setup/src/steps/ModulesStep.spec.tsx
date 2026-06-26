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

/** Seed progress directly onto the Modules step (index 8) with a live token. */
function seedModules() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 8, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

/** A two-module catalog: one not-installed (toggleable), one already installed (fixed). */
function catalog() {
  return {
    modules: [
      {
        id: 'reviews',
        name: 'reviews',
        displayName: 'Product reviews',
        description: 'Star ratings and written reviews on product pages.',
        permissions: ['write:own_tables', 'read:products'],
        slots: [{ slot: 'product-detail-reviews-section', component: 'review-list' }],
        installed: false,
      },
      {
        id: 'wishlist',
        name: 'wishlist',
        displayName: 'Wishlist',
        description: 'Let customers save products for later.',
        permissions: ['read:products'],
        slots: [{ slot: 'product-card-actions', component: 'toggle-button' }],
        installed: true,
      },
    ],
  };
}

describe('ModulesStep', () => {
  it('lists the built-in catalog with display names, descriptions and an Installed badge', async () => {
    seedModules();
    const { api, get } = createMockApi({ get: async () => catalog() });
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /^modules$/i })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/setup/v1/modules');
    expect(await screen.findByText(/product reviews/i)).toBeInTheDocument();
    expect(screen.getByText(/star ratings and written reviews/i)).toBeInTheDocument();
    // The already-installed module shows an Installed badge.
    expect(screen.getByText(/^installed$/i)).toBeInTheDocument();
    // Surfaces what it touches (slots + permissions) so the operator sees the impact.
    expect(screen.getByText(/product-detail-reviews-section/i)).toBeInTheDocument();
    expect(screen.getByText(/write:own_tables/i)).toBeInTheDocument();
  });

  it('an already-installed module is checked + disabled (fixed state)', async () => {
    seedModules();
    const { api } = createMockApi({ get: async () => catalog() });
    render(<App api={api} />);

    await screen.findByText(/wishlist/i);
    // wishlist (installed) is checked + disabled (its state is fixed).
    const wishlistBox = screen.getByRole('checkbox', { name: /wishlist/i }) as HTMLInputElement;
    expect(wishlistBox.checked).toBe(true);
    expect(wishlistBox.disabled).toBe(true);
  });

  it('Continue installs ONLY the newly-selected modules and advances', async () => {
    seedModules();
    const user = userEvent.setup();
    const { api, post } = createMockApi({ get: async () => catalog() });
    render(<App api={api} />);

    await screen.findByText(/product reviews/i);
    // Select the not-installed `reviews` module (its label wraps the checkbox).
    await user.click(screen.getByRole('checkbox', { name: /product reviews/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/setup/v1/modules/install', { moduleIds: ['reviews'] });
    expect((await screen.findAllByText(/step 10 of 11/i)).length).toBeGreaterThan(0);
  });

  it('Skip installs nothing and advances (optional step)', async () => {
    seedModules();
    const user = userEvent.setup();
    const { api, post } = createMockApi({ get: async () => catalog() });
    render(<App api={api} />);

    await screen.findByText(/product reviews/i);
    await user.click(screen.getByRole('button', { name: /^skip$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/setup/v1/modules/install', { moduleIds: [] });
    expect((await screen.findAllByText(/step 10 of 11/i)).length).toBeGreaterThan(0);
  });

  it('Continue with no selection posts an empty install and advances', async () => {
    seedModules();
    const user = userEvent.setup();
    const { api, post } = createMockApi({ get: async () => catalog() });
    render(<App api={api} />);

    await screen.findByText(/product reviews/i);
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/setup/v1/modules/install', { moduleIds: [] });
  });

  it('shows an honest empty-state when the catalog is empty', async () => {
    seedModules();
    const { api } = createMockApi({ get: async () => ({ modules: [] }) });
    render(<App api={api} />);

    expect(await screen.findByText(/no modules to install yet/i)).toBeInTheDocument();
  });

  it('surfaces a server-reported failure inline and does NOT advance (S1)', async () => {
    seedModules();
    const user = userEvent.setup();
    // The install POST reports `reviews` as FAILED — the step must show it, not claim success.
    const { api, post } = createMockApi({
      get: async () => catalog(),
      post: async () => ({ ok: true, installed: [], failed: ['reviews'] }),
    });
    render(<App api={api} />);

    await screen.findByText(/product reviews/i);
    await user.click(screen.getByRole('checkbox', { name: /product reviews/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    // The failed module is named in an inline error (by display name), and we stayed on Modules.
    expect(await screen.findByText(/couldn’t be installed.*product reviews/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^modules$/i })).toBeInTheDocument();
    // Did NOT advance to the next step.
    expect(screen.queryByText(/step 10 of 11/i)).not.toBeInTheDocument();
  });
});
