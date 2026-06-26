/**
 * C3 — `product-card-actions` activation tests.
 *
 * `productCardActions(product)` returns the async `<Slot name="product-card-actions" route={id}>` RSC.
 * These tests drive it through the REAL `Slot` (mocking only the two data fetches it depends on) to
 * prove the activation end-to-end at the card level:
 *   - when wishlist binds the slot (personalized `toggle-button`), the per-card slot resolves the
 *     binding → renders the C2 client-island SHELL (no server fetch of per-customer state);
 *   - when NO module binds the slot (the CI default), it renders NOTHING — the card/page is intact;
 *   - when the slot map is unreachable (a down module / cold API), it renders NOTHING — fail closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import type { SlotMap } from '@sovecom/theme-sdk';

// The personalized (toggle-button) path renders a CLIENT ISLAND that fetches its OWN data — the server
// fetch must NEVER run for it. Mock both data sources the Slot depends on.
const fetchSlotWidget = vi.fn();
vi.mock('@/lib/widgets/fetchSlotWidget', () => ({
  fetchSlotWidget: (...a: unknown[]) => fetchSlotWidget(...a),
  WIDGET_FETCH_MAX_BYTES: 65536,
}));
const fetchSlots = vi.fn();
vi.mock('@/lib/widgets/fetchSlots', () => ({
  fetchSlots: () => fetchSlots(),
}));
// The personalized island calls `useAuth()` (for the Bearer header) — mock it so no <AuthProvider> is
// needed (guest: no token → no Authorization header; the island shell still mounts).
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ getAccessToken: () => null }),
}));

import type { ReactElement } from 'react';
import { productCardActions } from './cardActions';
import type { ProductCardView } from '@/lib/catalog';

function product(overrides: Partial<ProductCardView> = {}): ProductCardView {
  return {
    id: 'p1',
    slug: 'tee',
    title: 'Cotton Tee',
    thumbnailUrl: null,
    priceAmount: 2500,
    currency: 'EUR',
    ...overrides,
  };
}

/**
 * `productCardActions(p)` returns a `<Slot>` ELEMENT (an async server component). RTL does not resolve
 * async server components, so — mirroring the page specs that `await SomePage(...)` — we invoke the
 * Slot's async function with its props and render the resolved node.
 */
async function renderActions(p: ProductCardView) {
  const element = productCardActions(p) as ReactElement<{ name: string; route: string }>;
  const SlotFn = element.type as (props: {
    name: string;
    route: string;
  }) => Promise<React.ReactNode>;
  const resolved = await SlotFn(element.props);
  return render(<>{resolved}</>);
}

beforeEach(() => {
  fetchSlotWidget.mockReset();
  fetchSlots.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('productCardActions — per-card product-card-actions slot', () => {
  it('renders the wishlist client-island SHELL (route=product.id) WITHOUT a server fetch', async () => {
    fetchSlots.mockResolvedValue({
      'product-card-actions': { module: 'wishlist', component: 'toggle-button' },
    } as SlotMap);
    const { container } = await renderActions(product({ id: 'prod-42' }));
    const island = container.querySelector('[data-slot-island]');
    expect(island).not.toBeNull();
    expect(island?.getAttribute('data-module')).toBe('wishlist');
    expect(island?.getAttribute('data-slot')).toBe('product-card-actions');
    // route carries the PRODUCT ID (C3) — the wishlist toggle keys add/remove on it.
    expect(island?.getAttribute('data-route')).toBe('prod-42');
    // Personalized state is NEVER server-fetched (would leak into an ISR cache).
    expect(fetchSlotWidget).not.toHaveBeenCalled();
  });

  it('renders NOTHING when no module binds the slot (CI default — card/page intact)', async () => {
    fetchSlots.mockResolvedValue({} as SlotMap);
    const { container } = await renderActions(product());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders NOTHING when the slot map is unreachable (down module / cold API — fail closed)', async () => {
    fetchSlots.mockResolvedValue(null);
    const { container } = await renderActions(product());
    expect(container).toBeEmptyDOMElement();
  });
});
