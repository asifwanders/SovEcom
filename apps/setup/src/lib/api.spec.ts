import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSetupApi, SetupApiError } from './api';
import { TOKEN_KEY } from '@/wizard/storage';

function mockFetch(response: { ok: boolean; status: number; statusText?: string; body?: unknown }) {
  const text = response.body === undefined ? '' : JSON.stringify(response.body);
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(text, {
        status: response.status,
        statusText: response.statusText,
      }),
  );
}

describe('setup API client', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('status() GETs /setup/v1/status and returns the parsed body', async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 200,
      body: { installed: false, requiresToken: true },
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = createSetupApi();
    const result = await api.status();

    expect(result).toEqual({ installed: false, requiresToken: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/setup\/v1\/status$/);
    expect(init?.method).toBe('GET');
  });

  it('verifyToken() POSTs the token and does NOT send an X-Setup-Token header', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: { valid: true, expiresAt: 'x' } });
    vi.stubGlobal('fetch', fetchMock);

    await createSetupApi().verifyToken('abc');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ token: 'abc' });
    const headers = new Headers(init?.headers);
    expect(headers.has('x-setup-token')).toBe(false);
  });

  it('reads the token from sessionStorage and injects X-Setup-Token on gated calls', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'tok-123');
    const fetchMock = mockFetch({ ok: true, status: 200, body: { ok: true } });
    vi.stubGlobal('fetch', fetchMock);

    await createSetupApi().post('/setup/v1/compliance/configure', {
      cookieConsent: true,
    } as never);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('x-setup-token')).toBe('tok-123');
  });

  it('fails a gated call inline (no fetch) when there is no token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createSetupApi().post('/setup/v1/compliance/configure', {} as never),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a 422 into a SetupApiError with per-field errors', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'tok');
    const fetchMock = mockFetch({
      ok: false,
      status: 422,
      body: {
        message: 'Validation failed',
        errors: { fieldErrors: { email: ['Invalid email'] } },
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await createSetupApi()
      .post('/setup/v1/admin-account/start', {} as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(SetupApiError);
    expect(err.status).toBe(422);
    expect(err.message).toBe('Validation failed');
    expect(err.fieldErrors).toEqual({ email: 'Invalid email' });
  });

  it('treats a post-install 404 on complete() as success (installed)', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'tok');
    const fetchMock = mockFetch({ ok: false, status: 404, body: { message: 'Not Found' } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSetupApi().complete()).resolves.toEqual({ installed: true });
  });

  it('surfaces a network failure as a friendly inline error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const err = await createSetupApi()
      .status()
      .catch((e) => e);
    expect(err).toBeInstanceOf(SetupApiError);
    expect(err.message).toMatch(/could not reach the server/i);
  });
});
