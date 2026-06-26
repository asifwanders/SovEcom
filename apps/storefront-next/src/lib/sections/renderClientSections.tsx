'use client';

/**
 * the CLIENT section renderer. The server renderer (`renderSections.tsx`)
 * composes RSC sections with async data loaders; this is its client-side counterpart for pages whose
 * body is a CLIENT island reading React context (e.g. the cart, which reads `useCart()`).
 *
 * A client section has NO loader — it renders from context, not from a server fetch — so this renderer
 * is purely about ORDER + the graceful-skip contract: given an already-validated `ThemeTemplate` and a
 * client registry (`type → ClientSection`), it renders each registered section's component in template
 * order. An UNKNOWN `type` is SKIPPED (renders nothing, never throws), exactly like the server renderer,
 * so a forward-declared section degrades gracefully. The template is validated upstream (`@/themes`),
 * so this does no parsing — it stays minimal and synchronous (client components can't be async RSCs).
 *
 * It recurses into a section's `regions` (the same shape as the server side) so a CLIENT layout
 * section (e.g. the cart `columns`) can place pre-rendered region node-lists. Each region's sub-sections
 * render in template order (graceful-skip preserved) and the resulting map is handed to the layout
 * component via the optional `regions` prop. A non-layout section ignores it.
 */
import { Fragment, type ReactNode } from 'react';
import type { ThemeTemplate, TemplateSection } from '@sovecom/theme-sdk';

/**
 * The props every CLIENT section component receives from the client renderer: the section's template
 * `settings` (opaque bag — a LAYOUT section reads its wrapper classes from it) and, for a LAYOUT
 * section, the pre-rendered `regions`. A leaf section ignores both.
 */
export interface ClientSectionProps {
  settings: Record<string, unknown>;
  regions?: Record<string, ReactNode[]>;
}

/**
 * A SYNCHRONOUS React node — `ReactNode` minus React 19's `Promise<AwaitedReactNode>` arm — so the
 * compiler REJECTS an accidental async client component (the client renderer never awaits these).
 */
type SyncReactNode = Exclude<ReactNode, Promise<unknown>>;

/**
 * A registered CLIENT section: a `type` + a context-reading component (no loader, no async data). The
 * component is SYNCHRONOUS (client components can't be async RSCs) and receives {@link ClientSectionProps}.
 */
export interface ClientSection {
  type: string;
  Component: (props: ClientSectionProps) => SyncReactNode;
}

/** Render an ordered list of template sections against a client `registry` → React nodes (recursive). */
function renderClientSectionList(
  sections: readonly TemplateSection[],
  registry: Readonly<Record<string, ClientSection>>,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  sections.forEach((ts, i) => {
    const section = registry[ts.type];
    if (!section) return; // Unknown type → graceful skip (mirrors the server renderer's contract).
    // For a LAYOUT section, recursively render each region's sub-sections first, then hand them in.
    const regions = ts.regions ? renderClientRegions(ts.regions, registry) : undefined;
    const Component = section.Component;
    const settings = ts.settings ?? {};
    nodes.push(
      <Fragment key={`${section.type}-${i}`}>
        <Component settings={settings} {...(regions ? { regions } : {})} />
      </Fragment>,
    );
  });
  return nodes;
}

/** Recursively render every region's sub-sections → `name → nodes` (mirrors the server `renderRegions`). */
function renderClientRegions(
  regions: Record<string, TemplateSection[]>,
  registry: Readonly<Record<string, ClientSection>>,
): Record<string, ReactNode[]> {
  const out: Record<string, ReactNode[]> = {};
  for (const name of Object.keys(regions)) {
    out[name] = renderClientSectionList(regions[name]!, registry);
  }
  return out;
}

/**
 * Render the ordered client-section nodes for a validated page `template` against a client `registry`.
 * Unknown section types are skipped (never throws); the rest render in template order, each keyed. A
 * layout section's `regions` are rendered recursively.
 */
export function renderClientSections({
  template,
  registry,
}: {
  template: ThemeTemplate;
  registry: Readonly<Record<string, ClientSection>>;
}): ReactNode[] {
  return renderClientSectionList(template.sections, registry);
}
