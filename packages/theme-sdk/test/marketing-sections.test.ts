import { describe, it, expect } from 'vitest';
import {
  MARKETING_SECTION_TYPES,
  MARKETING_SECTION_REGISTRY,
  marketingHrefSchema,
  marketingImageUrlSchema,
  heroBannerSettingsSchema,
  ctaBannerSettingsSchema,
  promoTilesSettingsSchema,
  richTextSettingsSchema,
  parseMarketingSectionSettings,
  parseMarketingSection,
} from '../src/index.js';
import type {
  HeroBannerSettings,
  CtaBannerSettings,
  PromoTilesSettings,
  RichTextSettings,
  MarketingSectionDescriptor,
} from '../src/index.js';

// ── valid fixture factories ────────────────────────────────────────────────────

function validHeroBanner(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageUrl: '/img/banner.jpg',
    headline: 'Summer Collection',
    subheadline: 'Up to 40% off selected styles',
    ctaLabel: 'Shop now',
    ctaHref: '/products',
    align: 'center',
    overlay: true,
    ...over,
  };
}

function validCtaBanner(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headline: 'Free shipping on orders over €50',
    body: 'Applies to standard delivery within the EU.',
    ctaLabel: 'See details',
    ctaHref: '/shipping',
    variant: 'primary',
    ...over,
  };
}

function validPromoTiles(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    columns: 3,
    tiles: [
      { label: 'Men', href: '/men', imageUrl: '/img/men.jpg' },
      { label: 'Women', href: '/women', caption: 'New arrivals' },
      { label: 'Kids', href: '/kids' },
    ],
    ...over,
  };
}

function validRichText(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    markdown: '## Hello\n\nThis is a **paragraph**.',
    ...over,
  };
}

// ── MARKETING_SECTION_TYPES ────────────────────────────────────────────────────

describe('MARKETING_SECTION_TYPES', () => {
  it('contains exactly the four expected types', () => {
    expect(MARKETING_SECTION_TYPES).toEqual([
      'hero-banner',
      'cta-banner',
      'promo-tiles',
      'rich-text',
    ]);
  });

  it('every type matches SECTION_TYPE_RE (/^[a-z][a-z0-9-]*$/)', () => {
    const re = /^[a-z][a-z0-9-]*$/;
    for (const t of MARKETING_SECTION_TYPES) {
      expect(re.test(t)).toBe(true);
    }
  });
});

// ── MARKETING_SECTION_REGISTRY ─────────────────────────────────────────────────

describe('MARKETING_SECTION_REGISTRY', () => {
  it('has a schema entry for every type in MARKETING_SECTION_TYPES', () => {
    for (const t of MARKETING_SECTION_TYPES) {
      expect(MARKETING_SECTION_REGISTRY[t]).toBeDefined();
    }
  });
});

// ── marketingHrefSchema ────────────────────────────────────────────────────────

describe('marketingHrefSchema', () => {
  it('accepts root-relative paths', () => {
    expect(marketingHrefSchema.safeParse('/products').success).toBe(true);
    expect(marketingHrefSchema.safeParse('/').success).toBe(true);
    expect(marketingHrefSchema.safeParse('/collections/summer-2026').success).toBe(true);
  });

  it('accepts absolute http and https URLs', () => {
    expect(marketingHrefSchema.safeParse('https://example.com/promo').success).toBe(true);
    expect(marketingHrefSchema.safeParse('http://example.com/').success).toBe(true);
  });

  it('rejects javascript: scheme', () => {
    expect(marketingHrefSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(marketingHrefSchema.safeParse('JAVASCRIPT:void(0)').success).toBe(false);
  });

  it('rejects data: scheme', () => {
    expect(marketingHrefSchema.safeParse('data:text/html,<h1>x</h1>').success).toBe(false);
  });

  it('rejects protocol-relative URLs (//host)', () => {
    expect(marketingHrefSchema.safeParse('//evil.example.com/path').success).toBe(false);
  });

  it('rejects bare strings without a leading slash or http(s)://', () => {
    expect(marketingHrefSchema.safeParse('evil.example.com').success).toBe(false);
    expect(marketingHrefSchema.safeParse('ftp://files.example.com').success).toBe(false);
  });

  it('rejects an over-length href', () => {
    expect(marketingHrefSchema.safeParse('/' + 'a'.repeat(2049)).success).toBe(false);
  });
});

// ── marketingImageUrlSchema ────────────────────────────────────────────────────

describe('marketingImageUrlSchema', () => {
  it('accepts root-relative image paths', () => {
    expect(marketingImageUrlSchema.safeParse('/img/hero.jpg').success).toBe(true);
  });

  it('accepts absolute https image URLs', () => {
    expect(marketingImageUrlSchema.safeParse('https://cdn.example.com/banner.webp').success).toBe(
      true,
    );
  });

  it('rejects javascript: and data: and protocol-relative', () => {
    expect(marketingImageUrlSchema.safeParse('javascript:0').success).toBe(false);
    expect(marketingImageUrlSchema.safeParse('data:image/png;base64,abc').success).toBe(false);
    expect(marketingImageUrlSchema.safeParse('//cdn.evil.com/img.png').success).toBe(false);
  });

  it('rejects an over-length URL (> 2048 chars)', () => {
    expect(marketingImageUrlSchema.safeParse('/' + 'x'.repeat(2049)).success).toBe(false);
  });
});

// ── hero-banner ────────────────────────────────────────────────────────────────

describe('heroBannerSettingsSchema — valid', () => {
  it('accepts a full valid hero-banner', () => {
    expect(heroBannerSettingsSchema.safeParse(validHeroBanner()).success).toBe(true);
  });

  it('accepts a minimal hero-banner (headline only)', () => {
    expect(heroBannerSettingsSchema.safeParse({ headline: 'Hello' }).success).toBe(true);
  });

  it('accepts each align value', () => {
    for (const align of ['left', 'center', 'right']) {
      expect(heroBannerSettingsSchema.safeParse(validHeroBanner({ align })).success).toBe(true);
    }
  });

  it('accepts overlay: false', () => {
    expect(heroBannerSettingsSchema.safeParse(validHeroBanner({ overlay: false })).success).toBe(
      true,
    );
  });

  it('produces the correct inferred type', () => {
    const r = heroBannerSettingsSchema.safeParse(validHeroBanner());
    const s = r.success ? (r.data as HeroBannerSettings) : null;
    expect(s?.headline).toBe('Summer Collection');
    expect(s?.align).toBe('center');
  });
});

describe('heroBannerSettingsSchema — rejections', () => {
  it('rejects missing headline (required)', () => {
    const { headline: _, ...rest } = validHeroBanner() as Record<string, unknown>;
    expect(heroBannerSettingsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects headline over 160 chars', () => {
    expect(
      heroBannerSettingsSchema.safeParse(validHeroBanner({ headline: 'x'.repeat(161) })).success,
    ).toBe(false);
  });

  it('rejects subheadline over 300 chars', () => {
    expect(
      heroBannerSettingsSchema.safeParse(validHeroBanner({ subheadline: 'x'.repeat(301) })).success,
    ).toBe(false);
  });

  it('rejects ctaLabel over 80 chars', () => {
    expect(
      heroBannerSettingsSchema.safeParse(validHeroBanner({ ctaLabel: 'x'.repeat(81) })).success,
    ).toBe(false);
  });

  it('rejects an unsafe ctaHref (javascript:)', () => {
    expect(
      heroBannerSettingsSchema.safeParse(validHeroBanner({ ctaHref: 'javascript:void(0)' }))
        .success,
    ).toBe(false);
  });

  it('rejects an unsafe imageUrl (data: scheme)', () => {
    expect(
      heroBannerSettingsSchema.safeParse(validHeroBanner({ imageUrl: 'data:image/png;base64,abc' }))
        .success,
    ).toBe(false);
  });

  it('rejects an invalid align value', () => {
    expect(heroBannerSettingsSchema.safeParse(validHeroBanner({ align: 'justify' })).success).toBe(
      false,
    );
  });

  it('rejects non-boolean overlay', () => {
    expect(heroBannerSettingsSchema.safeParse(validHeroBanner({ overlay: 1 })).success).toBe(false);
  });

  it('rejects unknown keys (.strict)', () => {
    expect(heroBannerSettingsSchema.safeParse(validHeroBanner({ rogue: true })).success).toBe(
      false,
    );
  });
});

// ── cta-banner ────────────────────────────────────────────────────────────────

describe('ctaBannerSettingsSchema — valid', () => {
  it('accepts a full valid cta-banner', () => {
    expect(ctaBannerSettingsSchema.safeParse(validCtaBanner()).success).toBe(true);
  });

  it('accepts a minimal cta-banner (headline + ctaLabel + ctaHref)', () => {
    expect(
      ctaBannerSettingsSchema.safeParse({
        headline: 'Flash sale',
        ctaLabel: 'Shop',
        ctaHref: '/sale',
      }).success,
    ).toBe(true);
  });

  it('accepts variant primary and secondary', () => {
    for (const variant of ['primary', 'secondary']) {
      expect(ctaBannerSettingsSchema.safeParse(validCtaBanner({ variant })).success).toBe(true);
    }
  });

  it('produces the correct inferred type', () => {
    const r = ctaBannerSettingsSchema.safeParse(validCtaBanner());
    const s = r.success ? (r.data as CtaBannerSettings) : null;
    expect(s?.ctaHref).toBe('/shipping');
    expect(s?.variant).toBe('primary');
  });
});

describe('ctaBannerSettingsSchema — rejections', () => {
  it('rejects missing headline', () => {
    const { headline: _, ...rest } = validCtaBanner() as Record<string, unknown>;
    expect(ctaBannerSettingsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing ctaLabel', () => {
    const { ctaLabel: _, ...rest } = validCtaBanner() as Record<string, unknown>;
    expect(ctaBannerSettingsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing ctaHref', () => {
    const { ctaHref: _, ...rest } = validCtaBanner() as Record<string, unknown>;
    expect(ctaBannerSettingsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects headline over 160 chars', () => {
    expect(
      ctaBannerSettingsSchema.safeParse(validCtaBanner({ headline: 'x'.repeat(161) })).success,
    ).toBe(false);
  });

  it('rejects body over 600 chars', () => {
    expect(
      ctaBannerSettingsSchema.safeParse(validCtaBanner({ body: 'x'.repeat(601) })).success,
    ).toBe(false);
  });

  it('rejects ctaLabel over 80 chars', () => {
    expect(
      ctaBannerSettingsSchema.safeParse(validCtaBanner({ ctaLabel: 'x'.repeat(81) })).success,
    ).toBe(false);
  });

  it('rejects an unsafe ctaHref (//evil.com)', () => {
    expect(
      ctaBannerSettingsSchema.safeParse(validCtaBanner({ ctaHref: '//evil.com' })).success,
    ).toBe(false);
  });

  it('rejects an invalid variant', () => {
    expect(ctaBannerSettingsSchema.safeParse(validCtaBanner({ variant: 'danger' })).success).toBe(
      false,
    );
  });

  it('rejects unknown keys (.strict)', () => {
    expect(ctaBannerSettingsSchema.safeParse(validCtaBanner({ rogue: 'x' })).success).toBe(false);
  });
});

// ── promo-tiles ───────────────────────────────────────────────────────────────

describe('promoTilesSettingsSchema — valid', () => {
  it('accepts a full valid promo-tiles', () => {
    expect(promoTilesSettingsSchema.safeParse(validPromoTiles()).success).toBe(true);
  });

  it('accepts columns 2, 3, 4', () => {
    for (const columns of [2, 3, 4]) {
      expect(promoTilesSettingsSchema.safeParse(validPromoTiles({ columns })).success).toBe(true);
    }
  });

  it('accepts tiles without optional imageUrl / caption', () => {
    const tiles = [{ label: 'Sale', href: '/sale' }];
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(true);
  });

  it('accepts exactly 12 tiles (the cap)', () => {
    const tiles = Array.from({ length: 12 }, (_, i) => ({ label: `T${i}`, href: '/x' }));
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(true);
  });

  it('produces the correct inferred type', () => {
    const r = promoTilesSettingsSchema.safeParse(validPromoTiles());
    const s = r.success ? (r.data as PromoTilesSettings) : null;
    expect(s?.columns).toBe(3);
    expect(s?.tiles[0]?.label).toBe('Men');
  });
});

describe('promoTilesSettingsSchema — rejections', () => {
  it('rejects missing tiles (required)', () => {
    const { tiles: _, ...rest } = validPromoTiles() as Record<string, unknown>;
    expect(promoTilesSettingsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty tiles array', () => {
    expect(promoTilesSettingsSchema.safeParse(validPromoTiles({ tiles: [] })).success).toBe(false);
  });

  it('rejects more than 12 tiles', () => {
    const tiles = Array.from({ length: 13 }, (_, i) => ({ label: `T${i}`, href: '/x' }));
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(false);
  });

  it('rejects columns 1 and 5 (only 2|3|4 are valid)', () => {
    const withTiles = { tiles: [{ label: 'A', href: '/a' }] };
    expect(promoTilesSettingsSchema.safeParse({ ...withTiles, columns: 1 }).success).toBe(false);
    expect(promoTilesSettingsSchema.safeParse({ ...withTiles, columns: 5 }).success).toBe(false);
  });

  it('rejects a tile missing label', () => {
    const tiles = [{ href: '/men' }];
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(false);
  });

  it('rejects a tile missing href', () => {
    const tiles = [{ label: 'Men' }];
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(false);
  });

  it('rejects a tile with label over 120 chars', () => {
    const tiles = [{ label: 'x'.repeat(121), href: '/x' }];
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(false);
  });

  it('rejects a tile with caption over 300 chars', () => {
    const tiles = [{ label: 'A', href: '/a', caption: 'x'.repeat(301) }];
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(false);
  });

  it('rejects a tile with an unsafe href (javascript:)', () => {
    const tiles = [{ label: 'A', href: 'javascript:alert(1)' }];
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(false);
  });

  it('rejects a tile with an unsafe imageUrl (data:)', () => {
    const tiles = [{ label: 'A', href: '/a', imageUrl: 'data:image/png;base64,abc' }];
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(false);
  });

  it('rejects unknown keys on a tile (.strict)', () => {
    const tiles = [{ label: 'A', href: '/a', rogue: true }];
    expect(promoTilesSettingsSchema.safeParse({ tiles }).success).toBe(false);
  });

  it('rejects unknown keys on the settings object (.strict)', () => {
    expect(promoTilesSettingsSchema.safeParse(validPromoTiles({ extra: 'x' })).success).toBe(false);
  });
});

// ── rich-text ──────────────────────────────────────────────────────────────────

describe('richTextSettingsSchema — valid', () => {
  it('accepts valid markdown', () => {
    expect(richTextSettingsSchema.safeParse(validRichText()).success).toBe(true);
  });

  it('accepts an empty string (no required length on markdown)', () => {
    expect(richTextSettingsSchema.safeParse({ markdown: '' }).success).toBe(true);
  });

  it('accepts markdown at the 50 000-char boundary', () => {
    expect(richTextSettingsSchema.safeParse({ markdown: 'x'.repeat(50_000) }).success).toBe(true);
  });

  it('produces the correct inferred type', () => {
    const r = richTextSettingsSchema.safeParse(validRichText());
    const s = r.success ? (r.data as RichTextSettings) : null;
    expect(s?.markdown).toContain('## Hello');
  });
});

describe('richTextSettingsSchema — rejections', () => {
  it('rejects missing markdown (required field)', () => {
    expect(richTextSettingsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects markdown over 50 000 chars', () => {
    expect(richTextSettingsSchema.safeParse({ markdown: 'x'.repeat(50_001) }).success).toBe(false);
  });

  it('rejects non-string markdown', () => {
    expect(richTextSettingsSchema.safeParse({ markdown: 42 }).success).toBe(false);
    expect(richTextSettingsSchema.safeParse({ markdown: null }).success).toBe(false);
  });

  it('rejects unknown keys (.strict)', () => {
    expect(richTextSettingsSchema.safeParse(validRichText({ rogue: 'x' })).success).toBe(false);
  });
});

// ── parseMarketingSectionSettings ─────────────────────────────────────────────

describe('parseMarketingSectionSettings', () => {
  it('returns typed settings for each known type', () => {
    expect(parseMarketingSectionSettings('hero-banner', validHeroBanner())).not.toBeNull();
    expect(parseMarketingSectionSettings('cta-banner', validCtaBanner())).not.toBeNull();
    expect(parseMarketingSectionSettings('promo-tiles', validPromoTiles())).not.toBeNull();
    expect(parseMarketingSectionSettings('rich-text', validRichText())).not.toBeNull();
  });

  it('returns null for an unknown section type', () => {
    expect(parseMarketingSectionSettings('marquee', validHeroBanner())).toBeNull();
    expect(parseMarketingSectionSettings('', {})).toBeNull();
  });

  it('returns null when settings fail schema validation', () => {
    // headline is required for hero-banner
    expect(parseMarketingSectionSettings('hero-banner', {})).toBeNull();
    // ctaHref is required for cta-banner
    expect(
      parseMarketingSectionSettings('cta-banner', { headline: 'X', ctaLabel: 'Y' }),
    ).toBeNull();
    // tiles is required and must be non-empty for promo-tiles
    expect(parseMarketingSectionSettings('promo-tiles', { tiles: [] })).toBeNull();
    // markdown is required for rich-text
    expect(parseMarketingSectionSettings('rich-text', {})).toBeNull();
  });

  it('returns null for an oversized string value', () => {
    expect(
      parseMarketingSectionSettings('hero-banner', validHeroBanner({ headline: 'x'.repeat(161) })),
    ).toBeNull();
  });

  it('returns null for an unsafe URL', () => {
    expect(
      parseMarketingSectionSettings(
        'hero-banner',
        validHeroBanner({ ctaHref: 'javascript:void(0)' }),
      ),
    ).toBeNull();
    expect(
      parseMarketingSectionSettings('cta-banner', validCtaBanner({ ctaHref: '//evil.com' })),
    ).toBeNull();
  });

  it('returns null for an over-size tiles array (> 12)', () => {
    const tiles = Array.from({ length: 13 }, (_, i) => ({ label: `T${i}`, href: '/x' }));
    expect(parseMarketingSectionSettings('promo-tiles', { tiles })).toBeNull();
  });

  it('never throws — returns null on any input type', () => {
    expect(parseMarketingSectionSettings('hero-banner', null)).toBeNull();
    expect(parseMarketingSectionSettings('hero-banner', undefined)).toBeNull();
    expect(parseMarketingSectionSettings('hero-banner', 42)).toBeNull();
    expect(parseMarketingSectionSettings('hero-banner', 'a string')).toBeNull();
  });
});

// ── parseMarketingSection ─────────────────────────────────────────────────────

describe('parseMarketingSection', () => {
  it('parses a valid hero-banner descriptor', () => {
    const result = parseMarketingSection({ type: 'hero-banner', settings: validHeroBanner() });
    expect(result).not.toBeNull();
    expect(result?.type).toBe('hero-banner');
    expect((result as MarketingSectionDescriptor & { type: 'hero-banner' }).settings.headline).toBe(
      'Summer Collection',
    );
  });

  it('parses each of the four section types', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['hero-banner', validHeroBanner()],
      ['cta-banner', validCtaBanner()],
      ['promo-tiles', validPromoTiles()],
      ['rich-text', validRichText()],
    ];
    for (const [type, settings] of cases) {
      const result = parseMarketingSection({ type, settings });
      expect(result).not.toBeNull();
      expect(result?.type).toBe(type);
    }
  });

  it('returns null for an unknown type', () => {
    expect(parseMarketingSection({ type: 'video-hero', settings: {} })).toBeNull();
  });

  it('returns null when settings are invalid', () => {
    expect(parseMarketingSection({ type: 'hero-banner', settings: {} })).toBeNull();
  });

  it('returns null for non-object inputs', () => {
    expect(parseMarketingSection(null)).toBeNull();
    expect(parseMarketingSection(undefined)).toBeNull();
    expect(parseMarketingSection(42)).toBeNull();
    expect(parseMarketingSection('a string')).toBeNull();
    expect(parseMarketingSection([{ type: 'hero-banner' }])).toBeNull();
  });

  it('returns null when type is not a string', () => {
    expect(parseMarketingSection({ type: 42, settings: {} })).toBeNull();
  });

  it('never throws — always returns null on any failure', () => {
    expect(() => parseMarketingSection({ type: 'hero-banner', settings: null })).not.toThrow();
    expect(parseMarketingSection({ type: 'hero-banner', settings: null })).toBeNull();
  });
});

// ── type exports usable ────────────────────────────────────────────────────────

describe('type exports', () => {
  it('exported types are usable for typed consumers', () => {
    const hero: HeroBannerSettings = { headline: 'Sale' };
    const cta: CtaBannerSettings = { headline: 'Join', ctaLabel: 'Sign up', ctaHref: '/signup' };
    const promo: PromoTilesSettings = { tiles: [{ label: 'A', href: '/a' }] };
    const rich: RichTextSettings = { markdown: '# Hello' };

    expect(hero.headline).toBe('Sale');
    expect(cta.ctaHref).toBe('/signup');
    expect(promo.tiles[0]?.label).toBe('A');
    expect(rich.markdown).toBe('# Hello');
  });
});
