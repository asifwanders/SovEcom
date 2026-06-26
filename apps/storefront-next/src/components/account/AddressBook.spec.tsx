/**
 * AddressBook component tests.
 *
 * Mirrors the pattern of OrdersList.spec.tsx:
 *   - vi.mock('@/lib/auth-context') returning { getAccessToken, refresh }
 *   - vi.mock('@/lib/browser-client') returning a fake { request }
 *   - renderWithIntl from @/test-intl
 *
 * Uses only @testing-library/react (fireEvent, waitFor) — no user-event package in this repo.
 *
 * Covers: list render, Default badge, empty state, create→refetch, edit→refetch,
 * delete confirm→delete→refetch, 401→refresh→retry, 401→refresh-rejects→error,
 * network/500 error banner, FR render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { SavedAddress } from '@/lib/auth-context';

// --- Auth mock ---
let getAccessToken: () => string | null = () => 'token-abc';
let refresh: () => Promise<string | null> = async () => 'token-abc';
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ getAccessToken, refresh }),
}));

// --- Browser client mock ---
let mockRequest: (method: string, path: string, opts?: unknown) => Promise<unknown>;
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({
    request: (...args: unknown[]) => mockRequest(...(args as [string, string, unknown])),
  }),
}));

import { AddressBook } from './AddressBook';

const ADDR_SHIP: SavedAddress = {
  id: 'ship-1',
  type: 'shipping',
  isDefault: true,
  name: 'Ada Lovelace',
  company: null,
  line1: '123 Rue de la Paix',
  line2: null,
  city: 'Paris',
  postalCode: '75001',
  region: null,
  country: 'FR',
  phone: null,
};

const ADDR_BILL: SavedAddress = {
  id: 'bill-1',
  type: 'billing',
  isDefault: false,
  name: 'Ada Lovelace',
  company: 'Analytical Engines',
  line1: '1 Charles St',
  line2: null,
  city: 'Berlin',
  postalCode: '10115',
  region: null,
  country: 'DE',
  phone: null,
};

beforeEach(() => {
  getAccessToken = () => 'token-abc';
  refresh = async () => 'token-abc';
  // Default: GET /store/v1/customers/me/addresses returns both addresses
  mockRequest = async (method, path) => {
    if (method === 'get' && path === '/store/v1/customers/me/addresses') {
      return [ADDR_SHIP, ADDR_BILL];
    }
    return undefined;
  };
});

describe('AddressBook — list rendering', () => {
  it('renders address cards for both addresses', async () => {
    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(2));
    expect(screen.getAllByText('Ada Lovelace')).toHaveLength(2);
    expect(screen.getByText('123 Rue de la Paix')).toBeInTheDocument();
    expect(screen.getByText('1 Charles St')).toBeInTheDocument();
  });

  it('shows the Default badge on the default address only', async () => {
    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(2));
    const badges = screen.getAllByTestId('default-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Default');
  });

  it('renders the FR UI correctly', async () => {
    renderWithIntl(<AddressBook />, 'fr');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(2));
    expect(screen.getByText('Par défaut')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ajouter une adresse/i })).toBeInTheDocument();
  });
});

describe('AddressBook — loading state', () => {
  it('shows the loading text (not the error text) while the list is fetching', () => {
    // A never-resolving request keeps the component in the loading branch.
    mockRequest = () => new Promise<unknown>(() => undefined);
    renderWithIntl(<AddressBook />, 'en');
    const loading = screen.getByTestId('addresses-loading');
    expect(loading).toHaveTextContent(/loading your addresses/i);
    // It must NOT show the load-error wording during a normal fetch.
    expect(loading).not.toHaveTextContent(/could not load/i);
  });

  it('shows the FR loading text while the list is fetching', () => {
    mockRequest = () => new Promise<unknown>(() => undefined);
    renderWithIntl(<AddressBook />, 'fr');
    expect(screen.getByTestId('addresses-loading')).toHaveTextContent(
      /chargement de vos adresses/i,
    );
  });
});

describe('AddressBook — empty state', () => {
  it('shows the empty message when no addresses exist', async () => {
    mockRequest = async () => [];
    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getByTestId('addresses-empty')).toBeInTheDocument());
  });
});

describe('AddressBook — create flow', () => {
  it('opens the form when Add address is clicked, and refetches after create', async () => {
    let listCallCount = 0;
    const createdAddr: SavedAddress = { ...ADDR_SHIP, id: 'new-1', name: 'New User' };

    mockRequest = vi.fn().mockImplementation(async (method: string, path: string) => {
      if (method === 'get' && path === '/store/v1/customers/me/addresses') {
        listCallCount++;
        if (listCallCount === 1) return [ADDR_SHIP];
        return [ADDR_SHIP, createdAddr];
      }
      if (method === 'post' && path === '/store/v1/customers/me/addresses') {
        return createdAddr;
      }
      return undefined;
    });

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(1));

    // Open the form
    act(() => fireEvent.click(screen.getByRole('button', { name: /add address/i })));
    expect(screen.getByRole('combobox', { name: /address type/i })).toBeInTheDocument();

    // Fill the form
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'New User' } });
    fireEvent.change(screen.getByLabelText(/address line 1/i), { target: { value: '1 New St' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Lyon' } });
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '69001' } });
    fireEvent.change(screen.getByRole('combobox', { name: /country/i }), {
      target: { value: 'FR' },
    });

    const form = screen.getByRole('button', { name: /save address/i }).closest('form')!;
    act(() => fireEvent.submit(form));

    // After create, the list is refetched and shows 2 cards
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(2));
    expect(listCallCount).toBe(2);
  });
});

describe('AddressBook — edit flow', () => {
  it('opens prefilled form on Edit and refetches after update', async () => {
    let listCallCount = 0;
    const updatedAddr: SavedAddress = { ...ADDR_SHIP, name: 'Charles Babbage' };

    mockRequest = vi.fn().mockImplementation(async (method: string, path: string) => {
      if (method === 'get' && path === '/store/v1/customers/me/addresses') {
        listCallCount++;
        if (listCallCount === 1) return [ADDR_SHIP];
        return [updatedAddr];
      }
      if (method === 'patch' && path === '/store/v1/customers/me/addresses/{id}') {
        return updatedAddr;
      }
      return undefined;
    });

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(1));

    // Click Edit on the first (only) card
    act(() => fireEvent.click(screen.getByRole('button', { name: /^edit$/i })));

    // Form should be prefilled
    await waitFor(() => {
      expect(screen.getByLabelText(/full name/i)).toHaveValue('Ada Lovelace');
    });

    // Update name
    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: 'Charles Babbage' },
    });

    const form = screen.getByRole('button', { name: /save address/i }).closest('form')!;
    act(() => fireEvent.submit(form));

    await waitFor(() => expect(screen.getByText('Charles Babbage')).toBeInTheDocument());
    expect(listCallCount).toBe(2);
  });
});

describe('AddressBook — delete flow', () => {
  it('shows confirm step on Delete, then deletes and refetches', async () => {
    let listCallCount = 0;

    mockRequest = vi.fn().mockImplementation(async (method: string, path: string) => {
      if (method === 'get' && path === '/store/v1/customers/me/addresses') {
        listCallCount++;
        if (listCallCount === 1) return [ADDR_SHIP];
        return [];
      }
      if (method === 'delete' && path === '/store/v1/customers/me/addresses/{id}') {
        return undefined;
      }
      return undefined;
    });

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(1));

    // Click Delete — confirm step should appear
    act(() => fireEvent.click(screen.getByRole('button', { name: /^delete$/i })));
    expect(screen.getByTestId('delete-confirm')).toBeInTheDocument();
    expect(screen.getByText(/delete this address\?/i)).toBeInTheDocument();

    // Click Confirm delete
    act(() => fireEvent.click(screen.getByRole('button', { name: /confirm delete/i })));

    // After delete, list is refetched → empty state
    await waitFor(() => expect(screen.getByTestId('addresses-empty')).toBeInTheDocument());
    expect(listCallCount).toBe(2);
  });

  it('cancels the delete confirm step without calling DELETE', async () => {
    let deleteCalled = false;

    mockRequest = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'get') return [ADDR_SHIP];
      if (method === 'delete') {
        deleteCalled = true;
        return undefined;
      }
      return undefined;
    });

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(1));

    act(() => fireEvent.click(screen.getByRole('button', { name: /^delete$/i })));
    expect(screen.getByTestId('delete-confirm')).toBeInTheDocument();

    act(() => fireEvent.click(screen.getByRole('button', { name: /^cancel$/i })));
    expect(screen.queryByTestId('delete-confirm')).not.toBeInTheDocument();
    expect(deleteCalled).toBe(false);
  });

  it('shows the delete-error message (not the save-error message) when DELETE fails', async () => {
    mockRequest = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'get') return [ADDR_SHIP];
      if (method === 'delete') {
        throw new Error('500 Internal Server Error');
      }
      return undefined;
    });

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(1));

    act(() => fireEvent.click(screen.getByRole('button', { name: /^delete$/i })));
    act(() => fireEvent.click(screen.getByRole('button', { name: /confirm delete/i })));

    // The error banner must carry the DELETE wording, not the save wording.
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/could not delete the address/i);
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent(/could not save/i);
  });
});

describe('AddressBook — 401 refresh retry', () => {
  it('retries the list fetch with refresh() on a 401 and renders successfully', async () => {
    let calls = 0;
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;

    mockRequest = async (method: string) => {
      if (method === 'get') {
        calls++;
        if (calls === 1) {
          const err = Object.assign(new Error('Unauthorized'), { status: 401 });
          throw err;
        }
        return [ADDR_SHIP];
      }
      return undefined;
    };

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getAllByTestId('address-card')).toHaveLength(1));
    expect(refreshFn).toHaveBeenCalledOnce();
  });

  it('shows error state if still 401 after refresh() (refresh returns null)', async () => {
    refresh = vi.fn().mockResolvedValue(null);
    // Every request throws 401
    mockRequest = async () => {
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      throw err;
    };

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getByTestId('addresses-error')).toBeInTheDocument());
  });

  it('shows error state (not stuck loading) when refresh() THROWS during a 401 retry', async () => {
    // refresh() re-throws network/5xx errors per auth-context — the retry must catch so we land on
    // error state instead of spinning forever.
    refresh = vi.fn().mockRejectedValue(new Error('network down'));
    mockRequest = async () => {
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      throw err;
    };

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getByTestId('addresses-error')).toBeInTheDocument());
    expect(screen.queryByTestId('addresses-loading')).not.toBeInTheDocument();
  });
});

describe('AddressBook — network / server error', () => {
  it('shows error banner on initial load failure (non-401)', async () => {
    mockRequest = async () => {
      throw new Error('500 Internal Server Error');
    };

    renderWithIntl(<AddressBook />, 'en');
    await waitFor(() => expect(screen.getByTestId('addresses-error')).toBeInTheDocument());
  });
});
