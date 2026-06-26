/**
 * Generic `columns` layout primitive — a LAYOUT section with NO loader. It
 * places the renderer-supplied `regions` into a two-region wrapper. By DEFAULT it reproduces the
 * category + search PLP sidebar grid VERBATIM: an outer `flex flex-col gap-8 sm:flex-row`, a `left`
 * region (the filter sidebar, which renders its own `<aside>`), and a `right` region wrapped in the
 * `min-w-0 flex-1` results column.
 *
 * i: the wrappers are parameterizable so the SAME primitive can also emit the PDP 2-column
 * grid (`grid grid-cols-1 md:grid-cols-2 gap-8`, left bare gallery + a `space-y-6` right cell).
 * `containerClass`, `leftClass` (wraps the left region — absent → bare), and `rightClass` (wraps the
 * right region — default = the PLP results column; an explicit empty string → bare; any other value =
 * that wrapper, e.g. the PDP's `space-y-6`) all come from `settings`, defaulting to the current PLP
 * values so a template that passes no settings reproduces the existing DOM byte-for-byte. A region with
 * no nodes contributes nothing (graceful), so a template that omits a side simply leaves it empty.
 */
import type { ReactNode } from 'react';
import type { Section, SectionSettings } from '@/lib/sections/registry';

/** Default region names + wrapper classes — the verbatim pre-refactor PLP sidebar grid. */
const DEFAULT_LEFT = 'left';
const DEFAULT_RIGHT = 'right';
const DEFAULT_CONTAINER_CLASS = 'flex flex-col gap-8 sm:flex-row';
const DEFAULT_RIGHT_CLASS = 'min-w-0 flex-1';

/** Read a string `settings` value, or the supplied default when absent/non-string. */
function str(settings: SectionSettings, key: string, fallback: string): string {
  const v = settings[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * Resolve a wrapper class that may be EXPLICITLY suppressed: when the key is a string (even empty), use
 * it as-is (an empty string means "render the region bare, no wrapper div"); when absent, use the
 * default. Returns `undefined` to signal "no wrapper" (bare region), so a template can opt the PDP/cart
 * regions out of the PLP's right-column / sidebar-column wrappers (or set a different wrapper class
 * entirely, e.g. the PDP's `space-y-6` right column).
 */
function wrapperClass(
  settings: SectionSettings,
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

function Columns({
  settings,
  regions,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
  regions?: Record<string, ReactNode[]>;
}) {
  const leftName = str(settings, 'left', DEFAULT_LEFT);
  const rightName = str(settings, 'right', DEFAULT_RIGHT);
  const containerClass = str(settings, 'containerClass', DEFAULT_CONTAINER_CLASS);
  // `leftClass` defaults to BARE (the PLP left region is its own <aside>); `rightClass` defaults to the
  // verbatim PLP right (results) column. Either can be explicitly emptied to render the region bare, or
  // set to a different wrapper (the PDP sets the right column to `space-y-6`).
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

/** The registered `columns` layout section (no loader — pure layout over the rendered regions). */
export const ColumnsSection: Section = {
  type: 'columns',
  Component: Columns,
};
