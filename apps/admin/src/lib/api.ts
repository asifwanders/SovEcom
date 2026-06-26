import { useAuthStore } from './auth';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }
  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as { accessToken: string };
      useAuthStore.getState().setAccessToken(data.accessToken);
      return data.accessToken;
    } catch {
      return null;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const url = `${API_BASE}${path}`;
  // When body is FormData, let the browser set the Content-Type (multipart + boundary).
  // Never merge a caller-supplied Content-Type in that case either.
  const isFormData = init?.body instanceof FormData;
  const headers: Record<string, string> = isFormData
    ? {}
    : {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string>),
      };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.Authorization = `Bearer ${newToken}`;
      const retryRes = await fetch(url, {
        ...init,
        credentials: 'include',
        headers,
      });
      // If the retry still returns 401, the server rejects the new token — log out.
      if (retryRes.status === 401) {
        useAuthStore.getState().logout();
        window.location.href = `${import.meta.env.BASE_URL}login`;
        throw new ApiError('Unauthorized', 401, null);
      }
      if (!retryRes.ok) {
        const body = await parseBody(retryRes);
        throw new ApiError(extractMessage(body) ?? retryRes.statusText, retryRes.status, body);
      }
      return parseBody(retryRes) as T;
    }
    // Refresh failed — clear auth and redirect
    useAuthStore.getState().logout();
    window.location.href = `${import.meta.env.BASE_URL}login`;
    throw new ApiError('Unauthorized', 401, null);
  }

  if (!res.ok) {
    const body = await parseBody(res);
    throw new ApiError(extractMessage(body) ?? res.statusText, res.status, body);
  }

  return parseBody(res) as T;
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.message === 'string') return b.message;
    if (b.error && typeof b.error === 'object') {
      const e = b.error as Record<string, unknown>;
      if (typeof e.message === 'string') return e.message;
    }
  }
  return undefined;
}
