import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { setRequestLocale } from 'next-intl/server';
import { renderWithIntl } from '@/test-intl';
import type { CategoryView } from '@/lib/catalog';

const fetchCategoryTree = vi.fn<() => Promise<CategoryView[]>>();
vi.mock('@/lib/catalog', () => ({
  fetchCategoryTree: () => fetchCategoryTree(),
}));

// Locale-aware Link → plain anchor so hrefs are assertable.
vi.mock('@/i18n/navigation', () => ({
  // The Header hosts the client SearchBar, which calls useRouter() — stub it so the island mounts.
  useRouter: () => ({ push: vi.fn() }),
  Link: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

// The cart context — the Header now hosts the CartBadge client island. Stub
// useCart so the island mounts without a real CartProvider; default to an empty cart.
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ itemCount: 0 }),
}));

// The cart badge now OPENS THE DRAWER via useCartUi — stub it so the island mounts.
vi.mock('@/lib/cart-ui-context', () => ({
  useCartUi: () => ({ open: vi.fn() }),
}));

// The Header now hosts the AccountLink client island → drive useAuth per test.
let authState: { isAuthenticated: boolean; isLoading: boolean };
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => authState,
}));

import { Header } from './Header';

const tree: CategoryView[] = [
  { id: 'c1', slug: 'apparel', name: 'Apparel', parentId: null, children: [] },
];

beforeEach(() => {
  fetchCategoryTree.mockReset();
  fetchCategoryTree.mockResolvedValue(tree);
  // Default to a resolved guest session so the AccountLink renders its sign-in affordance.
  authState = { isAuthenticated: false, isLoading: false };
  // The Header's server labels resolve against the global test-setup request-locale; default to EN.
  setRequestLocale('en');
});

describe('Header', () => {
  it('server-fetches the category tree and hosts the CategoryNav (EN)', async () => {
    const ui = await Header({});
    renderWithIntl(ui, 'en');
    expect(fetchCategoryTree).toHaveBeenCalledTimes(1);
    // CategoryNav present (its labelled <nav>).
    expect(screen.getByRole('navigation', { name: 'Category navigation' })).toBeInTheDocument();
    // Existing flat links retained.
    expect(screen.getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/products');
    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', '/search');
  });

  it('renders the brand logo image when a logoUrl is provided', async () => {
    const ui = await Header({ logoUrl: 'https://cdn.example.com/logo.png' });
    renderWithIntl(ui, 'en');
    const img = screen.getByRole('img', { name: 'SovEcom' });
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/logo.png');
    // S4: explicit width/height (CLS reserve) + lazy/async.
    expect(img).toHaveAttribute('width');
    expect(img).toHaveAttribute('height');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
  });

  it('renders the cart badge as a drawer-opening button', async () => {
    const ui = await Header({});
    renderWithIntl(ui, 'en');
    const cartButton = screen.getByRole('button', { name: /cart/i });
    expect(cartButton).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('renders a sign-in account control for a guest', async () => {
    authState = { isAuthenticated: false, isLoading: false };
    const ui = await Header({});
    renderWithIntl(ui, 'en');
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('link', { name: /^account$/i })).toBeNull();
  });

  it('renders an account-area link for a signed-in customer', async () => {
    authState = { isAuthenticated: true, isLoading: false };
    const ui = await Header({});
    renderWithIntl(ui, 'en');
    expect(screen.getByRole('link', { name: /^account$/i })).toHaveAttribute('href', '/account');
  });

  it('renders no account control until the session resolves (no guest flash)', async () => {
    authState = { isAuthenticated: false, isLoading: true };
    const ui = await Header({});
    renderWithIntl(ui, 'en');
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /^account$/i })).toBeNull();
  });

  it('localizes the flat nav links in French', async () => {
    setRequestLocale('fr');
    const ui = await Header({});
    renderWithIntl(ui, 'fr');
    expect(screen.getByRole('link', { name: 'Produits' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rechercher' })).toBeInTheDocument();
  });

  it('still renders the header when the category tree is empty', async () => {
    fetchCategoryTree.mockResolvedValue([]);
    const ui = await Header({});
    const { container } = renderWithIntl(ui, 'en');
    expect(
      within(container).getByRole('navigation', { name: 'Category navigation' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Products' })).toBeInTheDocument();
  });
});
