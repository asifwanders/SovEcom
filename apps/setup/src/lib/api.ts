/**
 * Setup-wizard API client.
 *
 * A thin typed wrapper over the generated `@sovecom/client-js` paths. It targets the
 * `/setup/v1` surface, injecting the short-lived `X-Setup-Token` (held in sessionStorage,
 * NEVER localStorage) on the GATED calls, and maps API errors into a shape the steps render
 * INLINE (a form-level message + optional per-field errors) — never an alert().
 *
 * Response bodies are not carried in the OpenAPI spec (the DTOs are request-only), so the
 * gated/typed methods declare their runtime return shapes here, matching the 3.2 controllers.
 */
import type { paths } from '@sovecom/client-js';

/** Mirror apps/admin: runtime config first, then build-time env var, then `/api` proxy fallback. */
const API_BASE = ((typeof window !== 'undefined' && window.__SOVECOM__?.apiBaseUrl) ||
  import.meta.env.VITE_API_BASE_URL ||
  '/api') as string;

const SETUP_PREFIX = '/setup/v1';

/** Body type for a POST path, derived from the generated spec so it tracks the API. */
type PostBody<P extends keyof paths> = paths[P] extends {
  post: { requestBody: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

/** Paths that expose a GET operation (the themes/modules lists the wizard reads). */
type GetPath = {
  [P in keyof paths]: paths[P] extends { get: object } ? P : never;
}[keyof paths];

/** A theme card returned by GET /setup/v1/themes (an installed theme; id is its NAME). */
export interface SetupTheme {
  id: string;
  name: string;
  /** A preview marker — `'placeholder'` until real screenshots exist. */
  preview: string;
}

/**
 * A bundled-module catalog card returned by GET /setup/v1/modules. `id` is the install key (the
 * module's manifest name); `displayName`/`description` are shown on the card; `permissions`/`slots`
 * tell the operator what it touches and where it renders; `installed` flags a built-in the tenant
 * already has (so a setup re-run shows state).
 */
export interface SetupModule {
  id: string;
  name: string;
  displayName: string;
  description: string;
  permissions: string[];
  slots: { slot: string; component: string }[];
  installed: boolean;
}

/** The GET /setup/v1/modules response body. */
export interface SetupModuleList {
  modules: SetupModule[];
}

export interface StatusResponse {
  installed: boolean;
  requiresToken: boolean;
}

/**
 * The uniform probe verdict returned by the test endpoints (database/test, smtp/test).
 * Mirrors the API's `ProbeResult` — `error` is ALWAYS sanitized (no credentials).
 */
export interface ProbeResult {
  ok: boolean;
  error?: string;
}

export interface VerifyTokenResponse {
  valid: boolean;
  expiresAt: string | null;
}

/**
 * A normalised, render-ready API failure. `message` is always safe to show as a
 * form-level inline error; `fieldErrors` carries 422 field-level messages keyed by
 * field name (from nestjs-zod's flattened issues) for the steps to surface per-input.
 */
export class SetupApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'SetupApiError';
  }
}

function getSetupToken(): string | null {
  try {
    return sessionStorage.getItem('sovecom.setup.token');
  } catch {
    return null;
  }
}

/** nestjs-zod / Nest exception bodies vary; extract the most specific message we can. */
function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.message === 'string') return b.message;
    if (Array.isArray(b.message) && b.message.every((m) => typeof m === 'string')) {
      return (b.message as string[]).join(', ');
    }
    if (b.error && typeof b.error === 'object') {
      const e = b.error as Record<string, unknown>;
      if (typeof e.message === 'string') return e.message;
    }
  }
  return fallback;
}

/** Pull per-field messages out of a 422 body (nestjs-zod flatten shape). */
function extractFieldErrors(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== 'object') return out;
  const b = body as Record<string, unknown>;
  // nestjs-zod: { errors: { fieldErrors: { field: string[] } } } or { fieldErrors: {...} }
  const errors = (b.errors ?? b) as Record<string, unknown>;
  const fieldErrors = errors.fieldErrors;
  if (fieldErrors && typeof fieldErrors === 'object') {
    for (const [field, msgs] of Object.entries(fieldErrors as Record<string, unknown>)) {
      if (Array.isArray(msgs) && typeof msgs[0] === 'string') out[field] = msgs[0];
      else if (typeof msgs === 'string') out[field] = msgs;
    }
  }
  return out;
}

interface FetchOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /**
   * A multipart/form-data body. When set, `Content-Type` is left UNSET so the browser
   * adds the multipart boundary itself; `body` (JSON) must not also be set.
   */
  formData?: FormData;
  /** Gated calls require a live setup token; absence is itself an inline error. */
  gated?: boolean;
  signal?: AbortSignal;
}

async function rawFetch<T>(opts: FetchOptions): Promise<T> {
  const headers: Record<string, string> = {};
  // For multipart we deliberately DON'T set Content-Type — the browser sets it (with the
  // boundary). Only JSON bodies get an explicit Content-Type.
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  if (opts.gated) {
    const token = getSetupToken();
    if (!token) {
      throw new SetupApiError(
        401,
        'Your setup session expired. Re-enter your setup token on the Welcome step to continue.',
      );
    }
    headers['X-Setup-Token'] = token;
  }

  const requestBody: BodyInit | undefined =
    opts.formData !== undefined
      ? opts.formData
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${opts.path}`, {
      method: opts.method,
      headers,
      body: requestBody,
      signal: opts.signal,
    });
  } catch {
    throw new SetupApiError(
      0,
      'Could not reach the server. Check that the SovEcom API is running and try again.',
    );
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    throw new SetupApiError(
      res.status,
      extractMessage(parsed, res.statusText || `Request failed (${res.status})`),
      res.status === 422 ? extractFieldErrors(parsed) : {},
      parsed,
    );
  }

  return parsed as T;
}

export interface SetupApi {
  /** Always reachable (even post-install). Tells the app whether to run the wizard. */
  status(signal?: AbortSignal): Promise<StatusResponse>;
  /** Validate-only — does NOT consume the token. Caller persists it on `valid`. */
  verifyToken(token: string, signal?: AbortSignal): Promise<VerifyTokenResponse>;
  /**
   * Generic gated POST the middle steps (chunks 2-4) reuse. `P` is constrained to the
   * generated POST paths so the body is type-checked against the spec; the token is
   * injected automatically. `TResponse` defaults to `{ ok: true }` (the common shape).
   */
  post<P extends keyof paths, TResponse = { ok: true }>(
    path: P,
    body: PostBody<P>,
    signal?: AbortSignal,
  ): Promise<TResponse>;
  /**
   * Generic gated GET for the read-only steps (the Theme step lists `/themes`, the Modules step
   * lists `/modules`). `P` is constrained to the generated GET paths; the token is injected
   * automatically. `TResponse` is the runtime body shape (not carried in the spec).
   */
  get<P extends GetPath, TResponse>(path: P, signal?: AbortSignal): Promise<TResponse>;
  /**
   * Gated multipart POST for the Brand step (the logo is a binary part). The token is
   * injected; `Content-Type` is left to the browser so the multipart boundary is set.
   * Path is a string (the brand endpoint's body is multipart, not JSON, in the spec).
   */
  postMultipart<TResponse = { ok: true }>(
    path: string,
    formData: FormData,
    signal?: AbortSignal,
  ): Promise<TResponse>;
  /** Consume the token + flip installed. A post-install 404 ALSO means "installed". */
  complete(signal?: AbortSignal): Promise<{ installed: true }>;
}

export function createSetupApi(): SetupApi {
  return {
    status(signal) {
      return rawFetch<StatusResponse>({
        method: 'GET',
        path: `${SETUP_PREFIX}/status`,
        signal,
      });
    },
    verifyToken(token, signal) {
      return rawFetch<VerifyTokenResponse>({
        method: 'POST',
        path: `${SETUP_PREFIX}/verify-token`,
        body: { token },
        signal,
      });
    },
    post(path, body, signal) {
      return rawFetch({
        method: 'POST',
        path: path as string,
        body,
        gated: true,
        signal,
      });
    },
    get(path, signal) {
      return rawFetch({
        method: 'GET',
        path: path as string,
        gated: true,
        signal,
      });
    },
    postMultipart(path, formData, signal) {
      return rawFetch({
        method: 'POST',
        path,
        formData,
        gated: true,
        signal,
      });
    },
    async complete(signal) {
      try {
        return await rawFetch<{ installed: true }>({
          method: 'POST',
          path: `${SETUP_PREFIX}/complete`,
          gated: true,
          signal,
        });
      } catch (err) {
        // Post-install the whole setup surface 404s except /status; a 404
        // here therefore ALSO means "installed" — treat it as success, not a failure.
        if (err instanceof SetupApiError && err.status === 404) {
          return { installed: true };
        }
        throw err;
      }
    },
  };
}

export const setupApi = createSetupApi();
