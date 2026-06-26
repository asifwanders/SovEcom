/**
 * Module-manifest verification.
 *
 * The canonical schema, validators, types, and the permission allowlist have been
 * EXTRACTED into `@sovecom/module-sdk` (the single source of truth). This module is a
 * thin RE-EXPORT so the in-tree importers keep their `./module-manifest` import path
 * while the definitions live in the published SDK package. Authors, the core runtime,
 * and the contract-test suite all consume ONE validator; it is structurally impossible
 * for them to drift.
 *
 * The validators remain PURE — no Nest, no DB, no filesystem, NO code execution.
 */
export {
  MODULE_PERMISSION_ALLOWLIST,
  MANIFEST_MAX_BYTES,
  moduleManifestSchema,
  parseAndVerifyManifest,
  assertCoreCompatible,
} from '@sovecom/module-sdk';

export type { ModulePermission, ModuleManifest, ModuleSlotEntry } from '@sovecom/module-sdk';
