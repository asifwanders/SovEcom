import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProductFormPage from './product-form';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

// The REAL GET /admin/v1/products/:id response: it returns `variants` and
// `images` but NOT `categories`/`tags` (see products.repository.ts findById).
const PRODUCT = {
  id: 'p1',
  title: 'Test Shirt',
  slug: 'test-shirt',
  description: 'A shirt',
  status: 'draft',
  seoTitle: null,
  seoDescription: null,
  variants: [
    {
      id: 'v1',
      sku: 'S1',
      title: 'Small',
      priceAmount: 1999,
      currency: 'eur',
      stockQuantity: 10,
      allowBackorder: false,
      position: 0,
    },
  ],
  images: [],
  // NOTE: categories and tags are intentionally absent — the API omits them.
};

function mockByPath(overrides: Record<string, unknown> = {}) {
  vi.mocked(apiFetch).mockImplementation((path: string) => {
    if (path === '/admin/v1/products/p1') return Promise.resolve(PRODUCT);
    if (path === '/admin/v1/categories') return Promise.resolve([]);
    if (path === '/admin/v1/tags') return Promise.resolve([]);
    const o = overrides[path];
    if (o instanceof Error) return Promise.reject(o);
    return Promise.resolve(o ?? {});
  });
}

function renderEdit() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/products/p1/edit']}>
        <Routes>
          <Route path="/products/:id/edit" element={<ProductFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProductFormPage (edit)', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('renders and populates the form when the API omits categories/tags (no blank-page crash)', async () => {
    mockByPath();
    renderEdit();

    // Form must populate from the loaded product — proves the reset effect ran
    // without throwing on the absent categories/tags arrays.
    await waitFor(() => {
      expect(screen.getByDisplayValue('Test Shirt')).toBeInTheDocument();
    });
    // Heading proves the page rendered (not blank).
    expect(screen.getByRole('heading', { name: 'Edit product' })).toBeInTheDocument();
    // The variant from the product is shown, and currency was upper-cased.
    expect(screen.getByDisplayValue('S1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('EUR')).toBeInTheDocument();
  });

  it('shows a loading state while the product is being fetched (never blank)', async () => {
    // Hold the product fetch open so the component stays in its loading branch;
    // resolve it at the end so React Query settles cleanly (no leaked pending work).
    let resolveProduct!: (v: unknown) => void;
    const pending = new Promise((res) => {
      resolveProduct = res;
    });
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path === '/admin/v1/products/p1') return pending;
      return Promise.resolve([]);
    });
    renderEdit();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    resolveProduct(PRODUCT);
    await waitFor(() => expect(screen.getByDisplayValue('Test Shirt')).toBeInTheDocument());
  });

  it('shows an error state when the product fetch fails', async () => {
    mockByPath({ '/admin/v1/products/p1': new Error('boom') });
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path === '/admin/v1/products/p1') return Promise.reject(new Error('boom'));
      return Promise.resolve([]);
    });
    renderEdit();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('saves WITHOUT putting variants on the product PATCH (BUG-1 regression)', async () => {
    // Capture every apiFetch call so we can assert the PATCH body shape.
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.mocked(apiFetch).mockImplementation((path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === '/admin/v1/products/p1') return Promise.resolve(PRODUCT);
      if (path === '/admin/v1/categories') return Promise.resolve([]);
      if (path === '/admin/v1/tags') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderEdit();
    await waitFor(() => expect(screen.getByDisplayValue('Test Shirt')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // The product PATCH must have fired with a body that excludes `variants`.
    const patch = await waitFor(() => {
      const c = calls.find((x) => x.path === '/admin/v1/products/p1' && x.init?.method === 'PATCH');
      expect(c).toBeTruthy();
      return c!;
    });
    const body = JSON.parse(patch.init!.body as string);
    expect(body).not.toHaveProperty('variants');
    expect(body.title).toBe('Test Shirt');
    expect(body.status).toBe('draft');

    // The unchanged variant must NOT trigger a variant sub-resource call (diff = no-op).
    expect(
      calls.some(
        (c) => c.path === '/admin/v1/products/p1/variants/v1' && c.init?.method === 'PATCH',
      ),
    ).toBe(false);
  });

  it('PATCHes a changed variant via the sub-resource, not the product body', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.mocked(apiFetch).mockImplementation((path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === '/admin/v1/products/p1') return Promise.resolve(PRODUCT);
      if (path === '/admin/v1/categories') return Promise.resolve([]);
      if (path === '/admin/v1/tags') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderEdit();
    await waitFor(() => expect(screen.getByDisplayValue('S1')).toBeInTheDocument());

    // Change the SKU of the loaded variant.
    fireEvent.change(screen.getByDisplayValue('S1'), { target: { value: 'S1-NEW' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const variantPatch = await waitFor(() => {
      const c = calls.find(
        (x) => x.path === '/admin/v1/products/p1/variants/v1' && x.init?.method === 'PATCH',
      );
      expect(c).toBeTruthy();
      return c!;
    });
    const body = JSON.parse(variantPatch.init!.body as string);
    expect(body.sku).toBe('S1-NEW');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('_stableKey');
    // currency travels with priceAmount per the variant DTO contract.
    expect(body.currency).toBe('EUR');
  });
});
