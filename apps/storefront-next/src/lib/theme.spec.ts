import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  themeToCssVars,
  themeLogoUrl,
  fetchActiveTheme,
  validateWireAnalytics,
  type ActiveThemeView,
} from './theme';

describe('validateWireAnalytics (untrusted wire boundary)', () => {
  it('non-object / null → undefined', () => {
    expect(validateWireAnalytics(null)).toBeUndefined();
    expect(validateWireAnalytics('x')).toBeUndefined();
    expect(validateWireAnalytics([])).toBeUndefined();
  });

  it('keeps well-formed ids', () => {
    expect(
      validateWireAnalytics({ plausibleDomain: 'a.com,b.com', ga4Id: 'G-AB12', metaPixelId: '99' }),
    ).toEqual({ plausibleDomain: 'a.com,b.com', ga4Id: 'G-AB12', metaPixelId: '99' });
  });

  it('drops injection / out-of-allowlist / over-long / wrong-type values to null', () => {
    expect(
      validateWireAnalytics({
        plausibleDomain: 'a.com"><script>',
        ga4Id: 'G <bad>',
        metaPixelId: '12; x',
      }),
    ).toEqual({ plausibleDomain: null, ga4Id: null, metaPixelId: null });
    expect(validateWireAnalytics({ ga4Id: 'G' + 'x'.repeat(300) })!.ga4Id).toBeNull();
    expect(validateWireAnalytics({ metaPixelId: 42 })!.metaPixelId).toBeNull();
  });

  it('rejects the exact chars that would break out of the inline <script> JS-string sink', () => {
    // ga4Id/metaPixelId are interpolated into inline gtag/fbq string literals — none of these
    // (quote, backtick, backslash, newline, </script>) may survive the allowlist.
    for (const bad of ["G-A'", 'G-A"', 'G-A`', 'G-A\\', 'G-A\n', 'G-</script>']) {
      expect(validateWireAnalytics({ ga4Id: bad })!.ga4Id).toBeNull();
    }
    for (const bad of ["1'", '1"', '1`', '1\\', '1\n', '1</script>']) {
      expect(validateWireAnalytics({ metaPixelId: bad })!.metaPixelId).toBeNull();
    }
  });
});

describe('themeToCssVars', () => {
  it('maps recognised settings keys onto the matching CSS custom properties', () => {
    const theme: ActiveThemeView = {
      name: 'midnight',
      version: '1.0.0',
      settings: {
        primary: '#123456',
        background: '#ffffff',
        radius: '1rem',
      },
    };
    expect(themeToCssVars(theme)).toEqual({
      '--primary': '#123456',
      '--background': '#ffffff',
      '--radius': '1rem',
    });
  });

  it('ignores unknown settings keys (open-ended contract)', () => {
    const theme: ActiveThemeView = {
      name: 't',
      version: '1.0.0',
      settings: { primary: '#000', someFutureKey: 'nope', logoUrl: 'https://x/y.png' },
    };
    expect(themeToCssVars(theme)).toEqual({ '--primary': '#000' });
  });

  it('falls back fully (empty object) when theme is null', () => {
    expect(themeToCssVars(null)).toEqual({});
  });

  it('falls back fully (empty object) when theme is undefined', () => {
    expect(themeToCssVars(undefined)).toEqual({});
  });

  it('maps only the present keys when settings are partial', () => {
    const theme: ActiveThemeView = {
      name: 't',
      version: '1.0.0',
      settings: { primary: '#abc' },
    };
    expect(themeToCssVars(theme)).toEqual({ '--primary': '#abc' });
  });

  it('omits non-string / malformed / unsafe values (graceful fallback, no injection)', () => {
    const theme: ActiveThemeView = {
      name: 't',
      version: '1.0.0',
      settings: {
        primary: 123, // not a string
        background: '', // empty
        foreground: 'red; } body { display:none', // injection attempt
        accent: 'a'.repeat(100), // too long
        ring: '#00B9A0', // valid
      },
    };
    expect(themeToCssVars(theme)).toEqual({ '--ring': '#00B9A0' });
  });

  it('does not throw on a garbage settings shape', () => {
    const theme = { name: 't', version: '1', settings: null } as unknown as ActiveThemeView;
    expect(() => themeToCssVars(theme)).not.toThrow();
    expect(themeToCssVars(theme)).toEqual({});
  });

  it('maps font-family settings (commas/quotes/spaces, >64 chars) onto the font CSS vars', () => {
    const theme: ActiveThemeView = {
      name: 'boutique',
      version: '1.0.0',
      settings: {
        fontHeading: "Georgia, 'Times New Roman', 'Times', serif",
        fontSans:
          'Ubuntu, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      },
    };
    // A real font stack legitimately exceeds the colour rule's 64-char cap.
    expect((theme.settings.fontSans as string).length).toBeGreaterThan(64);
    expect(themeToCssVars(theme)).toEqual({
      '--font-heading': "Georgia, 'Times New Roman', 'Times', serif",
      '--font-sans':
        'Ubuntu, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    });
  });

  it('does NOT emit any font var by default (null theme → headings stay sans)', () => {
    expect(themeToCssVars(null)).toEqual({});
    expect(themeToCssVars({ name: 't', version: '1', settings: {} })).toEqual({});
  });

  it('rejects font-family CSS-injection / dangerous values via BOTH font keys (graceful fallback)', () => {
    const dangerous = [
      'serif; } body { display:none }', // semicolon / brace breakout
      'red } * { color: red', // brace breakout
      "url('//evil/x.css')", // url() exfil/import
      'var(--x)', // var() function
      'serif<script>', // angle-bracket markup
      '@import "x"', // at-rule import
      'serif /* injected */ , monospace', // CSS comment
      'serif\\65', // backslash escape
      'serif\n', // trailing newline (JS `$` quirk)
      'serif\r\nbody{}', // CRLF + breakout
      'Arial(injected)', // parentheses (function call)
      'A'.repeat(201), // over the font-family length cap
    ];
    for (const bad of dangerous) {
      // Same code path, but pin rejection through EACH mapped font key (fontHeading + fontSans).
      expect(themeToCssVars({ name: 't', version: '1', settings: { fontHeading: bad } })).toEqual(
        {},
      );
      expect(themeToCssVars({ name: 't', version: '1', settings: { fontSans: bad } })).toEqual({});
    }
  });

  it('rejects a non-string font value', () => {
    expect(
      themeToCssVars({ name: 't', version: '1', settings: { fontSans: 42 as unknown as string } }),
    ).toEqual({});
  });

  it('keeps color/radius mapping unchanged when fonts are also present', () => {
    const theme: ActiveThemeView = {
      name: 't',
      version: '1',
      settings: {
        primary: '#123456',
        radius: '1rem',
        fontHeading: "Georgia, 'Times New Roman', serif",
      },
    };
    expect(themeToCssVars(theme)).toEqual({
      '--primary': '#123456',
      '--radius': '1rem',
      '--font-heading': "Georgia, 'Times New Roman', serif",
    });
  });
});

describe('themeLogoUrl', () => {
  it('returns a safe logo URL from settings', () => {
    const theme: ActiveThemeView = {
      name: 't',
      version: '1',
      settings: { logoUrl: 'https://cdn.example/logo.png' },
    };
    expect(themeLogoUrl(theme)).toBe('https://cdn.example/logo.png');
  });

  it('returns undefined when absent or null theme', () => {
    expect(themeLogoUrl(null)).toBeUndefined();
    expect(themeLogoUrl({ name: 't', version: '1', settings: {} })).toBeUndefined();
  });

  it('accepts a long CDN https URL (>64 chars — not bound by the CSS-value rule)', () => {
    const longUrl =
      'https://cdn.example.com/tenants/abcdef/assets/branding/primary-logo-2x-wide.png?v=20260616';
    expect(longUrl.length).toBeGreaterThan(64);
    expect(themeLogoUrl({ name: 't', version: '1', settings: { logoUrl: longUrl } })).toBe(longUrl);
  });

  it('accepts a root-relative path', () => {
    expect(
      themeLogoUrl({ name: 't', version: '1', settings: { logoUrl: '/uploads/logo.svg' } }),
    ).toBe('/uploads/logo.svg');
  });

  it('rejects javascript:/data:/protocol-relative and non-string logo URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '//evil.example/logo.png',
      'ftp://x/y.png',
      123 as unknown as string,
    ]) {
      expect(themeLogoUrl({ name: 't', version: '1', settings: { logoUrl: bad } })).toBeUndefined();
    }
  });
});

describe('fetchActiveTheme', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the theme JSON the API responds with', async () => {
    const theme = { name: 'midnight', version: '1.0.0', settings: { primary: '#000' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(theme), { status: 200 })),
    );
    const result = await fetchActiveTheme();
    expect(result).toEqual(theme);
  });

  it('returns null when the API responds with null (no active theme)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('null', { status: 200 })),
    );
    expect(await fetchActiveTheme()).toBeNull();
  });

  it('returns null (no crash) when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await fetchActiveTheme()).toBeNull();
  });
});

/**
 * `fetchActiveTheme` DEFENSIVELY validates the wire `templates`.
 * The API validated templates at install, but at fetch they are treated as UNTRUSTED (defense in
 * depth): each is re-parsed through theme-sdk's `parseTemplate` and kept ONLY when it parses AND its
 * `page` matches the key. Invalid / page-mismatched / over-bound / unknown-key templates are DROPPED
 * (never thrown), so a bad wire template silently falls back to the bundled set. A theme with NO valid
 * templates (and the default theme) yields a view with `templates` ABSENT.
 */
describe('fetchActiveTheme — wire templates (defensive)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Stub the global fetch so `GET /store/v1/theme` returns `body` as JSON. */
  function stubThemeResponse(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  }

  /** A minimal VALID template for `page` (one known-shaped section; `parseTemplate` accepts it). */
  function validTemplate(page: string): Record<string, unknown> {
    return { page, sections: [{ type: 'hero' }] };
  }

  it('keeps valid wire templates (re-validated to ThemeTemplate, page matches key)', async () => {
    stubThemeResponse({
      name: 'midnight',
      version: '1.0.0',
      settings: { primary: '#000' },
      templates: { home: validTemplate('home'), product: validTemplate('product') },
    });
    const result = await fetchActiveTheme();
    expect(result?.templates?.home).toEqual({ page: 'home', sections: [{ type: 'hero' }] });
    expect(result?.templates?.product).toEqual({ page: 'product', sections: [{ type: 'hero' }] });
    // The non-template view fields are preserved verbatim.
    expect(result?.name).toBe('midnight');
    expect(result?.settings).toEqual({ primary: '#000' });
  });

  it('DROPS a wire template whose validated `page` does NOT match its key (page-mismatch)', async () => {
    stubThemeResponse({
      name: 't',
      version: '1',
      settings: {},
      // Filed under `home` but the body declares `product` → dropped (no valid templates remain).
      templates: { home: validTemplate('product') },
    });
    const result = await fetchActiveTheme();
    expect(result?.templates).toBeUndefined();
  });

  it('DROPS a wire template of the wrong SHAPE without throwing (sections not an array)', async () => {
    stubThemeResponse({
      name: 't',
      version: '1',
      settings: {},
      // `sections` is not an array → schema rejects → dropped; valid `product` is kept.
      templates: {
        home: { page: 'home', sections: 'not-an-array' },
        product: validTemplate('product'),
      },
    });
    const result = await fetchActiveTheme();
    expect(result?.templates?.home).toBeUndefined();
    expect(result?.templates?.product).toEqual({ page: 'product', sections: [{ type: 'hero' }] });
  });

  it('DROPS an OVER-BOUND wire template (> max sections) without throwing', async () => {
    // 65 sections exceeds the theme-sdk MAX_SECTIONS (64) cap → parseTemplate rejects → dropped. Makes
    // the storefront-side guarantee explicit (the cap is enforced by parseTemplate, re-asserted here).
    const overBound = {
      page: 'home',
      sections: Array.from({ length: 65 }, () => ({ type: 'hero' })),
    };
    stubThemeResponse({
      name: 't',
      version: '1',
      settings: {},
      templates: { home: overBound, product: validTemplate('product') },
    });
    const result = await fetchActiveTheme();
    expect(result?.templates?.home).toBeUndefined();
    // A sibling valid template is unaffected (the drop is per-page).
    expect(result?.templates?.product).toEqual({ page: 'product', sections: [{ type: 'hero' }] });
  });

  it('DROPS an explicit null wire entry without throwing (`{ home: null }`)', async () => {
    stubThemeResponse({
      name: 't',
      version: '1',
      settings: {},
      templates: { home: null, product: validTemplate('product') },
    });
    const result = await fetchActiveTheme();
    expect(result?.templates?.home).toBeUndefined();
    expect(result?.templates?.product).toEqual({ page: 'product', sections: [{ type: 'hero' }] });
  });

  it('DROPS a wire template with unknown top-level keys (.strict) without throwing', async () => {
    stubThemeResponse({
      name: 't',
      version: '1',
      settings: {},
      templates: { home: { page: 'home', sections: [{ type: 'hero' }], evil: true } },
    });
    const result = await fetchActiveTheme();
    expect(result?.templates).toBeUndefined();
  });

  it('IGNORES keys outside PAGE_TYPES (unknown page key never appears in the view)', async () => {
    stubThemeResponse({
      name: 't',
      version: '1',
      settings: {},
      templates: { home: validTemplate('home'), not_a_page: validTemplate('home') },
    });
    const result = await fetchActiveTheme();
    expect(result?.templates?.home).toBeDefined();
    expect((result?.templates as Record<string, unknown>)['not_a_page']).toBeUndefined();
  });

  it('leaves `templates` ABSENT when the wire response has none (default / no installed theme)', async () => {
    stubThemeResponse({ name: 'default', version: '1.0.0', settings: {} });
    const result = await fetchActiveTheme();
    expect(result).not.toBeNull();
    expect(result?.templates).toBeUndefined();
  });

  it('leaves `templates` ABSENT when `templates` is a garbage non-object (array)', async () => {
    stubThemeResponse({
      name: 't',
      version: '1',
      settings: {},
      templates: [validTemplate('home')],
    });
    const result = await fetchActiveTheme();
    expect(result?.templates).toBeUndefined();
  });

  it('still returns null on a transport error regardless of templates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await fetchActiveTheme()).toBeNull();
  });
});
