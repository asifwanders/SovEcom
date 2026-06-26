import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const fetchProductBySlug = vi.fn();
vi.mock('@/lib/catalog', () => ({
  fetchProductBySlug: (...a: unknown[]) => fetchProductBySlug(...a),
}));

// The page now composes its body from the `product` template via the section runtime, which reads the
// active theme NAME to pick the template-set. Stub it to null → the bundled `default` set.
vi.mock('@/lib/theme', () => ({
  fetchActiveTheme: vi.fn(async () => null),
}));

// The PDP now hosts the interactive <VariantSelector> island, which renders
// <AddToCartButton> calling useCart(). Stub useCart so the island mounts without a real CartProvider.
const addItem = vi.fn<(variantId: string, quantity: number) => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ addItem }),
}));

// notFound() throws a sentinel we can assert on (mirrors Next's control-flow throw). Keep the rest of
// next/navigation REAL via importOriginal — the PDP now renders <Breadcrumbs>, which pulls in
// next-intl's createNavigation (via @/i18n/navigation); that needs `redirect`/`permanentRedirect` to
// exist at module load.
const NOT_FOUND = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: () => {
    throw NOT_FOUND;
  },
}));

// The PDP renders async `<Slot>`s (reviews/actions). An async component can't be
// rendered by the sync test render; mock it to a no-op so these PAGE specs stay focused on the section
// composition + JSON-LD (the Slot runtime has its own dedicated specs).
vi.mock('@/components/Slot', () => ({ Slot: () => null }));

import ProductDetailPage from './page';

function props(slug: string, locale: 'en' | 'fr' = 'en') {
  return { params: Promise.resolve({ locale, slug }) };
}

function fullProduct() {
  return {
    id: 'p1',
    slug: 'tee',
    title: 'Cotton Tee',
    description: 'Soft organic cotton.',
    variants: [
      {
        id: 'v1',
        title: 'Small',
        options: { size: 'S' },
        priceAmount: 2500,
        currency: 'EUR',
        availability: true,
      },
      {
        id: 'v2',
        title: 'Large',
        options: { size: 'L' },
        priceAmount: 1999,
        currency: 'EUR',
        availability: false,
      },
    ],
    images: [
      { thumbnailUrl: 'https://cdn/tee-1.jpg', altText: 'Front' },
      { thumbnailUrl: 'https://cdn/tee-2.jpg', altText: null },
    ],
  };
}

beforeEach(() => {
  fetchProductBySlug.mockReset();
  addItem.mockReset();
  addItem.mockResolvedValue();
});

describe('ProductDetailPage', () => {
  it('renders the title, description and the interactive variant selector', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    renderWithIntl(await ProductDetailPage(props('tee')), 'en');

    expect(screen.getByRole('heading', { level: 1, name: 'Cotton Tee' })).toBeInTheDocument();
    expect(screen.getByText('Soft organic cotton.')).toBeInTheDocument();
    // The interactive selector exposes the `size` option axis (values S/L) as a <select>.
    const select = screen.getByRole('combobox', { name: /size/i });
    expect(select).toBeInTheDocument();
    // Choosing the in-stock Small variant surfaces ITS price (server minor units → €25.00).
    fireEvent.change(select, { target: { value: 'S' } });
    expect(screen.getByText(/25[.,]00/)).toBeInTheDocument();
  });

  it('adds the selected variant to the cart via useCart().addItem', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    renderWithIntl(await ProductDetailPage(props('tee')), 'en');
    fireEvent.change(screen.getByRole('combobox', { name: /size/i }), { target: { value: 'S' } });
    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    expect(addItem).toHaveBeenCalledWith('v1', 1);
  });

  it('renders the image gallery from images[].thumbnailUrl', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    renderWithIntl(await ProductDetailPage(props('tee')), 'en');
    const imgs = screen.getAllByRole('img');
    const srcs = imgs.map((i) => i.getAttribute('src'));
    expect(srcs).toContain('https://cdn/tee-1.jpg');
    expect(srcs).toContain('https://cdn/tee-2.jpg');
  });

  it('calls notFound() for an unknown slug (fetch returns null)', async () => {
    fetchProductBySlug.mockResolvedValue(null);
    await expect(ProductDetailPage(props('nope'))).rejects.toBe(NOT_FOUND);
  });

  it('renders gracefully when description/images/variants are missing', async () => {
    fetchProductBySlug.mockResolvedValue({
      id: 'p2',
      slug: 'bare',
      title: 'Bare Product',
      description: null,
      variants: [],
      images: [],
    });
    renderWithIntl(await ProductDetailPage(props('bare')), 'en');
    expect(screen.getByRole('heading', { level: 1, name: 'Bare Product' })).toBeInTheDocument();
    // No image → placeholder; no crash.
    expect(screen.getByText('No image')).toBeInTheDocument();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('renders an add-to-cart control (the PDP is now transactional)', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    renderWithIntl(await ProductDetailPage(props('tee')), 'en');
    // Before a variant is chosen the add control is present but disabled (labelled out-of-stock).
    expect(screen.queryByRole('button', { name: /add to cart/i })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: /size/i }), { target: { value: 'S' } });
    expect(screen.getByRole('button', { name: /add to cart/i })).not.toBeDisabled();
  });

  it('emits BOTH structured-data blocks (Product/Offer + BreadcrumbList JSON-LD)', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    const { container } = renderWithIntl(await ProductDetailPage(props('tee')), 'en');
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(2);
    const payloads = Array.from(scripts).map((s) => s.textContent ?? '');
    // One Product/Offer graph and one BreadcrumbList — both present, page-level (not inside a section).
    expect(payloads.some((p) => p.includes('"@type":"Product"'))).toBe(true);
    expect(payloads.some((p) => p.includes('"@type":"BreadcrumbList"'))).toBe(true);
  });

  it('composes breadcrumbs + the granular gallery/info/variant sections with identical DOM', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    const { container } = renderWithIntl(await ProductDetailPage(props('tee')), 'en');
    // Breadcrumbs section: Home + Products links (next-intl prefixes the active locale), product title
    // as the current crumb.
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/en');
    expect(screen.getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/en/products');
    // The PDP `columns` layout emits the verbatim 2-column grid (left region bare gallery; right region
    // wrapped in the `space-y-6` cell). NO results-column wrapper (`min-w-0 flex-1`).
    const grid = container.querySelector('div.grid.grid-cols-1.md\\:grid-cols-2.gap-8')!;
    expect(grid).not.toBeNull();
    expect(container.querySelector('div.min-w-0.flex-1')).toBeNull();
    // The grid has EXACTLY 2 direct element children — the gallery cell and the `space-y-6`
    // right cell. A VariantSelector leaking out of the right cell as a 3rd grid child fails.
    expect(grid.children).toHaveLength(2);
    // The right cell is the verbatim `space-y-6` wrapper holding the h1 (parity classes) + prose AND the
    // variant selector as a DESCENDANT (not a sibling of the cell) — so the selector keeps its 1.5rem gap.
    const rightCell = grid.children[1] as HTMLElement;
    expect(rightCell.classList.contains('space-y-6')).toBe(true);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Cotton Tee' });
    expect(h1).toHaveClass('text-3xl', 'font-bold', 'text-foreground');
    expect(rightCell.contains(h1)).toBe(true);
    expect(rightCell.querySelector('div.prose.prose-sm.max-w-none.text-foreground')).not.toBeNull();
    // The variant selector (its <select>) is a DESCENDANT of the `space-y-6` right cell.
    const select = screen.getByRole('combobox', { name: /size/i });
    expect(rightCell.contains(select)).toBe(true);
    // The gallery island (left region) is present and is NOT inside the right cell.
    const imgs = screen.getAllByRole('img');
    expect(imgs.length).toBeGreaterThan(0);
    expect(rightCell.contains(imgs[0]!)).toBe(false);
  });

  it('fetches the product by slug (wired through the guard + section loaders)', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    await ProductDetailPage(props('tee'));
    // Every call resolves the SAME slug; under Next the `cache()`-wrapped fetch dedups these to one
    // round-trip per render pass (React `cache()` is inert outside a request scope, so the call-count
    // is not asserted here — see catalog.spec for the wrapping; deviation noted in the report).
    expect(fetchProductBySlug).toHaveBeenCalledWith('tee');
  });

  it('localizes the chrome (add-to-cart / stock labels) in French; DATA stays single-language', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    renderWithIntl(await ProductDetailPage(props('tee', 'fr')), 'fr');
    // Select the in-stock variant → French chrome (price + availability + add button).
    fireEvent.change(screen.getByRole('combobox', { name: /size/i }), { target: { value: 'S' } });
    expect(screen.getByText('En stock')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ajouter au panier/i })).toBeInTheDocument();
    // Product DATA (title) is untouched; catalog localization is out of scope.
    expect(screen.getByRole('heading', { level: 1, name: 'Cotton Tee' })).toBeInTheDocument();
  });
});
