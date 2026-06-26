/**
 * notify-back-in-stock — slot data-RPC handler tests (mocked SDK).
 *
 * `GET /slot?slot=product-detail-actions&route=<variantId>` returns a `submit-form` widget
 * descriptor — data only — for guest email capture. The form has one `email` field and POSTs to the
 * module's own subscribe mount, with the variant id riding in the action path
 * (`/subscriptions/<variantId>`) since the submit-form widget posts only its declared field values:
 *   - a valid route → a `submit-form` descriptor with an `email` field + own-mount action path;
 *   - an unknown slot / missing route → 204;
 *   - NO customer scoping (guest-friendly — the descriptor is identical signed-in or anonymous).
 *
 * The descriptor's C1-contract validity is checked end-to-end by the apps/api integration suite (an
 * AGPL module never imports the MIT theme-sdk); this unit test asserts the SHAPE directly.
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { NotifyRepository } from '../src/db/repository';
import { resolveSettings, type NotifySettings } from '../src/settings';
import { FakeTables } from './_mock-sdk';

const VARIANT = 'variant-1';

function makeDeps(settings?: Partial<NotifySettings>): { deps: HandlerDeps; tables: FakeTables } {
  const tables = new FakeTables();
  const deps: HandlerDeps = {
    repo: new NotifyRepository(tables),
    settings: resolveSettings(settings),
  };
  return { deps, tables };
}

function slotReq(partial: Partial<ModuleHttpRequest> = {}): ModuleHttpRequest {
  return {
    surface: 'store',
    tenantId: 't1',
    method: 'GET',
    path: '/slot',
    query: { slot: 'product-detail-actions', route: VARIANT },
    headers: {},
    ...partial,
  };
}

interface SubmitFormDescriptor {
  type: 'submit-form';
  props: {
    action: { path: string };
    submitLabel: string;
    fields: Array<{ name: string; label: string; kind: string; required: boolean }>;
    successMessage?: string;
  };
}

function descriptor(res: ModuleHttpResponse): SubmitFormDescriptor {
  return JSON.parse(res.body ?? 'null') as SubmitFormDescriptor;
}

describe('notify-back-in-stock slot — GET /slot (submit-form descriptor)', () => {
  it('returns a submit-form descriptor with an email field + own-mount action path', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq(), deps);
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toContain('application/json');

    const d = descriptor(res);
    expect(d.type).toBe('submit-form');
    // The action targets THIS module's own subscribe mount, with the variant id in the PATH.
    expect(
      d.props.action.path.startsWith('/store/v1/modules/notify-back-in-stock/subscriptions/'),
    ).toBe(true);
    expect(d.props.action.path).toContain(encodeURIComponent(VARIANT));
    expect(d.props.action.path).not.toContain('..');
    expect(d.props.action.path).not.toMatch(/^https?:|^\/\//);

    // Exactly one email field (the form collects only the guest email; variant rides in the path).
    const emailField = d.props.fields.find((f) => f.kind === 'email');
    expect(emailField).toBeDefined();
    expect(emailField?.name).toBe('email');
    expect(emailField?.required).toBe(true);
  });

  it('is guest-friendly: the descriptor is IDENTICAL anonymous vs signed-in (no customer scoping)', async () => {
    const { deps } = makeDeps();
    const anon = descriptor(await handleRequest(slotReq(), deps));
    const auth = descriptor(await handleRequest(slotReq({ customer: { id: 'cust-1' } }), deps));
    expect(auth).toEqual(anon);
  });

  it('204 when the slot query param is unknown', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq({ query: { slot: 'other', route: VARIANT } }), deps);
    expect(res.status).toBe(204);
  });

  it('204 when the route (variantId) is missing/invalid', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq({ query: { slot: 'product-detail-actions' } }), deps);
    expect(res.status).toBe(204);
  });

  it('declines to render when the module is disabled (non-200)', async () => {
    const { deps } = makeDeps({ enabled: false });
    const res = await handleRequest(slotReq(), deps);
    expect(res.status).not.toBe(200);
  });
});

describe('notify-back-in-stock — POST /subscriptions/:variantId (submit-form back-end)', () => {
  it('subscribes a guest email with the variant id from the PATH and email from the body', async () => {
    const { deps, tables } = makeDeps();
    const res = await handleRequest(
      {
        ...slotReq(),
        method: 'POST',
        path: `/subscriptions/${VARIANT}`,
        body: JSON.stringify({ email: 'guest@example.com' }),
      },
      deps,
    );
    expect([200, 201, 204]).toContain(res.status);
    expect(tables.subscriptions.some((s) => s.product_variant_id === VARIANT)).toBe(true);
    expect(tables.subscriptions.some((s) => s.customer_email === 'guest@example.com')).toBe(true);
  });

  it('400s an invalid email on the path-based subscribe', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      {
        ...slotReq(),
        method: 'POST',
        path: `/subscriptions/${VARIANT}`,
        body: JSON.stringify({ email: 'not-an-email' }),
      },
      deps,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a path variant id that decodes to contain a separator (e.g. %2F) → 404, no subscribe', async () => {
    const { deps, tables } = makeDeps();
    // `%2Fetc%2Fpasswd` decodes to `/etc/passwd` — a decoded id with a slash is never a valid variant id.
    const res = await handleRequest(
      {
        ...slotReq(),
        method: 'POST',
        path: `/subscriptions/%2Fetc%2Fpasswd`,
        body: JSON.stringify({ email: 'guest@example.com' }),
      },
      deps,
    );
    expect(res.status).toBe(404);
    expect(tables.subscriptions).toHaveLength(0);
  });
});
