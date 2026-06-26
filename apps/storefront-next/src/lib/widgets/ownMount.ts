/**
 * Own-mount enforcement for interactive widgets.
 *
 * An interactive widget POSTs back to a module-supplied `action.path`. Path validation ensures it is
 * a clean relative `/store/v1/modules/...` path — no scheme, no other origin, no traversal, no
 * control bytes. This module adds binding enforcement: the `<name>` segment of the path is pinned to
 * the slot BINDING's module (never the descriptor). A module may only post back to its own mount,
 * never to another module's or an arbitrary endpoint.
 *
 * Provides a pure string predicate with no I/O or React dependency. Uses exact `<name>/` segment
 * matching to reject prefix-collision names like `wishlist-evil` when binding to `wishlist`.
 */

/**
 * The own-mount prefix for a binding module: `/store/v1/modules/<module>/`. The module name is
 * `encodeURIComponent`-encoded for SYMMETRY with the fetch-URL builders (S5 defense-in-depth) — module
 * names are core-controlled kebab-case slugs for which `encodeURIComponent` is the IDENTITY, so the
 * prefix still matches the descriptor's raw (C1-validated) `action.path` segment exactly. Were a module
 * name ever to contain a reserved char, both this prefix and the builders would encode it identically,
 * keeping the comparison consistent rather than letting an unencoded reserved char slip the gate.
 */
export function ownMountPrefix(module: string): string {
  return `/store/v1/modules/${encodeURIComponent(module)}/`;
}

/**
 * True iff `path` targets the binding `module`'s own mount — i.e. it begins with
 * `/store/v1/modules/<module>/` AND has at least one path character after that trailing slash. The
 * trailing slash makes the match the FULL `<module>` segment (rejecting `wishlist-evil` for
 * `wishlist`), and requiring content after it rejects the bare mount. C1 has already validated the
 * path shape; this is the additive binding-pin.
 */
export function isOwnMountPath(path: string, module: string): boolean {
  if (typeof path !== 'string' || typeof module !== 'string' || module.length === 0) return false;
  const prefix = ownMountPrefix(module);
  // Must start with the exact own-mount prefix AND carry a non-empty endpoint after it. An empty
  // first segment (`//add` → `prefix` then ``) is rejected because the char immediately after the
  // prefix would be `/`, leaving the first sub-segment empty.
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.length === 0) return false;
  // Reject an empty first segment (e.g. `/store/v1/modules/wishlist//add`).
  if (rest.startsWith('/')) return false;
  return true;
}
