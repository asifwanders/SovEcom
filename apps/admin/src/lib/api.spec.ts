import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from './api';
import { useAuthStore } from './auth';

describe('apiFetch', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('location', { href: '' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes credentials', async () => {
    const fetchMock = vi
      .mocked(globalThis.fetch)
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/test');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/test'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('sets Authorization header when token exists', async () => {
    useAuthStore.getState().setAccessToken('my-token');
    const fetchMock = vi
      .mocked(globalThis.fetch)
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/test');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-token',
        }),
      }),
    );
  });

  it('returns parsed JSON on success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await apiFetch('/test');
    expect(result).toEqual({ data: 'ok' });
  });

  it('returns text on non-JSON success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('hello', { status: 200 }));
    const result = await apiFetch('/test');
    expect(result).toBe('hello');
  });

  it('throws ApiError on 401 when refresh fails', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 })); // refresh also fails

    await expect(apiFetch('/test')).rejects.toThrow('Unauthorized');
  });

  it('retries original request after successful refresh', async () => {
    useAuthStore.getState().setAccessToken('old-token');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'new-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await apiFetch('/test');
    expect(result).toEqual({ data: 'ok' });
    expect(useAuthStore.getState().accessToken).toBe('new-token');
  });

  it('throws ApiError on 4xx/5xx', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Bad Request' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(apiFetch('/test')).rejects.toThrow('Bad Request');
  });

  it('does NOT set Content-Type: application/json when body is FormData', async () => {
    const fetchMock = vi
      .mocked(globalThis.fetch)
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const formData = new FormData();
    formData.append('file', new Blob(['data'], { type: 'image/png' }), 'photo.png');
    await apiFetch('/admin/v1/images', { method: 'POST', body: formData });
    const calledHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(calledHeaders['Content-Type']).toBeUndefined();
    expect(calledHeaders['content-type']).toBeUndefined();
  });

  it('logs out and redirects when post-refresh retry still returns 401', async () => {
    useAuthStore.getState().setAccessToken('old-token');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'new-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 })); // retry still 401

    await expect(apiFetch('/test')).rejects.toThrow('Unauthorized');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
