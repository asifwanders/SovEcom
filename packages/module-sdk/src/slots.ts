/**
 * a typed AUTHORING helper for the manifest's
 * declarative `slots: { slot, component }[]` array.
 *
 * Slots are DECLARATIVE metadata; the slot registry is DERIVED from enabled modules' manifests.
 * This helper is NOT an RPC and there is NO runtime `registerSlot()` (the `register:slot`
 * capability was removed). It exists purely so an author can build a typed, validated slot array
 * at author time, mirroring the same rules the manifest schema enforces (lowercase slug shape;
 * a module fills any given slot at most once). Its output is dropped verbatim into the manifest.
 */
import { SLOT_SLUG_RE, type ModuleSlotEntry } from './manifest.js';

/**
 * Validate + return a slot-declaration array for the manifest. Enforces the SAME rules as
 * `moduleManifestSchema`:
 *   - `slot` and `component` are non-empty lowercase slugs (`^[a-z][a-z0-9-]*$`);
 *   - no slot is declared more than once.
 * Throws a clear `Error` on the first violation. Returns a fresh, frozen array.
 */
export function defineSlots(entries: ReadonlyArray<ModuleSlotEntry>): readonly ModuleSlotEntry[] {
  if (!Array.isArray(entries)) {
    throw new TypeError('defineSlots(entries): entries must be an array');
  }
  const seen = new Set<string>();
  const out: ModuleSlotEntry[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('defineSlots: each entry must be an object { slot, component }');
    }
    const { slot, component } = entry;
    if (typeof slot !== 'string' || !SLOT_SLUG_RE.test(slot)) {
      throw new Error(`defineSlots: slot "${String(slot)}" must be a lowercase slug`);
    }
    if (typeof component !== 'string' || !SLOT_SLUG_RE.test(component)) {
      throw new Error(`defineSlots: component "${String(component)}" must be a lowercase slug`);
    }
    if (seen.has(slot)) {
      throw new Error(
        `defineSlots: slot "${slot}" is declared more than once; a module may target a slot at most once`,
      );
    }
    seen.add(slot);
    out.push({ slot, component });
  }
  return Object.freeze(out);
}
