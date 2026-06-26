import { describe, it, expect } from 'vitest';
import {
  parseTemplate,
  defineTemplate,
  defineSection,
  templateSchema,
  templateSectionSchema,
  pageTypeSchema,
  PAGE_TYPES,
  SECTION_TYPE_RE,
  REGION_NAME_RE,
  MAX_REGION_DEPTH,
  MANIFEST_MAX_BYTES,
} from '../src/index.js';
import type { ThemeTemplate, TemplateSection, PageType } from '../src/index.js';

/**
 * The section/JSON-template contract. These cases mirror the manifest test style: a
 * `validTemplate()` fixture + targeted rejections, all driving `parseTemplate` (the byte-cap +
 * JSON.parse + Zod pipeline) and the author helpers `defineTemplate`/`defineSection`.
 */
function validTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    page: 'home',
    sections: [
      { type: 'hero' },
      { type: 'featured-products', settings: { limit: 8 } },
      { type: 'category-list' },
    ],
    ...overrides,
  };
}

describe('parseTemplate', () => {
  it('accepts a well-formed template and returns it typed', () => {
    const t = parseTemplate(JSON.stringify(validTemplate()));
    expect(t.page).toBe('home');
    expect(t.sections).toHaveLength(3);
    expect(t.sections[0]!.type).toBe('hero');
    expect(t.sections[1]!.settings).toEqual({ limit: 8 });
    // `settings` is optional on a section.
    expect(t.sections[0]!.settings).toBeUndefined();
  });

  it('accepts a minimal template (empty sections)', () => {
    const t = parseTemplate(JSON.stringify({ page: 'home', sections: [] }));
    expect(t.sections).toEqual([]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseTemplate('{not json')).toThrow(/not valid JSON/);
  });

  it('rejects an unknown top-level key (.strict)', () => {
    const raw = JSON.stringify(validTemplate({ rogue: 'extra' }));
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects an unknown section key (.strict)', () => {
    const raw = JSON.stringify({ page: 'home', sections: [{ type: 'hero', rogue: 1 }] });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects a section missing its type', () => {
    const raw = JSON.stringify({ page: 'home', sections: [{ settings: {} }] });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects a non-slug section type', () => {
    const raw = JSON.stringify({ page: 'home', sections: [{ type: 'Hero_Section' }] });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects a non-array sections value', () => {
    const raw = JSON.stringify({ page: 'home', sections: { type: 'hero' } });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects more sections than the bound allows', () => {
    const sections = Array.from({ length: 65 }, () => ({ type: 'hero' }));
    const raw = JSON.stringify({ page: 'home', sections });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects a bad page type', () => {
    const raw = JSON.stringify(validTemplate({ page: 'dashboard' }));
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects a template exceeding the byte cap', () => {
    const raw = JSON.stringify(
      validTemplate({
        sections: [{ type: 'hero', settings: { x: 'y'.repeat(MANIFEST_MAX_BYTES) } }],
      }),
    );
    expect(() => parseTemplate(raw)).toThrow(/too large/);
  });
});

/**
 * Nested `regions` for layout composition. A layout section (e.g. `columns`) declares named
 * `regions`, each an ordered list of nested sections, recursively. `parseTemplate` validates the
 * shape + structural bounds and enforces the max nesting DEPTH; existing FLAT templates must still
 * parse unchanged.
 */
describe('parseTemplate — nested regions', () => {
  function columnsTemplate(): Record<string, unknown> {
    return {
      page: 'category',
      sections: [
        { type: 'category-header' },
        {
          type: 'columns',
          settings: { gap: '8' },
          regions: {
            left: [{ type: 'category-filter-sidebar' }],
            right: [{ type: 'category-product-grid' }, { type: 'category-pagination' }],
          },
        },
      ],
    };
  }

  it('parses a nested regions template + preserves region order', () => {
    const t = parseTemplate(JSON.stringify(columnsTemplate()));
    const columns = t.sections[1]!;
    expect(columns.type).toBe('columns');
    expect(Object.keys(columns.regions!)).toEqual(['left', 'right']);
    expect(columns.regions!.left!.map((s) => s.type)).toEqual(['category-filter-sidebar']);
    expect(columns.regions!.right!.map((s) => s.type)).toEqual([
      'category-product-grid',
      'category-pagination',
    ]);
  });

  it('the PARSED output actually carries `regions` (the z.lazy recursion is not silently dropped)', () => {
    const t = parseTemplate(JSON.stringify(columnsTemplate()));
    const columns = t.sections[1]!;
    // The whole nested structure survives the parse byte-for-byte — proves the recursive field is read.
    expect(columns.regions).toEqual({
      left: [{ type: 'category-filter-sidebar' }],
      right: [{ type: 'category-product-grid' }, { type: 'category-pagination' }],
    });
    // And a nested section's own optional `settings` round-trips through the recursion.
    const t2 = parseTemplate(
      JSON.stringify({
        page: 'category',
        sections: [{ type: 'columns', regions: { left: [{ type: 'hero', settings: { a: 1 } }] } }],
      }),
    );
    expect(t2.sections[0]!.regions!.left![0]!.settings).toEqual({ a: 1 });
  });

  it('a flat template still parses (regions optional)', () => {
    const t = parseTemplate(JSON.stringify(validTemplate()));
    expect(t.sections[0]!.regions).toBeUndefined();
  });

  it('allows nesting up to the max depth and rejects one level deeper', () => {
    // depth 1 (section inside a region) is allowed.
    const ok = {
      page: 'category',
      sections: [{ type: 'columns', regions: { left: [{ type: 'category-product-grid' }] } }],
    };
    expect(() => parseTemplate(JSON.stringify(ok))).not.toThrow();

    // depth 2 (region inside a region inside a region) exceeds MAX_REGION_DEPTH → reject.
    const tooDeep = {
      page: 'category',
      sections: [
        {
          type: 'columns',
          regions: {
            left: [
              {
                type: 'columns',
                regions: { inner: [{ type: 'columns', regions: { x: [{ type: 'hero' }] } }] },
              },
            ],
          },
        },
      ],
    };
    expect(() => parseTemplate(JSON.stringify(tooDeep))).toThrow(/max depth/);
  });

  it('rejects too many regions on one section', () => {
    const regions: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) regions[`r${i}`] = [{ type: 'hero' }];
    const raw = JSON.stringify({ page: 'category', sections: [{ type: 'columns', regions }] });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects a non-slug region name', () => {
    const raw = JSON.stringify({
      page: 'category',
      sections: [{ type: 'columns', regions: { Left_Side: [{ type: 'hero' }] } }],
    });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects an unknown key inside a nested section (.strict at every level)', () => {
    const raw = JSON.stringify({
      page: 'category',
      sections: [{ type: 'columns', regions: { left: [{ type: 'hero', rogue: 1 }] } }],
    });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects a nested section with a bad type', () => {
    const raw = JSON.stringify({
      page: 'category',
      sections: [{ type: 'columns', regions: { left: [{ type: 'Bad_Type' }] } }],
    });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('rejects more nested sections than the per-region cap', () => {
    const left = Array.from({ length: 65 }, () => ({ type: 'hero' }));
    const raw = JSON.stringify({
      page: 'category',
      sections: [{ type: 'columns', regions: { left } }],
    });
    expect(() => parseTemplate(raw)).toThrow(/invalid theme template/);
  });

  it('defineTemplate round-trips a nested regions template', () => {
    const t = defineTemplate(columnsTemplate() as never);
    expect(t.sections[1]!.regions!.left).toBeDefined();
  });
});

describe('schemas + constants', () => {
  it('PAGE_TYPES declares home plus the deferred page types', () => {
    expect(PAGE_TYPES).toContain('home');
    expect(PAGE_TYPES).toEqual(['home', 'product', 'category', 'products', 'search', 'cart']);
  });

  it('pageTypeSchema accepts a known page and rejects an unknown one', () => {
    expect(pageTypeSchema.safeParse('home').success).toBe(true);
    expect(pageTypeSchema.safeParse('nope').success).toBe(false);
  });

  it('SECTION_TYPE_RE matches the lowercase-slug shape', () => {
    expect(SECTION_TYPE_RE.test('featured-products')).toBe(true);
    expect(SECTION_TYPE_RE.test('Hero')).toBe(false);
    expect(SECTION_TYPE_RE.test('-leading')).toBe(false);
  });

  it('templateSectionSchema is .strict()', () => {
    expect(templateSectionSchema.safeParse({ type: 'hero', extra: 1 }).success).toBe(false);
  });

  it('templateSchema is .strict()', () => {
    expect(templateSchema.safeParse(validTemplate({ extra: 1 })).success).toBe(false);
  });

  it('REGION_NAME_RE matches the lowercase-slug shape', () => {
    expect(REGION_NAME_RE.test('left')).toBe(true);
    expect(REGION_NAME_RE.test('side-bar')).toBe(true);
    expect(REGION_NAME_RE.test('Left')).toBe(false);
    expect(REGION_NAME_RE.test('-bad')).toBe(false);
  });

  it('MAX_REGION_DEPTH is 2', () => {
    expect(MAX_REGION_DEPTH).toBe(2);
  });
});

describe('defineTemplate', () => {
  it('returns the validated, typed template', () => {
    const t: ThemeTemplate = defineTemplate({
      page: 'home',
      sections: [{ type: 'hero' }],
    });
    expect(t.page).toBe('home');
    expect(t.sections[0]!.type).toBe('hero');
  });

  it('throws on a non-object config', () => {
    // @ts-expect-error — author passed a non-object config
    expect(() => defineTemplate(null)).toThrow(/config must be an object/);
  });

  it('throws a clean "must be an object" error on an array (not a confusing Zod path)', () => {
    // @ts-expect-error — author passed an array; guard rejects it before the schema runs
    expect(() => defineTemplate([])).toThrow(/config must be an object/);
  });

  it('throws on an invalid page', () => {
    // @ts-expect-error — validated at runtime; type is loose enough to test the throw
    expect(() => defineTemplate({ page: 'nope', sections: [] })).toThrow(/invalid theme template/);
  });

  it('throws on an unknown top-level key (.strict)', () => {
    // @ts-expect-error — unknown key rejected by .strict()
    expect(() => defineTemplate({ page: 'home', sections: [], rogue: 1 })).toThrow(
      /invalid theme template/,
    );
  });
});

describe('defineSection', () => {
  it('returns the def unchanged (pure typing helper)', () => {
    type HeroSettings = { headline: string };
    const def = defineSection<HeroSettings>({ type: 'hero' });
    expect(def.type).toBe('hero');
    // Compile-time proof: the inferred settings type is HeroSettings.
    const settings: HeroSettings = { headline: 'Hi' };
    expect(settings.headline).toBe('Hi');
  });
});

describe('type exports', () => {
  it('PageType / TemplateSection / ThemeTemplate are usable', () => {
    const page: PageType = 'home';
    const section: TemplateSection = { type: 'hero' };
    const template: ThemeTemplate = { page, sections: [section] };
    expect(template.sections).toHaveLength(1);
  });
});
