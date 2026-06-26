/**
 * Bounded chrome-variant readers.
 *
 * The Boutique theme (and any future theme) selects between a SMALL, FIXED set of chrome arrangements
 * via settings flags that are NOT CSS vars — they are bounded ENUMs the layout reads here and passes as
 * props to the client chrome (`Header`/`CategoryNav`, `CartBadge`). Each reader is DEFENSIVE: the
 * settings bag is `Record<string, unknown>` on the wire (opaque), so an absent, wrong-
 * typed, or unknown value falls back to the DEFAULT variant — which is exactly today's behaviour. So the
 * default theme (empty settings) yields the simple header + drawer cart, byte-for-byte unchanged.
 *
 * The flag keys are dotted (`header.layout`, `cart.affordance`) — a flat key on the opaque settings
 * record, NOT a nested object — so they read straight off the bag without traversal.
 */

/** Header layout variants. `simple` = today's flat nav + Browse dropdown; `mega` = multi-column panel. */
export type HeaderLayout = 'simple' | 'mega';
/** Cart affordance variants. `drawer` = opens the in-page drawer; `page-link` = a plain link to /cart. */
export type CartAffordance = 'drawer' | 'page-link';

/** The default header layout (the unchanged simple nav). */
export const DEFAULT_HEADER_LAYOUT: HeaderLayout = 'simple';
/** The default cart affordance (the unchanged drawer). */
export const DEFAULT_CART_AFFORDANCE: CartAffordance = 'drawer';

const HEADER_LAYOUTS: readonly HeaderLayout[] = ['simple', 'mega'];
const CART_AFFORDANCES: readonly CartAffordance[] = ['drawer', 'page-link'];

/** A loose settings bag (the opaque `Record<string, unknown>` the theme settings surface as). */
type Settings = Readonly<Record<string, unknown>> | null | undefined;

/**
 * Resolve the header layout from settings. `header.layout` must be one of the bounded enum values;
 * anything else (absent / non-string / unknown string) → the default `simple` layout.
 */
export function readHeaderLayout(settings: Settings): HeaderLayout {
  const value = settings?.['header.layout'];
  return typeof value === 'string' && (HEADER_LAYOUTS as readonly string[]).includes(value)
    ? (value as HeaderLayout)
    : DEFAULT_HEADER_LAYOUT;
}

/**
 * Resolve the cart affordance from settings. `cart.affordance` must be one of the bounded enum values;
 * anything else (absent / non-string / unknown string) → the default `drawer` affordance.
 */
export function readCartAffordance(settings: Settings): CartAffordance {
  const value = settings?.['cart.affordance'];
  return typeof value === 'string' && (CART_AFFORDANCES as readonly string[]).includes(value)
    ? (value as CartAffordance)
    : DEFAULT_CART_AFFORDANCE;
}
