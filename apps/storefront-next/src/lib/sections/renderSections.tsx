/**
 * Section renderer — the runtime that turns a page TEMPLATE into rendered
 * section nodes. Given a page type + the active theme name + locale it:
 *   1. resolves the template-set for the theme (falls back to `default` for unknown/absent names);
 *   2. picks the `page` template (falls back to the `default` set's template when the theme has none);
 *   3. re-validates the template with `parseTemplate` defensively — on ANY validation failure it falls
 *      back to the `default` set's template (a corrupt template never 500s the page);
 *   4. resolves each section against the registry — an UNKNOWN `type` is SKIPPED (renders nothing,
 *      never throws), so a forward-declared section degrades gracefully;
 *   5. runs all present sections' loaders in PARALLEL (`Promise.all`), then renders each section's
 *      `<Component settings data locale />` in template order. An RSC section is AWAITED into its
 *      resolved element; a CLIENT section (`section.client` — e.g. the PDP gallery / variant selector
 *      islands) is rendered as a JSX ELEMENT (NOT awaited), with its (server) loader still
 *      passing serializable props.
 *
 * Returns the ordered React nodes; the page wraps them in its layout container. PURE of page-layout
 * concerns — it only knows sections.
 */
import { createElement, Fragment, type ReactNode } from 'react';
import {
  parseTemplate,
  type ThemeTemplate,
  type PageType,
  type TemplateSection,
} from '@sovecom/theme-sdk';
import { resolveTemplateSet, DEFAULT_THEME_NAME, type TemplateSet } from '@/themes';
import { getSection, type Section, type SectionContext } from './registry';

/** Resolve the `page` template from a set, or `undefined` when the set has no template for it. */
function templateForPage(set: TemplateSet, page: PageType): ThemeTemplate | undefined {
  return set[page];
}

/**
 * Pick the template to render for `page`, with layered fallbacks to `default`:
 *   - `wireTemplates[page]` (the active installed theme's wire-delivered template, when present) wins;
 *   - else the bundled set for `themeName` (unknown/absent name → `default` set);
 *   - theme set has no template for `page` → `default` set's `page` template;
 *   - the chosen candidate fails defensive re-validation → `default` set's `page` template.
 * The chosen candidate ALWAYS runs through the existing defensive `parseTemplate` re-validation before
 * use (a wire template is untrusted at render too — defense in depth), and on ANY failure falls back to
 * the bundled `default` template. Returns `undefined` only when NEITHER tier yields a valid template.
 */
function resolveTemplate(
  themeName: string | undefined,
  page: PageType,
  wireTemplates?: Partial<Record<PageType, ThemeTemplate>>,
): ThemeTemplate | undefined {
  const defaultSet = resolveTemplateSet(DEFAULT_THEME_NAME);
  const defaultTemplate = templateForPage(defaultSet, page);

  // Wire template for THIS page (if delivered) takes precedence over the bundled set; else fall back to
  // the bundled-by-name template, else the bundled default.
  const set = resolveTemplateSet(themeName);
  const candidate = wireTemplates?.[page] ?? templateForPage(set, page) ?? defaultTemplate;
  if (!candidate) return defaultTemplate;

  // Defensive re-validation: a bundled set is already validated, but a theme-supplied template might not be. On ANY failure fall back to the default set's template.
  try {
    return parseTemplate(JSON.stringify(candidate));
  } catch {
    return defaultTemplate;
  }
}

/** A resolved section + its template settings + its (optional) nested regions, ready to render. */
interface ResolvedSection {
  section: Section;
  settings: Record<string, unknown>;
  regions?: Record<string, TemplateSection[]>;
}

/**
 * Render an ordered list of template sections against the registry into React nodes, RECURSIVELY
 *. Used both for a page's top-level sections and for each region's nested sub-sections.
 *   - resolves each `type` against the registry, SKIPPING unknown types (graceful — never throws);
 *   - runs all present loaders in PARALLEL (`Promise.all`) within this list;
 *   - for a LAYOUT section with `regions`, recursively renders each region's sub-sections (their
 *     loaders run in parallel within the region; the regions themselves resolve concurrently because
 *     this whole list renders under one `Promise.all`) and passes the rendered node-lists to the
 *     section's `Component` via the optional `regions` prop. Non-layout sections ignore it.
 * Components are async RSCs (they call `getTranslations`), so each is awaited into a resolved element.
 */
async function renderSectionList(
  sections: readonly TemplateSection[],
  ctx: SectionContext,
): Promise<ReactNode[]> {
  // Resolve each template section against the registry, dropping unknown types (graceful skip).
  const resolved: ResolvedSection[] = [];
  for (const ts of sections) {
    const section = getSection(ts.type);
    if (!section) continue;
    resolved.push(
      ts.regions
        ? { section, settings: ts.settings ?? {}, regions: ts.regions }
        : { section, settings: ts.settings ?? {} },
    );
  }

  // Run all loaders in parallel; a section with no loader contributes `undefined` data.
  const data = await Promise.all(
    resolved.map(({ section, settings }) =>
      section.loader ? section.loader(settings, ctx) : Promise.resolve(undefined),
    ),
  );

  // Render each section's Component in template order. For a layout section, recursively render its
  // regions FIRST (the recursion's own Promise.all parallelises the nested loaders) and pass them in.
  // A CLIENT section (`section.client`) is a client island: render it as a JSX ELEMENT (it is NOT an
  // async RSC, so it must NOT be awaited); RSC sections are awaited into resolved elements as before.
  const nodes = await Promise.all(
    resolved.map(async ({ section, settings, regions }, i) => {
      const renderedRegions = regions ? await renderRegions(regions, ctx) : undefined;
      const props = renderedRegions
        ? { settings, data: data[i], locale: ctx.locale, regions: renderedRegions }
        : { settings, data: data[i], locale: ctx.locale };
      return section.client ? createElement(section.Component, props) : section.Component(props);
    }),
  );
  return nodes.map((node, i) => (
    <Fragment key={`${resolved[i]!.section.type}-${i}`}>{node}</Fragment>
  ));
}

/** Recursively render every region's sub-sections (in parallel across regions) → `name → nodes`. */
async function renderRegions(
  regions: Record<string, TemplateSection[]>,
  ctx: SectionContext,
): Promise<Record<string, ReactNode[]>> {
  const names = Object.keys(regions);
  const rendered = await Promise.all(names.map((name) => renderSectionList(regions[name]!, ctx)));
  const out: Record<string, ReactNode[]> = {};
  names.forEach((name, i) => {
    out[name] = rendered[i]!;
  });
  return out;
}

/**
 * Render the ordered section nodes for a page. See the file header for the full resolution + fallback
 * rules. Loaders run in parallel; unknown section types are skipped; never throws on a bad template.
 * A LAYOUT section's `regions` are rendered recursively.
 */
export async function renderSections({
  page,
  themeName,
  wireTemplates,
  locale,
  params,
  searchParams,
}: {
  page: PageType;
  themeName?: string;
  /**
   * The active theme's WIRE-delivered, already-defensively-validated templates. When a template is
   * present for `page` it takes precedence over the bundled set (it still passes the existing
   * `parseTemplate` re-validation + bundled fallback in `resolveTemplate`). Absent → the bundled
   * path is unchanged (byte-identical).
   */
  wireTemplates?: Partial<Record<PageType, ThemeTemplate>>;
  locale: string;
  /** Route params (e.g. `{ slug }` on the PDP) threaded to each loader's `ctx`. Home passes none. */
  params?: Record<string, string>;
  /** Request query string parsed to a flat record, threaded to each loader's `ctx`. */
  searchParams?: Record<string, string>;
}): Promise<ReactNode[]> {
  const template = resolveTemplate(themeName, page, wireTemplates);
  if (!template) return [];

  const ctx: SectionContext = { locale };
  if (params) ctx.params = params;
  if (searchParams) ctx.searchParams = searchParams;

  return renderSectionList(template.sections, ctx);
}
