'use client';

/**
 * Client `columns` layout primitive — the CLIENT counterpart of the server `ColumnsSection`, for
 * client-rendered pages (the cart). It places the renderer-supplied `regions` into a two-region
 * wrapper whose classes come from the template `settings`, so the cart template can reproduce its
 * verbatim 2-column grid (`grid gap-8 lg:grid-cols-[1fr_20rem]`) with the left column wrapped in
 * `flex flex-col gap-6` and the summary `<aside>` bare on the right.
 *
 * Mirrors the server primitive's wrapper semantics: `containerClass` (default = the PLP sidebar
 * grid), `leftClass` (absent → bare), `rightClass` (default = the PLP results column; explicit
 * empty string → bare; any other value = that wrapper). A region with no nodes contributes nothing.
 * Unlike the server section there is no loader (client sections read context); the `settings` +
 * pre-rendered `regions` are threaded in by `renderClientSections` from the template (the cart
 * template carries the grid classes).
 */
import type { ReactNode } from 'react';

/** Default region names + wrapper classes — kept in lockstep with the server `ColumnsSection`. */
const DEFAULT_LEFT = 'left';
const DEFAULT_RIGHT = 'right';
const DEFAULT_CONTAINER_CLASS = 'flex flex-col gap-8 sm:flex-row';
const DEFAULT_RIGHT_CLASS = 'min-w-0 flex-1';

/** The opaque layout settings a client columns section is configured with (mirrors the server bag). */
export type ClientColumnsSettings = Record<string, unknown>;

/** Read a string setting, or the supplied default when absent/non-string/empty. */
function str(settings: ClientColumnsSettings, key: string, fallback: string): string {
  const v = settings[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** Resolve a wrapper class that may be EXPLICITLY suppressed (empty string → bare; absent → fallback). */
function wrapperClass(
  settings: ClientColumnsSettings,
  key: string,
  fallback: string | undefined,
): string | undefined {
  const v = settings[key];
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  return fallback;
}

/** Wrap a region's nodes in a `<div className>` when a wrapper class is set, else render them bare. */
function wrap(nodes: ReactNode, cls: string | undefined): ReactNode {
  return cls ? <div className={cls}>{nodes}</div> : nodes;
}

/**
 * Render a client columns layout for the supplied `settings` + pre-rendered `regions`. Exported as a
 * factory the cart registry binds with the cart's verbatim grid settings (the client renderer doesn't
 * thread settings to sections, so the layout's classes are bound at registry time).
 */
export function ClientColumns({
  settings,
  regions,
}: {
  settings: ClientColumnsSettings;
  regions?: Record<string, ReactNode[]>;
}) {
  const leftName = str(settings, 'left', DEFAULT_LEFT);
  const rightName = str(settings, 'right', DEFAULT_RIGHT);
  const containerClass = str(settings, 'containerClass', DEFAULT_CONTAINER_CLASS);
  const leftClass = wrapperClass(settings, 'leftClass', undefined);
  const rightClass = wrapperClass(settings, 'rightClass', DEFAULT_RIGHT_CLASS);

  const left = regions?.[leftName] ?? [];
  const right = regions?.[rightName] ?? [];

  return (
    <div className={containerClass}>
      {wrap(left, leftClass)}
      {wrap(right, rightClass)}
    </div>
  );
}
