/**
 * @sovecom/client-js — typed storefront client for the SovEcom API.
 *
 * `paths`/`components` are generated from the API's OpenAPI spec (`pnpm generate`); the client is
 * a thin, dependency-free `fetch` wrapper over them. Regenerate types after API changes via
 * `apps/api: pnpm openapi:dump` then `packages/client-js: pnpm generate`.
 */
export { CLIENT_JS_VERSION } from './version.js';
export {
  createSovEcomClient,
  SovEcomApiError,
  type SovEcomClient,
  type SovEcomClientOptions,
  type RequestOptions,
  type HttpMethod,
  type PathFor,
} from './client.js';
export type { paths, components, operations } from './generated/api.js';
