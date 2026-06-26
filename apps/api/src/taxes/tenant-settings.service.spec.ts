/**
 * TenantSettings parse unit tests.
 *
 * The DB-backed read/write is covered by integration tests; here we pin the typed
 * defaults + the safe collapse of garbage values (the engine must never see a bad mode).
 */
import { parseTaxSettings, parseAnalyticsSettings } from './tenant-settings.service';

describe('parseTaxSettings', () => {
  it('fresh store (empty JSONB) → tax_mode none, prices_include_tax true', () => {
    const s = parseTaxSettings({});
    expect(s.taxMode).toBe('none');
    expect(s.pricesIncludeTax).toBe(true);
    expect(s.ossPosture).toBe('below_threshold');
    expect(s.euVatRegistration).toEqual({ originCountry: null, vatNumber: null });
  });

  it('parses a fully-populated eu_vat config', () => {
    const s = parseTaxSettings({
      tax_mode: 'eu_vat',
      prices_include_tax: false,
      oss_posture: 'above_or_opted_in',
      eu_vat_registration: { origin_country: 'fr', vat_number: 'FR123' },
    });
    expect(s.taxMode).toBe('eu_vat');
    expect(s.pricesIncludeTax).toBe(false);
    expect(s.ossPosture).toBe('above_or_opted_in');
    expect(s.euVatRegistration).toEqual({ originCountry: 'FR', vatNumber: 'FR123' });
  });

  it('collapses garbage tax_mode / oss_posture to safe defaults', () => {
    const s = parseTaxSettings({ tax_mode: 'wat', oss_posture: 'nonsense' });
    expect(s.taxMode).toBe('none');
    expect(s.ossPosture).toBe('below_threshold');
  });

  it('rejects a malformed origin_country (not 2 chars) → null', () => {
    const s = parseTaxSettings({ eu_vat_registration: { origin_country: 'FRA' } });
    expect(s.euVatRegistration.originCountry).toBeNull();
  });
});

describe('parseAnalyticsSettings', () => {
  it('fresh store (empty JSONB) → all null', () => {
    expect(parseAnalyticsSettings({})).toEqual({
      plausibleDomain: null,
      ga4Id: null,
      metaPixelId: null,
    });
  });

  it('parses a fully-populated analytics config (trimmed)', () => {
    const s = parseAnalyticsSettings({
      analytics: {
        plausible_domain: ' shop.example.com ',
        ga4_id: 'G-ABC123',
        meta_pixel_id: '1234567890',
      },
    });
    expect(s).toEqual({
      plausibleDomain: 'shop.example.com',
      ga4Id: 'G-ABC123',
      metaPixelId: '1234567890',
    });
  });

  it('allows a comma-separated Plausible multi-domain', () => {
    const s = parseAnalyticsSettings({ analytics: { plausible_domain: 'a.com,b.com' } });
    expect(s.plausibleDomain).toBe('a.com,b.com');
  });

  it('rejects malformed Plausible comma lists (trailing/leading/doubled comma) → null', () => {
    for (const bad of ['a.com,', ',a.com', 'a.com,,b.com', ',']) {
      expect(
        parseAnalyticsSettings({ analytics: { plausible_domain: bad } }).plausibleDomain,
      ).toBeNull();
    }
  });

  it('drops values with markup-breaking / out-of-allowlist chars → null', () => {
    const s = parseAnalyticsSettings({
      analytics: {
        plausible_domain: 'evil.com"><script>',
        ga4_id: 'G-<bad>',
        meta_pixel_id: '12; drop',
      },
    });
    expect(s).toEqual({ plausibleDomain: null, ga4Id: null, metaPixelId: null });
  });

  it('drops over-long and empty values → null', () => {
    const s = parseAnalyticsSettings({
      analytics: { plausible_domain: 'a'.repeat(300), ga4_id: '   ', meta_pixel_id: 42 },
    });
    expect(s).toEqual({ plausibleDomain: null, ga4Id: null, metaPixelId: null });
  });
});
