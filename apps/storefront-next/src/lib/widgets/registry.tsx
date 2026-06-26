/**
 * Widget registry — the storefront's closed, MIT vocabulary of widget `type`s, beside the section
 * registry. A module author cannot register a type; adding one is an MIT storefront contribution
 * reviewed like adding a section. The registry is keyed by the `WIDGET_TYPES` vocabulary.
 *
 * The `personalized` flag is the load-bearing caching invariant:
 *   - `false` (read-only: star-rating-summary, review-list, product-carousel) ⇒ SERVER-fetched
 *     (`fetchSlotWidget`), SEO-visible, route-keyed cacheable. NO per-customer state.
 *   - `true` (interactive: toggle-button, submit-form) ⇒ CLIENT ISLAND, fetched client-side
 *     `no-store` with credentials. A personalized widget MUST NEVER be server-fetched or live in an
 *     ISR cache (it would leak one customer's state to all).
 *
 * `getWidget(type)` returns `undefined` for an unknown type (⇒ the caller SKIPS — renders nothing).
 *
 * Rendering goes through the TYPE-SAFE dispatchers {@link renderReadOnlyWidget} /
 * {@link renderPersonalizedWidget}: each switches on the descriptor's `type`, so the discriminated union
 * NARROWS and each component is handed its OWN typed props. No `as never`/`as any` — a future drift
 * between a widget component's TS props and its C1 zod schema is a COMPILE error (runtime is already safe
 * via `parseWidget`; this catches the drift at build time).
 */
import type { ReactElement } from 'react';
import { WIDGET_TYPES, type WidgetType, type WidgetDescriptor } from '@sovecom/theme-sdk';
import { StarRatingSummary } from './star-rating-summary';
import { ReviewList } from './review-list';
import { ProductCarousel } from './product-carousel';
import { ToggleButton } from './toggle-button';
import { SubmitForm } from './submit-form';
import type { AccessTokenGetter } from './authHeaders';

/** Per-widget metadata: whether it is per-customer (client island, never server-fetched/cached). */
export interface RegisteredWidget {
  /** Per-customer? `true` ⇒ client island, never server-fetched/cached. */
  personalized: boolean;
}

/** The closed metadata registry, keyed by the C1 `WidgetType` vocabulary. */
export const widgetRegistry: Readonly<Record<WidgetType, RegisteredWidget>> = {
  'star-rating-summary': { personalized: false },
  'review-list': { personalized: false },
  'product-carousel': { personalized: false },
  'toggle-button': { personalized: true },
  'submit-form': { personalized: true },
};

/** The set of known widget types (defensive membership check before indexing the registry). */
const KNOWN: ReadonlySet<string> = new Set<string>(WIDGET_TYPES);

/**
 * Look up a registered widget's metadata by `type`, or `undefined` when no widget is registered for it
 * (⇒ the caller renders nothing). Guards against prototype-chain keys (`__proto__`, `toString`, …) by
 * membership-checking against the closed `WIDGET_TYPES` set before indexing.
 */
export function getWidget(type: string): RegisteredWidget | undefined {
  if (!KNOWN.has(type)) return undefined;
  return widgetRegistry[type as WidgetType];
}

/**
 * Type-safe render of a READ-ONLY (personalized:false) descriptor. The switch narrows the discriminated
 * union, so each component receives its EXACT typed props (compile-time drift detection). Returns `null`
 * for a personalized type (it must never be server-rendered) or an unknown type (defensive).
 */
export function renderReadOnlyWidget(descriptor: WidgetDescriptor): ReactElement | null {
  switch (descriptor.type) {
    case 'star-rating-summary':
      return <StarRatingSummary {...descriptor.props} />;
    case 'review-list':
      return <ReviewList {...descriptor.props} />;
    case 'product-carousel':
      return <ProductCarousel {...descriptor.props} />;
    // Personalized types are NEVER server-rendered — refuse here as defense in depth.
    case 'toggle-button':
    case 'submit-form':
      return null;
    default:
      return null;
  }
}

/**
 * Type-safe render of a PERSONALIZED (personalized:true) descriptor inside the client island. The switch
 * narrows the union, so each interactive component receives its EXACT typed props PLUS the BINDING module
 * (the own-mount source of truth — the widget enforces own-mount on its action paths from this name) PLUS
 * the `getAccessToken` getter so its POST-back carries the same Bearer auth the island's GET used (the
 * store-module proxy reads the customer ONLY from Bearer; a guest sends none). Returns `null` for a
 * read-only type (defensive) or an unknown type.
 */
export function renderPersonalizedWidget(
  descriptor: WidgetDescriptor,
  module: string,
  getAccessToken: AccessTokenGetter,
): ReactElement | null {
  switch (descriptor.type) {
    case 'toggle-button':
      return <ToggleButton {...descriptor.props} module={module} getAccessToken={getAccessToken} />;
    case 'submit-form':
      return <SubmitForm {...descriptor.props} module={module} getAccessToken={getAccessToken} />;
    // Read-only types never render in a personalized island.
    case 'star-rating-summary':
    case 'review-list':
    case 'product-carousel':
      return null;
    default:
      return null;
  }
}
