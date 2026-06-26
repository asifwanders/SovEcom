/**
 * the author-facing module contract + `defineModule` helper.
 *
 * `SovecomModule` is the shape the forked worker loader validates
 * (`apps/api/src/modules/runtime/worker-entry.ts`: `typeof resolved.activate === 'function'`).
 * It is EXTRACTED here so authors and the loader share one definition.
 *
 * `defineModule(config)` is the ergonomic entrypoint: the author writes their `activate(sdk)`
 * body and this returns the exact `{ activate }` object the loader expects. The shape is
 * validated at the boundary (defence in depth — the loader also re-checks) so a misconfigured
 * module fails fast with a clear message at author build time, not as an opaque worker crash.
 */
import type { ModuleSdk } from './capabilities.js';

/** The contract a module must satisfy: a single `activate(sdk)` entrypoint. */
export interface SovecomModule {
  activate(sdk: ModuleSdk): void | Promise<void>;
}

/** Author-supplied config for {@link defineModule}. v1: just the `activate` body. */
export interface DefineModuleConfig {
  /** The module body. Called once by core, inside the worker, with the capability SDK. */
  activate(sdk: ModuleSdk): void | Promise<void>;
}

/**
 * Wrap an author's `activate` into the `{ activate }` object the worker loader expects.
 * Validates the config shape at the boundary and throws a clear error if `activate` is missing
 * or not a function — never let a malformed module reach the runtime as a silent no-op.
 */
export function defineModule(config: DefineModuleConfig): SovecomModule {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('defineModule(config): config must be an object');
  }
  if (typeof config.activate !== 'function') {
    throw new TypeError('defineModule(config): config.activate must be a function');
  }
  const { activate } = config;
  return { activate: (sdk) => activate(sdk) };
}
