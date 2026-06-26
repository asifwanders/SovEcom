/**
 * `@sovecom/module-sdk` — the public, semver-pinned author-facing contract for the SovEcom
 * module ecosystem. This package is the SINGLE SOURCE OF TRUTH for the
 * module trust boundary: the capability interfaces, DTOs, manifest validators, and author
 * ergonomics. `apps/api` (the core runtime) imports these definitions FROM here, so the
 * published SDK can never drift from what the broker actually enforces.
 *
 * It is a CONTRACT package, not a code-execution surface: ALL permission / tenant / refusal
 * enforcement lives in the core-side broker. Nothing exported here can disable or weaken it.
 */

/** SDK package version (independent of the core API contract version below). */
export const MODULE_SDK_VERSION = '1.0.0-rc.1';

// ── author ergonomics ───────────────────────────────────────────────────────────
export { defineModule } from './module.js';
export type { SovecomModule, DefineModuleConfig } from './module.js';
export { defineSlots } from './slots.js';
export { createNamespacedTable } from './tables.js';

// ── capability contract (passed into activate(sdk)) ──────────────────────────────
export type {
  ModuleSdk,
  StoreClient,
  AdminClient,
  CommerceClient,
  HttpClient,
  TablesClient,
  EventsClient,
  EmailClient,
} from './capabilities.js';

// ── email:send message DTO + bounds (3.10-i) ─────────────────────────────────────
export { EMAIL_TO_MAX, EMAIL_SUBJECT_MAX, EMAIL_TEXT_MAX, EMAIL_HTML_MAX } from './email.js';
export type {
  ModuleEmailMessage,
  ModuleCustomerEmailMessage,
  ModuleEmailSendResult,
} from './email.js';

// ── DTOs ──────────────────────────────────────────────────────────────────────
export type {
  ListQuery,
  ListResult,
  ModuleProductDto,
  ModuleProductCategory,
  ModuleCategoryDto,
  ModuleOrderDto,
  ModuleCustomerDto,
} from './dto.js';

// ── observational commerce event payloads (subscribe:events; follow-up B2) ───────
export type { ProductPriceChangedPayload, ProductStockChangedPayload } from './events.js';

// ── module HTTP contract (sdk.serve handler) ─────────────────────────────────────
export type {
  ModuleHttpSurface,
  ModuleHttpRequest,
  ModuleHttpResponse,
  ModuleHttpHandler,
} from './http.js';

// ── manifest types + validators (single source of truth) ─────────────────────────
export {
  MODULE_PERMISSION_ALLOWLIST,
  MANIFEST_MAX_BYTES,
  MODULE_NAME_RE,
  SLOT_SLUG_RE,
  TABLE_SUFFIX_RE,
  moduleManifestSchema,
  parseAndVerifyManifest,
  assertCoreCompatible,
} from './manifest.js';
export type { ModulePermission, ModuleManifest, ModuleSlotEntry } from './manifest.js';

// ── core API contract version ───────────────────────────────────────────────────
export { CORE_API_VERSION } from './core-version.js';

// ── RPC error codes (for author error-handling) ──────────────────────────────────
export { RpcErrorCode } from './errors.js';
