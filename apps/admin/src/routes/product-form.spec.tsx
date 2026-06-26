import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
});
