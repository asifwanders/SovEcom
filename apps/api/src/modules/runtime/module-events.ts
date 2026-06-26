/**
 * the module event contract.
 *
 * A module may SUBSCRIBE to a CURATED allowlist of canonical core domain events (and to other
 * modules' `mod.<name>.*` events), and may EMIT its own events — always namespaced `mod.<self>.*`
 * so a module can NEVER forge a core event or impersonate another module. Core fans a matching
 * domain event to every subscribed, enabled worker (tenant-scoped, fire-and-forget).
 */

/** Canonical core events a module may subscribe to (mirrors the 2.12b webhook event set). */
export const SUBSCRIBABLE_CORE_EVENTS = [
  'order.created',
  'order.paid',
  'order.shipped',
  'order.cancelled',
  'order.refunded',
  'order.partially_refunded',
  'refund.issued',
  'product.created',
  'product.updated',
  'product.deleted',
  // Follow-up B2 — OBSERVATIONAL commerce signals (emitted post-change, modules only observe):
  'product.price_changed',
  'product.stock_changed',
] as const;

export type SubscribableCoreEvent = (typeof SUBSCRIBABLE_CORE_EVENTS)[number];

// Follow-up B2 — the MODULE-FACING payload contracts for the two observational commerce events are
// owned by the published SDK (single source of truth), so what core fans to a worker can never
// drift from what a module author types against. Re-exported here for the core-side listener.
export type { ProductPriceChangedPayload, ProductStockChangedPayload } from '@sovecom/module-sdk';

const CORE_SET: ReadonlySet<string> = new Set(SUBSCRIBABLE_CORE_EVENTS);

/** RPC method core → worker uses to deliver a subscribed event. */
export const EVENTS_DELIVER_METHOD = 'events.deliver';

/** A namespaced module event: `mod.<module-slug>.<event-slug>`. */
const MODULE_EVENT_RE = /^mod\.[a-z][a-z0-9-]*\.[a-z][a-z0-9._-]*$/;
/** The leaf name a module may emit (becomes the `<event-slug>` part). */
const EMIT_EVENT_RE = /^[a-z][a-z0-9._-]{0,63}$/;

export const MAX_SUBSCRIPTIONS_PER_MODULE = 64;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

/** True if `name` is something a module is allowed to SUBSCRIBE to (a core event or a module event). */
export function isSubscribableEvent(name: string): boolean {
  return CORE_SET.has(name) || MODULE_EVENT_RE.test(name);
}

/** True if `name` is one of the canonical core events. */
export function isCoreEvent(name: string): boolean {
  return CORE_SET.has(name);
}

/**
 * Build the namespaced name for an event a module emits. Throws if the leaf name is invalid or
 * would collide with a core event — a module can only ever emit under its own `mod.<self>.` prefix.
 */
export function namespacedModuleEvent(moduleName: string, event: string): string {
  if (!EMIT_EVENT_RE.test(event) || CORE_SET.has(event) || event.startsWith('mod.')) {
    throw new Error(`invalid module event name to emit: ${JSON.stringify(event)}`);
  }
  return `mod.${moduleName}.${event}`;
}

export interface ModuleEventEnvelope {
  readonly event: string;
  readonly payload: unknown;
}
