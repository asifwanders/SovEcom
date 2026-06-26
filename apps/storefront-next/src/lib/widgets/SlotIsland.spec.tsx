import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { WidgetDescriptor } from '@sovecom/theme-sdk';

/**
 * C2/C3 client-island tests. The personalized island fetches its OWN data client-side
 * (`no-store`, `credentials:'include'`, + `Authorization: Bearer <token>` when logged in — the
 * store-module proxy reads the customer ONLY from Bearer, never the cookie), runs C1 `parseWidget`,
 * ENFORCES own-mount, and renders the registered interactive widget — or renders NOTHING on any failure.
 * The server never fetched this data.
 *
 * `useAuth` is mocked so the spec can drive the access-token getter (logged-in vs guest) without an
 * <AuthProvider>. `currentToken` is the live value the mocked `getAccessToken()` returns.
 */
let currentToken: string | null = null;
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ getAccessToken: () => currentToken }),
}));

import { SlotIsland } from './SlotIsland';

const TOGGLE: WidgetDescriptor = {
  type: 'toggle-button',
  props: {
    initialOn: false,
    onAction: { path: '/store/v1/modules/wishlist/add' },
    offAction: { path: '/store/v1/modules/wishlist/remove' },
    labels: { on: 'Remove', off: 'Add to wishlist' },
    icon: 'heart',
  },
};

function stubFetch(impl: typeof fetch) {
  const spy = vi.fn<typeof fetch>(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * The fail-closed guarantee: the island's invisible mount marker (`[data-slot-island]`) may be present,
 * but NO widget content renders inside it — no button/form/widget element. This asserts the precise
 * "render nothing, never break the page" behaviour (the marker is an empty span, not absence of it).
 */
function islandIsEmpty(container: HTMLElement): boolean {
  expect(container.querySelector('button')).toBeNull();
  expect(container.querySelector('form')).toBeNull();
  const island = container.querySelector('[data-slot-island]');
  // Either no island at all (unknown component short-circuit) or an island with no element children.
  return island === null || island.children.length === 0;
}

beforeEach(() => {
  // Provide the base URL so the island builds its URL deterministically.
  process.env.NEXT_PUBLIC_API_BASE_URL = 'http://api.test';
  currentToken = null;
});
afterEach(() => vi.restoreAllMocks());

/** Read the `Authorization` header off a captured fetch init (handles object/Headers/undefined). */
function authHeaderOf(init: RequestInit | undefined): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get('Authorization') ?? undefined;
  return (h as Record<string, string>).Authorization;
}

describe('SlotIsland — personalized client fetch', () => {
  it('fetches the binding mount with no-store + credentials:include, then renders the widget', async () => {
    const spy = stubFetch(async () => new Response(JSON.stringify(TOGGLE), { status: 200 }));
    const { getByRole } = render(
      <SlotIsland
        module="wishlist"
        component="toggle-button"
        slot="product-card-actions"
        route="/product/tee"
      />,
    );
    await waitFor(() => expect(getByRole('button')).toBeTruthy());
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain('/store/v1/modules/wishlist/slot');
    expect((init as RequestInit).cache).toBe('no-store');
    expect((init as RequestInit).credentials).toBe('include');
  });

  it('renders NOTHING on a non-200 / transport error (fail closed, never throws)', async () => {
    stubFetch(async () => new Response('null', { status: 500 }));
    const { container } = render(
      <SlotIsland module="wishlist" component="toggle-button" slot="s" route="/" />,
    );
    // The island's invisible mount marker stays, but NO widget content renders (no button/form).
    await new Promise((r) => setTimeout(r, 0));
    await waitFor(() => expect(islandIsEmpty(container)).toBe(true));
  });

  it('renders NOTHING on an invalid descriptor (parseWidget rejects)', async () => {
    stubFetch(async () => new Response(JSON.stringify({ type: 'evil', props: {} }), { status: 200 }));
    const { container } = render(
      <SlotIsland module="wishlist" component="toggle-button" slot="s" route="/" />,
    );
    await new Promise((r) => setTimeout(r, 0));
    await waitFor(() => expect(islandIsEmpty(container)).toBe(true));
  });

  it('renders NOTHING when the descriptor type mismatches the binding component', async () => {
    // bound as toggle-button but the module returns submit-form → refuse (pinned to the binding).
    const form = {
      type: 'submit-form',
      props: {
        action: { path: '/store/v1/modules/wishlist/submit' },
        submitLabel: 'Go',
        fields: [],
      },
    };
    stubFetch(async () => new Response(JSON.stringify(form), { status: 200 }));
    const { container } = render(
      <SlotIsland module="wishlist" component="toggle-button" slot="s" route="/" />,
    );
    await new Promise((r) => setTimeout(r, 0));
    await waitFor(() => expect(islandIsEmpty(container)).toBe(true));
  });

  it('OWN-MOUNT: renders NOTHING when an action path targets a DIFFERENT module than the binding', async () => {
    // The descriptor's action paths point at `reviews`, but the BINDING module is `wishlist` → refuse.
    const crossMount: WidgetDescriptor = {
      type: 'toggle-button',
      props: {
        initialOn: false,
        onAction: { path: '/store/v1/modules/reviews/add' },
        offAction: { path: '/store/v1/modules/reviews/remove' },
        labels: { on: 'On', off: 'Off' },
        icon: 'heart',
      },
    };
    stubFetch(async () => new Response(JSON.stringify(crossMount), { status: 200 }));
    const { container } = render(
      <SlotIsland module="wishlist" component="toggle-button" slot="s" route="/" />,
    );
    // The descriptor validates + type-matches, so the ToggleButton mounts — but its OWN-MOUNT guard
    // rejects the cross-module action paths and the widget renders nothing. No button reaches the DOM.
    await new Promise((r) => setTimeout(r, 0));
    await waitFor(() => expect(islandIsEmpty(container)).toBe(true));
  });

  it('renders NOTHING for an unknown binding component (skip — no marker, no fetch)', async () => {
    const spy = stubFetch(async () => new Response(JSON.stringify(TOGGLE), { status: 200 }));
    const { container } = render(
      <SlotIsland module="wishlist" component="not-a-widget" slot="s" route="/" />,
    );
    await new Promise((r) => setTimeout(r, 0));
    // Unknown component short-circuits BEFORE the marker and BEFORE any fetch.
    expect(container.querySelector('[data-slot-island]')).toBeNull();
    expect(container).toBeEmptyDOMElement();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('SlotIsland — Bearer auth (the store-module proxy reads the customer only from Bearer)', () => {
  it('LOGGED IN: the GET carries Authorization: Bearer <token>', async () => {
    currentToken = 'tok-123';
    const spy = stubFetch(async () => new Response(JSON.stringify(TOGGLE), { status: 200 }));
    const { getByRole } = render(
      <SlotIsland module="wishlist" component="toggle-button" slot="product-card-actions" route="p1" />,
    );
    await waitFor(() => expect(getByRole('button')).toBeTruthy());
    const [, init] = spy.mock.calls[0]!;
    expect(authHeaderOf(init as RequestInit)).toBe('Bearer tok-123');
  });

  it('GUEST (no token): the GET sends NO Authorization header', async () => {
    currentToken = null;
    const spy = stubFetch(async () => new Response(JSON.stringify(TOGGLE), { status: 200 }));
    render(
      <SlotIsland module="wishlist" component="toggle-button" slot="product-card-actions" route="p1" />,
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [, init] = spy.mock.calls[0]!;
    expect(authHeaderOf(init as RequestInit)).toBeUndefined();
  });

  it('wishlist ANONYMOUS (module 204s the guest) → renders nothing (needs an account)', async () => {
    currentToken = null;
    // No Bearer ⇒ the module sees an anonymous request ⇒ 204 ⇒ the island renders no toggle.
    stubFetch(async (_url, init) =>
      authHeaderOf(init as RequestInit) === undefined
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(TOGGLE), { status: 200 }),
    );
    const { container } = render(
      <SlotIsland module="wishlist" component="toggle-button" slot="product-card-actions" route="p1" />,
    );
    await new Promise((r) => setTimeout(r, 0));
    await waitFor(() => expect(islandIsEmpty(container)).toBe(true));
  });

  it('wishlist LOGGED IN (Bearer ⇒ module returns the toggle) → renders the toggle', async () => {
    currentToken = 'tok-xyz';
    stubFetch(async (_url, init) =>
      authHeaderOf(init as RequestInit) === 'Bearer tok-xyz'
        ? new Response(JSON.stringify(TOGGLE), { status: 200 })
        : new Response(null, { status: 204 }),
    );
    const { getByRole } = render(
      <SlotIsland module="wishlist" component="toggle-button" slot="product-card-actions" route="p1" />,
    );
    await waitFor(() => expect(getByRole('button')).toBeTruthy());
  });

  it('the toggle POST-back carries the same Bearer as the GET', async () => {
    currentToken = 'tok-post';
    const spy = stubFetch(async () => new Response(JSON.stringify(TOGGLE), { status: 200 }));
    const { getByRole } = render(
      <SlotIsland module="wishlist" component="toggle-button" slot="product-card-actions" route="p1" />,
    );
    await waitFor(() => expect(getByRole('button')).toBeTruthy());
    getByRole('button').click();
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(1));
    // The POST is the 2nd call; its method is POST and it carries the Bearer.
    const postCall = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(postCall).toBeDefined();
    expect(authHeaderOf(postCall![1] as RequestInit)).toBe('Bearer tok-post');
  });
});
