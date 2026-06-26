/**
 * @sovecom/client-js — thin typed fetch wrapper over the OpenAPI-generated `paths`.
 *
 * No runtime dependency beyond the platform `fetch`. The generated spec (Zod DTOs via nestjs-zod)
 * types request path/query/header params and bodies, but does not carry response body schemas, so
 * `request()` returns a caller-supplied generic (default `unknown`). Auth is layered as headers:
 * a customer bearer (via `getToken`), the cart cookie token, and the guest-order `X-Order-Token`
 * (never in the URL).
 */
import type { paths } from './generated/api.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Paths in the spec that define operation `M` (e.g. every path with a `post`). */
export type PathFor<M extends HttpMethod> = {
  [P in keyof paths]: paths[P] extends Record<M, infer O>
    ? [O] extends [never]
      ? never
      : O extends undefined
        ? never
        : P
    : never;
}[keyof paths];

type Op<P extends keyof paths, M extends HttpMethod> = M extends keyof paths[P]
  ? paths[P][M]
  : never;

type ParamsOf<O> = O extends { parameters: infer Pr } ? Pr : Record<never, never>;
type PathParamsOf<O> =
  ParamsOf<O> extends { path: infer X } ? (X extends undefined | never ? never : X) : never;
type QueryOf<O> =
  ParamsOf<O> extends { query?: infer X } ? (X extends undefined | never ? never : X) : never;
type HeaderOf<O> =
  ParamsOf<O> extends { header?: infer X } ? (X extends undefined | never ? never : X) : never;
// `requestBody?: never` (the generated shape for body-less ops) makes `R` resolve to `never`, and
// a distributive conditional over `never` yields `never` — so body-less ops get no `body` key.
type BodyOf<O> = O extends { requestBody?: infer R }
  ? R extends { content: { 'application/json': infer B } }
    ? B
    : never
  : never;

/** Present a key in the options object only when the operation actually defines it. */
type Opt<K extends string, V> = [V] extends [never] ? Record<never, never> : { [P in K]: V };

export type RequestOptions<P extends keyof paths, M extends HttpMethod> = Opt<
  'path',
  PathParamsOf<Op<P, M>>
> &
  Opt<'query', QueryOf<Op<P, M>>> &
  Opt<'headers', HeaderOf<Op<P, M>>> &
  Opt<'body', BodyOf<Op<P, M>>> & {
    /** A per-request signal for cancellation/timeouts. */
    signal?: AbortSignal;
  };

export interface SovEcomClientOptions {
  /** API origin, e.g. `https://api.example.com` (no trailing slash required). */
  baseUrl: string;
  /** Returns the customer bearer token (JWT) to send as `Authorization`, if any. Sync or async. */
  getToken?: () => string | undefined | null | Promise<string | undefined | null>;
  /** Default headers merged into every request (e.g. a cart token your app manages). */
  headers?: Record<string, string>;
  /** Override the fetch implementation (tests, non-browser runtimes). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

/** Thrown for any non-2xx response. Carries the status + parsed body (never a secret in the URL). */
export class SovEcomApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: unknown,
  ) {
    super(`SovEcom API ${status} ${statusText}`);
    this.name = 'SovEcomApiError';
  }
}

function fillPath(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/\{([^}]+)\}/g, (_m, key: string) => {
    const value = params?.[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing path parameter "${key}" for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, String(v));
    } else {
      usp.append(key, String(value));
    }
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

export interface SovEcomClient {
  /** Low-level typed request. `TResponse` defaults to `unknown` (the spec carries no response bodies). */
  request<P extends PathFor<M>, M extends HttpMethod, TResponse = unknown>(
    method: M,
    path: P,
    options?: RequestOptions<P, M>,
  ): Promise<TResponse>;
  /** Create an order from a cart (cart cookie token must be supplied via `headers`/`getToken`). */
  checkout<TResponse = unknown>(cartId: string): Promise<TResponse>;
  /** Guest order lookup — the token travels in the `X-Order-Token` header, never the URL. */
  getOrderByNumber<TResponse = unknown>(
    orderNumber: string,
    orderToken: string,
  ): Promise<TResponse>;
}

export function createSovEcomClient(options: SovEcomClientOptions): SovEcomClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('No fetch implementation available; pass `fetch` in SovEcomClientOptions.');
  }

  async function request<P extends PathFor<M>, M extends HttpMethod, TResponse = unknown>(
    method: M,
    path: P,
    opts?: RequestOptions<P, M>,
  ): Promise<TResponse> {
    const o = (opts ?? {}) as {
      path?: Record<string, unknown>;
      query?: Record<string, unknown>;
      headers?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    };

    const url = `${baseUrl}${fillPath(path as string, o.path)}${buildQuery(o.query)}`;

    // A `Headers` instance is case-INSENSITIVE, so a caller-supplied `content-type` /
    // `authorization` (any casing) is recognised rather than silently duplicated. Per-request
    // headers override the client defaults; an explicit caller `Authorization` is NOT clobbered
    // by `getToken` (the bearer only fills in when the caller didn't set one).
    const headers = new Headers(options.headers);
    if (o.headers) {
      for (const [k, v] of Object.entries(o.headers)) headers.set(k, v);
    }
    const token = options.getToken ? await options.getToken() : undefined;
    if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);

    const hasBody = o.body !== undefined;
    if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const res = await doFetch(url, {
      method: method.toUpperCase(),
      headers,
      body: hasBody ? JSON.stringify(o.body) : undefined,
      signal: o.signal,
    });

    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new SovEcomApiError(res.status, res.statusText, parsed);
    }
    return parsed as TResponse;
  }

  return {
    request,
    // NB: these convenience methods pass UNCAST option objects on purpose — if the spec drifts
    // (a path/param/header renamed), regeneration changes `paths` and these stop compiling, which
    // (with the CI regen-diff guard) surfaces the drift instead of silently sending a wrong request.
    checkout<TResponse = unknown>(cartId: string): Promise<TResponse> {
      return request<'/store/v1/carts/{cartId}/checkout', 'post', TResponse>(
        'post',
        '/store/v1/carts/{cartId}/checkout',
        { path: { cartId } },
      );
    },
    getOrderByNumber<TResponse = unknown>(
      orderNumber: string,
      orderToken: string,
    ): Promise<TResponse> {
      return request<'/store/v1/orders/by-number/{orderNumber}', 'get', TResponse>(
        'get',
        '/store/v1/orders/by-number/{orderNumber}',
        {
          path: { orderNumber },
          headers: { 'x-order-token': orderToken },
        },
      );
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
