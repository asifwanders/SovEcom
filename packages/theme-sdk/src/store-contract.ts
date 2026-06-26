/**
 * the STORE-facing contract types the storefront will
 * consume. These describe the two tiny, already-shipped store endpoints a theme touches — there is
 * no other runtime contract:
 *   - `GET /store/v1/theme` → `ActiveTheme` (`{ name, version, settings }`);
 *   - `GET /store/v1/slots` → `SlotMap` (`Record<slot, { module, component }>`, conflicts omitted).
 *
 * A CI type-conformance guard in apps/api asserts the in-tree view types (`ActiveThemeView` in
 * `themes.service.ts`, the store slot map in `slots.controller.store.ts`) stay assignable to these
 * exported types — so the seam is guarded at compile time, not by hope.
 */
import type { ThemeSettings } from './settings.js';

/**
 * The public store view of the active theme — exactly what `GET /store/v1/theme` returns and what
 * the storefront reads to render. Name + version + the (opaque) settings record only.
 */
export interface ActiveTheme {
  readonly name: string;
  readonly version: string;
  readonly settings: ThemeSettings;
}

/**
 * A single cleanly-resolved slot binding: the module that fills the slot and the component id the
 * storefront maps to that module's UI.
 */
export interface SlotBinding {
  readonly module: string;
  readonly component: string;
}

/**
 * The public slot map — exactly what `GET /store/v1/slots` returns: `slot → { module, component }`
 * for cleanly-resolved slots only (conflicts/unresolved slots are OMITTED, never silently picked).
 */
export type SlotMap = Record<string, SlotBinding>;
