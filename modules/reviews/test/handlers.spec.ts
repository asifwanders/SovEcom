/**
 * reviews — handler unit tests (mocked SDK). Drives the REAL handleRequest + repository +
 * purchase-gate against the in-memory FakeTables / FakeCommerce, with an injectable purchase verifier
 * so the purchaser vs non-purchaser branches are both exercised deterministically.
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { ReviewsRepository } from '../src/db/repository';
import { resolveSettings, type ReviewsSettings } from '../src/settings';
import type { PurchaseVerifier } from '../src/purchase/purchase-gate';
import { FakeTables, FakeCommerce, FakeStore } from './_mock-sdk';

const ALLOW: PurchaseVerifier = { verify: () => Promise.resolve(true) };
const DENY: PurchaseVerifier = { verify: () => Promise.resolve(false) };

function makeDeps(
  overrides: {
    settings?: Partial<ReviewsSettings>;
    verifier?: PurchaseVerifier;
    store?: FakeStore;
    commerce?: FakeCommerce;
  } = {},
): { deps: HandlerDeps; tables: FakeTables; commerce: FakeCommerce; store: FakeStore } {
  const tables = new FakeTables();
  const commerce = overrides.commerce ?? new FakeCommerce(() => true);
  const store = overrides.store ?? new FakeStore();
  const deps: HandlerDeps = {
    repo: new ReviewsRepository(tables),
    products: store.products,
    commerce,
    settings: resolveSettings(overrides.settings),
    purchaseVerifier: overrides.verifier ?? ALLOW,
  };
  return { deps, tables, commerce, store };
}

function req(partial: Partial<ModuleHttpRequest>): ModuleHttpRequest {
  return {
    surface: 'store',
    tenantId: 't1',
    method: 'GET',
    path: '/reviews',
    query: {},
    headers: {},
    ...partial,
  };
}

const CUST = { id: 'cust-1' };
const PROD = 'prod-1';

async function body(res: ModuleHttpResponse): Promise<Record<string, unknown>> {
  return res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {};
}

describe('reviews handlers — submit (POST /reviews)', () => {
  it('anonymous → 401 login_required', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        body: JSON.stringify({ productId: PROD, rating: 5, body: 'Great product!' }),
      }),
      deps,
    );
    expect(res.status).toBe(401);
    expect((await body(res)).error).toBe('login_required');
  });

  it('purchaser → 201 pending (moderated by default), via the REAL commerce probe', async () => {
    // No stub verifier → the default commerce verifier runs against a probe that confirms the buy.
    const tables = new FakeTables();
    const commerce = new FakeCommerce((c, p) => c === CUST.id && p === PROD);
    const deps: HandlerDeps = {
      repo: new ReviewsRepository(tables),
      products: new FakeStore().products,
      commerce,
      settings: resolveSettings({}),
    };
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating: 4, body: 'Solid, would buy again.' }),
      }),
      deps,
    );
    expect(res.status).toBe(201);
    const b = await body(res);
    expect(b.status).toBe('pending');
    expect(b.rating).toBe(4);
    expect(tables.reviews).toHaveLength(1);
    // The purchase gate genuinely consulted the read:orders commerce probe.
    expect(commerce.calls).toEqual([{ customerId: CUST.id, productId: PROD }]);
  });

  it('non-purchaser → 403 not_purchased, nothing stored', async () => {
    const { deps, tables } = makeDeps({ verifier: DENY });
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating: 5, body: 'I did not buy this.' }),
      }),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe('not_purchased');
    expect(tables.reviews).toHaveLength(0);
  });

  it('default verifier (no override) → 403 when the commerce probe says NOT purchased', async () => {
    const tables = new FakeTables();
    const commerce = new FakeCommerce(() => false); // probe denies
    const store = new FakeStore();
    // No purchaseVerifier → falls back to the real commerce verifier in the seam.
    const deps: HandlerDeps = {
      repo: new ReviewsRepository(tables),
      products: store.products,
      commerce,
      settings: resolveSettings({}),
    };
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating: 5, body: 'Default path body.' }),
      }),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe('not_purchased');
  });

  it('autoApprove setting → 201 approved (immediately public)', async () => {
    const { deps } = makeDeps({ settings: { autoApprove: true }, verifier: ALLOW });
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating: 5, body: 'Auto approved body.' }),
      }),
      deps,
    );
    expect(res.status).toBe(201);
    expect((await body(res)).status).toBe('approved');
  });

  it('duplicate review by same customer for same product → 409 already_reviewed', async () => {
    const { deps } = makeDeps({ verifier: ALLOW });
    const make = () =>
      handleRequest(
        req({
          method: 'POST',
          path: '/reviews',
          customer: CUST,
          body: JSON.stringify({ productId: PROD, rating: 3, body: 'First and only review.' }),
        }),
        deps,
      );
    expect((await make()).status).toBe(201);
    const second = await make();
    expect(second.status).toBe(409);
    expect((await body(second)).error).toBe('already_reviewed');
  });

  it('unknown product (not in catalog) → 404 product_not_found', async () => {
    const store = new FakeStore(new Set()); // no product ids exist
    const { deps } = makeDeps({ verifier: ALLOW, store });
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating: 5, body: 'Review of a ghost product.' }),
      }),
      deps,
    );
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe('product_not_found');
  });

  it('catalog lookup that throws degrades to 404 (not a 500)', async () => {
    const store = new FakeStore(null, true); // get() rejects
    const { deps } = makeDeps({ verifier: ALLOW, store });
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating: 5, body: 'Catalog is down right now.' }),
      }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it('invalid product id → 400', async () => {
    const { deps } = makeDeps({ verifier: ALLOW });
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ rating: 5, body: 'Body with no product.' }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('invalid_product_id');
  });

  it.each([
    ['zero', 0],
    ['six', 6],
    ['float', 4.5],
    ['negative', -1],
    ['string', '5'],
  ])('rating %s → 400 invalid_rating', async (_label, rating) => {
    const { deps } = makeDeps({ verifier: ALLOW });
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating, body: 'A perfectly fine body.' }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('invalid_rating');
  });

  it('body too short → 400 body_too_short', async () => {
    const { deps } = makeDeps({ settings: { minTextLen: 10 }, verifier: ALLOW });
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating: 5, body: 'short' }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('body_too_short');
  });

  it('body too long → 400 body_too_long', async () => {
    const { deps } = makeDeps({ settings: { maxTextLen: 20 }, verifier: ALLOW });
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/reviews',
        customer: CUST,
        body: JSON.stringify({ productId: PROD, rating: 5, body: 'x'.repeat(50) }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('body_too_long');
  });

  it('body with control chars → 400 body_has_control_chars (escape sequence, never a raw byte)', async () => {
    const { deps } = makeDeps({ verifier: ALLOW });
    // The control char is injected via a JSON \u escape, so no raw control byte appears in source.
    const payload = `{"productId":"${PROD}","rating":5,"body":"bad\\u0007bell here"}`;
    const res = await handleRequest(
      req({ method: 'POST', path: '/reviews', customer: CUST, body: payload }),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('body_has_control_chars');
  });

  it('body with newlines/tabs is allowed (whitespace controls are not forbidden)', async () => {
    const { deps } = makeDeps({ verifier: ALLOW });
    const payload = `{"productId":"${PROD}","rating":5,"body":"line one\\nline two\\twith tab"}`;
    const res = await handleRequest(
      req({ method: 'POST', path: '/reviews', customer: CUST, body: payload }),
      deps,
    );
    expect(res.status).toBe(201);
  });
});

describe('reviews handlers — public GET /reviews', () => {
  async function seed(
    deps: HandlerDeps,
    statusByCustomer: Array<{
      id: string;
      rating: number;
      status: 'pending' | 'approved' | 'rejected';
    }>,
  ) {
    // Insert directly via repo so we can set arbitrary statuses for the read test.
    for (const s of statusByCustomer) {
      await deps.repo.create(s.id, PROD, s.rating, 'A valid review body.', s.status);
    }
  }

  it('returns ONLY approved reviews + approved-only average + count; productId required', async () => {
    const { deps } = makeDeps();
    await seed(deps, [
      { id: 'c1', rating: 4, status: 'approved' },
      { id: 'c2', rating: 2, status: 'approved' },
      { id: 'c3', rating: 5, status: 'pending' }, // excluded
      { id: 'c4', rating: 1, status: 'rejected' }, // excluded
    ]);

    const res = await handleRequest(
      req({ method: 'GET', path: '/reviews', query: { productId: PROD } }),
      deps,
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.count).toBe(2);
    expect(b.average).toBe(3); // (4 + 2) / 2 — pending/rejected excluded
    expect((b.reviews as unknown[]).length).toBe(2);
    // No customer_id leaks in the public payload.
    expect(JSON.stringify(b.reviews)).not.toContain('customer');
  });

  it('no approved reviews → count 0, average null', async () => {
    const { deps } = makeDeps();
    await seed(deps, [{ id: 'c1', rating: 5, status: 'pending' }]);
    const res = await handleRequest(
      req({ method: 'GET', path: '/reviews', query: { productId: PROD } }),
      deps,
    );
    const b = await body(res);
    expect(b.count).toBe(0);
    expect(b.average).toBeNull();
  });

  it('missing productId → 400', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(req({ method: 'GET', path: '/reviews', query: {} }), deps);
    expect(res.status).toBe(400);
  });
});

describe('reviews handlers — admin moderation (surface enforcement)', () => {
  it('GET /queue lists pending reviews on the admin surface', async () => {
    const { deps } = makeDeps();
    await deps.repo.create('c1', PROD, 5, 'Pending review body.', 'pending');
    await deps.repo.create('c2', PROD, 4, 'Approved review body.', 'approved');
    const res = await handleRequest(req({ surface: 'admin', method: 'GET', path: '/queue' }), deps);
    expect(res.status).toBe(200);
    const reviews = (await body(res)).reviews as Array<{ status: string }>;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe('pending');
  });

  it('GET /queue is bounded by ?limit and pages with ?offset', async () => {
    const { deps } = makeDeps();
    for (let i = 0; i < 5; i += 1) {
      await deps.repo.create(`c${i}`, PROD, 5, `Pending review number ${i}.`, 'pending');
    }
    const page1 = await handleRequest(
      req({ surface: 'admin', method: 'GET', path: '/queue', query: { limit: '2' } }),
      deps,
    );
    expect((await body(page1)).reviews).toHaveLength(2);
    const page3 = await handleRequest(
      req({ surface: 'admin', method: 'GET', path: '/queue', query: { limit: '2', offset: '4' } }),
      deps,
    );
    // Offset 4 of 5 pending → the single remaining row.
    expect((await body(page3)).reviews).toHaveLength(1);
  });

  it('GET /queue response omits customer_id (PII minimisation)', async () => {
    const { deps } = makeDeps();
    await deps.repo.create('cust-secret', PROD, 5, 'Queue PII check body.', 'pending');
    const res = await handleRequest(req({ surface: 'admin', method: 'GET', path: '/queue' }), deps);
    expect(res.body).not.toContain('cust-secret');
    expect(res.body).not.toContain('customer');
  });

  it('admin GET /queue is 404 on the STORE surface', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(req({ surface: 'store', method: 'GET', path: '/queue' }), deps);
    expect(res.status).toBe(404);
  });

  it('approve transitions pending → approved (then it appears in the public read)', async () => {
    const { deps } = makeDeps();
    const row = await deps.repo.create('c1', PROD, 5, 'To be approved body.', 'pending');
    const res = await handleRequest(
      req({ surface: 'admin', method: 'POST', path: `/${row!.id}/approve` }),
      deps,
    );
    expect(res.status).toBe(204);
    const pub = await handleRequest(
      req({ method: 'GET', path: '/reviews', query: { productId: PROD } }),
      deps,
    );
    expect((await body(pub)).count).toBe(1);
  });

  it('reject transitions to rejected (excluded from the public read)', async () => {
    const { deps } = makeDeps();
    const row = await deps.repo.create('c1', PROD, 5, 'To be rejected body.', 'pending');
    const res = await handleRequest(
      req({ surface: 'admin', method: 'POST', path: `/${row!.id}/reject` }),
      deps,
    );
    expect(res.status).toBe(204);
    const pub = await handleRequest(
      req({ method: 'GET', path: '/reviews', query: { productId: PROD } }),
      deps,
    );
    expect((await body(pub)).count).toBe(0);
  });

  it('approve is idempotent (re-approving an approved review still 204)', async () => {
    const { deps } = makeDeps();
    const row = await deps.repo.create('c1', PROD, 5, 'Idempotent approve body.', 'pending');
    const path = `/${row!.id}/approve`;
    expect(
      (await handleRequest(req({ surface: 'admin', method: 'POST', path }), deps)).status,
    ).toBe(204);
    expect(
      (await handleRequest(req({ surface: 'admin', method: 'POST', path }), deps)).status,
    ).toBe(204);
  });

  it('approve/reject of an unknown id → 404', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      req({ surface: 'admin', method: 'POST', path: '/does-not-exist/approve' }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it('moderation POST on the STORE surface is 404 (cannot moderate publicly)', async () => {
    const { deps } = makeDeps();
    const row = await deps.repo.create('c1', PROD, 5, 'Store-surface moderation body.', 'pending');
    const res = await handleRequest(
      req({ surface: 'store', method: 'POST', path: `/${row!.id}/approve` }),
      deps,
    );
    expect(res.status).toBe(404);
    // Still pending — the store-surface attempt did nothing.
    const queue = await handleRequest(
      req({ surface: 'admin', method: 'GET', path: '/queue' }),
      deps,
    );
    expect((await body(queue)).reviews).toHaveLength(1);
  });
});

describe('reviews handlers — feature flag + unknown routes', () => {
  it('disabled module → 404 on every route', async () => {
    const { deps } = makeDeps({ settings: { enabled: false } });
    expect(
      (
        await handleRequest(
          req({ method: 'GET', path: '/reviews', query: { productId: PROD } }),
          deps,
        )
      ).status,
    ).toBe(404);
    expect(
      (await handleRequest(req({ surface: 'admin', method: 'GET', path: '/queue' }), deps)).status,
    ).toBe(404);
  });

  it('unknown path → 404', async () => {
    const { deps } = makeDeps();
    expect((await handleRequest(req({ method: 'GET', path: '/nope' }), deps)).status).toBe(404);
  });
});
