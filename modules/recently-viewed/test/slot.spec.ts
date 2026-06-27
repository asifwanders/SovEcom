/**
 * recently-viewed — slot data-RPC handler tests (mocked SDK).
 *
 * `GET /slot?slot=home-page-bottom&route=/` returns a `product-carousel` widget descriptor of the
 * visitor's recently-viewed products — data only. The visitor is resolved by the module's existing
 * identity seam (core-verified `req.customer.id`, else the core-derived `req.guestId.id`):
 *   - a customer / guest with history → a carousel descriptor of their enriched products;
 *   - the descriptor is VISITOR-SCOPED (visitor A never sees visitor B's history);
 *   - no resolvable visitor OR no items → 204 (decline; the storefront renders nothing);
 *   - an unknown slot → 204;
 *   - the descriptor is bounded to the C1 carousel caps.
 *
 * The descriptor is validated against the C1 contract end-to-end by the apps/api integration suite;
 * this unit test asserts the SHAPE directly (an AGPL module must not import the MIT theme-sdk).
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { RecentlyViewedRepository } from '../src/db/repository';
import { resolveSettings, type RecentlyViewedSettings } from '../src/settings';
import { CAROUSEL_MAX_ITEMS } from '../src/slot/recently-viewed-slot';
import { FakeTables, FakeStore, FakeCategoryResolver } from './_mock-sdk';

const GUEST_ID = { id: 'guest-uuid-slot-test' };

function makeDeps(
  overrides: { settings?: Partial<RecentlyViewedSettings>; store?: FakeStore } = {},
): { deps: HandlerDeps; tables: FakeTables } {
  const tables = new FakeTables();
  const store = overrides.store ?? new FakeStore();
  const deps: HandlerDeps = {
    repo: new RecentlyViewedRepository(tables),
    products: store.products,
    categoryResolver: new FakeCategoryResolver(),
    settings: resolveSettings(overrides.settings),
  };
  return { deps, tables };
}

function slotReq(partial: Partial<ModuleHttpRequest> = {}): ModuleHttpRequest {
  return {
    surface: 'store',
    tenantId: 't1',
    method: 'GET',
    path: '/slot',
    query: { slot: 'home-page-bottom', route: '/' },
    headers: {},
    guestId: GUEST_ID,
    ...partial,
  };
}

interface CarouselDescriptor {
  type: 'product-carousel';
  props: {
    heading?: string;
    items: Array<{ productId: string; slug: string; title: string; imageUrl?: string }>;
  };
}

function descriptor(res: ModuleHttpResponse): CarouselDescriptor {
  return JSON.parse(res.body ?? 'null') as CarouselDescriptor;
}

/** Seed views for a viewer key directly into the FakeTables store. */
function seedViews(tables: FakeTables, viewerKey: string, productIds: string[]): void {
  let i = 0;
  for (const pid of productIds) {
    i += 1;
    tables.views.push({
      id: `v${i}`,
      viewer_key: viewerKey,
      product_id: pid,
      viewed_at: new Date(Date.UTC(2026, 0, i)).toISOString(),
    });
  }
}

describe('recently-viewed slot — GET /slot (product-carousel descriptor)', () => {
  it('returns a product-carousel descriptor of the GUEST visitor enriched history', async () => {
    const { deps, tables } = makeDeps();
    seedViews(tables, `guest:${GUEST_ID.id}`, ['p1', 'p2']);
    const res = await handleRequest(slotReq(), deps);
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toContain('application/json');

    const d = descriptor(res);
    expect(d.type).toBe('product-carousel');
    expect(d.props.items).toHaveLength(2);
    for (const item of d.props.items) {
      expect(typeof item.productId).toBe('string');
      expect(typeof item.slug).toBe('string');
      expect(typeof item.title).toBe('string');
      // slug must be a single inert segment (C1 bars '/', '\\', '..').
      expect(item.slug).not.toContain('/');
    }
  });

  it('is VISITOR-SCOPED: a different guest sees its OWN (empty) history → 204', async () => {
    const { deps, tables } = makeDeps();
    seedViews(tables, `guest:${GUEST_ID.id}`, ['p1', 'p2']);
    // A different guestId sees nothing — isolation holds.
    const res = await handleRequest(slotReq({ guestId: { id: 'other-guest-uuid-xyz' } }), deps);
    expect(res.status).toBe(204);
  });

  it('uses the core-verified customer over any guest token (resolveViewer precedence)', async () => {
    const { deps, tables } = makeDeps();
    seedViews(tables, 'cust:cust-1', ['c1']);
    const res = await handleRequest(slotReq({ customer: { id: 'cust-1' } }), deps);
    expect(res.status).toBe(200);
    const d = descriptor(res);
    expect(d.props.items.map((i) => i.productId)).toEqual(['c1']);
  });

  it('204 when no visitor can be resolved (no customer, no guestId)', async () => {
    const { deps, tables } = makeDeps();
    seedViews(tables, `guest:${GUEST_ID.id}`, ['p1']);
    // Override guestId to undefined — no identity → decline.
    const res = await handleRequest(slotReq({ guestId: undefined }), deps);
    expect(res.status).toBe(204);
  });

  it('204 when the visitor has no history (empty carousel ⇒ decline)', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq(), deps);
    expect(res.status).toBe(204);
  });

  it('204 when the slot query param is unknown (declines to render)', async () => {
    const { deps, tables } = makeDeps();
    seedViews(tables, `guest:${GUEST_ID.id}`, ['p1']);
    const res = await handleRequest(slotReq({ query: { slot: 'other', route: '/' } }), deps);
    expect(res.status).toBe(204);
  });

  it('omits products that no longer enrich (deleted/unpublished) rather than emitting a bad card', async () => {
    const store = new FakeStore(new Set(['p1'])); // only p1 exists
    const { deps, tables } = makeDeps({ store });
    seedViews(tables, `guest:${GUEST_ID.id}`, ['p1', 'p2']);
    const d = descriptor(await handleRequest(slotReq(), deps));
    expect(d.props.items.map((i) => i.productId)).toEqual(['p1']);
  });

  it('bounds the carousel to the C1 item cap (max 24)', async () => {
    const { deps, tables } = makeDeps({ settings: { maxItems: 50 } });
    seedViews(
      tables,
      `guest:${GUEST_ID.id}`,
      Array.from({ length: 40 }, (_, i) => `p${i}`),
    );
    const d = descriptor(await handleRequest(slotReq(), deps));
    expect(d.props.items.length).toBeLessThanOrEqual(CAROUSEL_MAX_ITEMS);
    expect(CAROUSEL_MAX_ITEMS).toBe(24);
  });

  it('declines to render when the module is disabled (non-200)', async () => {
    const { deps, tables } = makeDeps({ settings: { enabled: false } });
    seedViews(tables, `guest:${GUEST_ID.id}`, ['p1']);
    const res = await handleRequest(slotReq(), deps);
    expect(res.status).not.toBe(200);
  });
});
