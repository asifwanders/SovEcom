import { vi } from 'vitest';
import type { SetupApi, StatusResponse, VerifyTokenResponse } from '@/lib/api';

export interface MockApiOverrides {
  status?: Partial<StatusResponse>;
  verifyToken?: VerifyTokenResponse | (() => Promise<VerifyTokenResponse>);
  complete?: () => Promise<{ installed: true }>;
  post?: () => Promise<unknown>;
  postMultipart?: () => Promise<unknown>;
  /** Override the read-only GET (Theme lists themes, Modules lists built-ins). Receives the path. */
  get?: (path: string) => Promise<unknown>;
}

/**
 * A vitest-mocked SetupApi. Defaults: a not-installed status, a VALID verify-token, a
 * successful complete, and a successful generic post — override per test as needed.
 */
export function createMockApi(overrides: MockApiOverrides = {}): {
  api: SetupApi;
  status: ReturnType<typeof vi.fn>;
  verifyToken: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  postMultipart: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn(
    async (): Promise<StatusResponse> => ({
      installed: false,
      requiresToken: true,
      ...overrides.status,
    }),
  );

  const verifyToken = vi.fn(async (): Promise<VerifyTokenResponse> => {
    if (typeof overrides.verifyToken === 'function') return overrides.verifyToken();
    return overrides.verifyToken ?? { valid: true, expiresAt: '2099-01-01T00:00:00.000Z' };
  });

  const post = vi.fn(async () => {
    if (overrides.post) return overrides.post();
    return { ok: true };
  });

  const postMultipart = vi.fn(async () => {
    if (overrides.postMultipart) return overrides.postMultipart();
    return { ok: true };
  });

  // Default GETs: the Theme step lists the seeded themes (a single `default` here); the Modules
  // step lists the platform's built-ins (one sample built-in here, not yet installed).
  const get = vi.fn(async (path: string) => {
    if (overrides.get) return overrides.get(path);
    if (path.endsWith('/themes')) {
      return { themes: [{ id: 'default', name: 'default', preview: 'placeholder' }] };
    }
    if (path.endsWith('/modules')) {
      return {
        modules: [
          {
            id: 'reviews',
            name: 'reviews',
            displayName: 'Product reviews',
            description: 'Let customers leave star ratings and written reviews.',
            permissions: ['write:own_tables', 'read:products'],
            slots: [{ slot: 'product-detail-reviews-section', component: 'review-list' }],
            installed: false,
          },
        ],
      };
    }
    return {};
  });

  const complete = vi.fn(async (): Promise<{ installed: true }> => {
    if (overrides.complete) return overrides.complete();
    return { installed: true };
  });

  const api = {
    status,
    verifyToken,
    post,
    postMultipart,
    get,
    complete,
  } as unknown as SetupApi;
  return { api, status, verifyToken, post, postMultipart, get, complete };
}
