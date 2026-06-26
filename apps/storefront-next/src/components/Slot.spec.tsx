import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import type { WidgetDescriptor, SlotMap } from '@sovecom/theme-sdk';

// The Slot RSC server-fetches a personalized:false widget's data via fetchSlotWidget. Mock it so
// each test controls what the module "returns" without a network. The personalized:true path renders
// a CLIENT ISLAND that fetches its OWN data — so the server fetch must NEVER run for it.
const fetchSlotWidget = vi.fn();
vi.mock('@/lib/widgets/fetchSlotWidget', () => ({
  fetchSlotWidget: (...args: unknown[]) => fetchSlotWidget(...args),
  WIDGET_FETCH_MAX_BYTES: 65536,
}));

// fetchSlots is the cache()-wrapped GET /store/v1/slots read. Mock it so tests inject a SlotMap.
const fetchSlots = vi.fn();
vi.mock('@/lib/widgets/fetchSlots', () => ({
  fetchSlots: () => fetchSlots(),
}));

// The personalized island calls `useAuth()` (for the Bearer header). Mock it so the island mounts
// without an <AuthProvider> in these binding-resolution tests (guest: no token).
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ getAccessToken: () => null }),
}));

import { Slot } from './Slot';

const STAR: WidgetDescriptor = {
  type: 'star-rating-summary',
  props: { average: 4.4, count: 9 },
};

/** Render the async Slot RSC and return its container. */
async function renderSlot(props: { name: string; route?: string }) {
  const node = await Slot({ name: props.name, route: props.route ?? '/' });
  return render(<>{node}</>);
}

beforeEach(() => {
  fetchSlotWidget.mockReset();
  fetchSlots.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('Slot — binding resolution', () => {
  it('renders NOTHING when the slot is absent from the map (no binding)', async () => {
    fetchSlots.mockResolvedValue({} as SlotMap);
    const { container } = await renderSlot({ name: 'product-card-actions' });
    expect(container).toBeEmptyDOMElement();
    expect(fetchSlotWidget).not.toHaveBeenCalled();
  });

  it('renders NOTHING for an unknown / unregistered widget type (skip)', async () => {
    fetchSlots.mockResolvedValue({
      'product-card-actions': { module: 'evil', component: 'evil-widget' },
    } as SlotMap);
    const { container } = await renderSlot({ name: 'product-card-actions' });
    expect(container).toBeEmptyDOMElement();
    // Never even fetched — an unknown component short-circuits.
    expect(fetchSlotWidget).not.toHaveBeenCalled();
  });

  it('renders NOTHING when the slots fetch fails / returns null (fail closed)', async () => {
    fetchSlots.mockResolvedValue(null);
    const { container } = await renderSlot({ name: 'product-card-actions' });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Slot — read-only (personalized:false) server path', () => {
  it('server-fetches the descriptor and renders the matching component', async () => {
    fetchSlots.mockResolvedValue({
      'product-detail-reviews-section': { module: 'reviews', component: 'star-rating-summary' },
    } as SlotMap);
    fetchSlotWidget.mockResolvedValue(STAR);
    const { container } = await renderSlot({
      name: 'product-detail-reviews-section',
      route: '/product/tee',
    });
    expect(fetchSlotWidget).toHaveBeenCalledWith(
      'reviews',
      'product-detail-reviews-section',
      '/product/tee',
    );
    expect(container.textContent).toContain('4.4');
  });

  it('renders NOTHING when the server fetch returns null (module declined / failed)', async () => {
    fetchSlots.mockResolvedValue({
      'product-detail-reviews-section': { module: 'reviews', component: 'star-rating-summary' },
    } as SlotMap);
    fetchSlotWidget.mockResolvedValue(null);
    const { container } = await renderSlot({ name: 'product-detail-reviews-section' });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders NOTHING when the fetched descriptor type mismatches the binding component', async () => {
    // A module bound as star-rating-summary returns a review-list descriptor → refuse (defense:
    // the rendered component is pinned to the BINDING, not the descriptor's type).
    fetchSlots.mockResolvedValue({
      'product-detail-reviews-section': { module: 'reviews', component: 'star-rating-summary' },
    } as SlotMap);
    fetchSlotWidget.mockResolvedValue({ type: 'review-list', props: { items: [] } });
    const { container } = await renderSlot({ name: 'product-detail-reviews-section' });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Slot — personalized (personalized:true) client-island path', () => {
  it('renders the client island WITHOUT a server fetch (per-customer state never server-fetched)', async () => {
    fetchSlots.mockResolvedValue({
      'product-card-actions': { module: 'wishlist', component: 'toggle-button' },
    } as SlotMap);
    const { container } = await renderSlot({ name: 'product-card-actions', route: '/product/tee' });
    // The server NEVER fetches personalized data (it would leak one customer's state into an ISR cache).
    expect(fetchSlotWidget).not.toHaveBeenCalled();
    // The island is present in the tree (it fetches client-side on mount).
    expect(container.querySelector('[data-slot-island]')).not.toBeNull();
  });

  it('passes the BINDING-derived module/slot/route to the island (own-mount source of truth)', async () => {
    fetchSlots.mockResolvedValue({
      'product-card-actions': { module: 'wishlist', component: 'toggle-button' },
    } as SlotMap);
    const { container } = await renderSlot({ name: 'product-card-actions', route: '/product/tee' });
    const island = container.querySelector('[data-slot-island]');
    expect(island?.getAttribute('data-module')).toBe('wishlist');
    expect(island?.getAttribute('data-slot')).toBe('product-card-actions');
    expect(island?.getAttribute('data-route')).toBe('/product/tee');
  });
});
