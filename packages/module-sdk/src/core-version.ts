/**
 * The module-API contract version, EXTRACTED here (was
 * `apps/api/src/modules/core-version.ts`) so the SDK's `assertCoreCompatible` and apps/api's
 * runtime gate share ONE constant. apps/api now re-exports this from `@sovecom/module-sdk`.
 *
 * This is the version a module's `compatibleCore` range is checked against — the stable
 * contract between core and modules. It is INTENTIONALLY decoupled from the API package's own
 * `package.json` version (pre-1.0): module authors target a stable `^1.0.0` while the package
 * version churns through 0.x. Bumping the MAJOR here means modules pinned to an older major
 * refuse to load.
 */
export const CORE_API_VERSION = '1.0.0';
