/**
 * a typed AUTHORING helper for the theme
 * manifest's declarative `slots: string[]` array (the slot slugs a theme exposes/renders).
 *
 * Slots are DECLARATIVE metadata; the slot registry is DERIVED at runtime from enabled MODULES'
 * manifests. This helper is NOT an RPC and there is NO runtime `registerSlot`. It
 * exists purely so a theme author can build a typed, validated list of the slot slugs the theme
 * declares, mirroring the same rules the manifest schema enforces (lowercase slug shape; no
 * duplicate slug). Its output is dropped verbatim into the manifest's `slots`.
 */
import { SLOT_SLUG_RE } from './manifest.js';

/**
 * Validate + return a theme slot-slug array for the manifest. Enforces the SAME rules as
 * `themeManifestSchema`:
 *   - each slot is a non-empty lowercase slug (`^[a-z][a-z0-9-]*$`);
 *   - no slot slug appears more than once.
 * Throws a clear `Error` on the first violation. Returns a fresh, frozen array.
 */
export function defineThemeSlots(slots: ReadonlyArray<string>): readonly string[] {
  if (!Array.isArray(slots)) {
    throw new TypeError('defineThemeSlots(slots): slots must be an array');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slot of slots) {
    if (typeof slot !== 'string' || !SLOT_SLUG_RE.test(slot)) {
      throw new Error(`defineThemeSlots: slot "${String(slot)}" must be a lowercase slug`);
    }
    if (seen.has(slot)) {
      throw new Error(
        `defineThemeSlots: slot "${slot}" is declared more than once; declare each slot at most once`,
      );
    }
    seen.add(slot);
    out.push(slot);
  }
  return Object.freeze(out);
}
