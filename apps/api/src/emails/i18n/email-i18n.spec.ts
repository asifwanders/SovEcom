/**
 * email i18n unit tests:
 * locale resolution (null-safe, total) + EN/FR catalog key parity.
 */
import {
  DEFAULT_LOCALE,
  EMAIL_LOCALES,
  resolveEmailLocale,
  type EmailLocale,
} from './email-locale';
import { emailMessages } from './messages';

describe('resolveEmailLocale (null-safe, total — never throws)', () => {
  it("defaults to 'en'", () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('returns the locale when recognized', () => {
    expect(resolveEmailLocale('en')).toBe('en');
    expect(resolveEmailLocale('fr')).toBe('fr');
  });

  it('is case-insensitive and trims', () => {
    expect(resolveEmailLocale('FR')).toBe('fr');
    expect(resolveEmailLocale('  En ')).toBe('en');
  });

  it('falls back to the default for null/undefined/empty', () => {
    expect(resolveEmailLocale(null)).toBe('en');
    expect(resolveEmailLocale(undefined)).toBe('en');
    expect(resolveEmailLocale('')).toBe('en');
  });

  it('falls back to the default for unrecognized values (no throw)', () => {
    expect(resolveEmailLocale('de')).toBe('en');
    expect(resolveEmailLocale('zz')).toBe('en');
    expect(resolveEmailLocale('not-a-locale')).toBe('en');
    expect(() => resolveEmailLocale(123 as unknown as string)).not.toThrow();
    expect(resolveEmailLocale(123 as unknown as string)).toBe('en');
  });
});

describe('email message catalogs — EN/FR key parity', () => {
  function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
    const keys: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        keys.push(...leafKeys(v as Record<string, unknown>, path));
      } else {
        keys.push(path);
      }
    }
    return keys.sort();
  }

  it('EN and FR expose identical key sets', () => {
    const enKeys = leafKeys(emailMessages('en') as unknown as Record<string, unknown>);
    const frKeys = leafKeys(emailMessages('fr') as unknown as Record<string, unknown>);
    expect(frKeys).toEqual(enKeys);
  });

  it('every leaf is a non-empty string (functions resolve to non-empty strings)', () => {
    // Recurse the WHOLE catalog (incl. the 3.8c emailChangeVerification +
    // emailChangeNotice.{requested,confirmed} groups) so every locale's every leaf —
    // plain string or interpolating function — resolves to a non-empty string.
    const assertLeaves = (obj: Record<string, unknown>): void => {
      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          assertLeaves(value as Record<string, unknown>);
          continue;
        }
        const resolved = typeof value === 'function' ? value('SO-TEST') : value;
        expect(typeof resolved).toBe('string');
        expect((resolved as string).length).toBeGreaterThan(0);
      }
    };
    for (const locale of EMAIL_LOCALES as readonly EmailLocale[]) {
      assertLeaves(emailMessages(locale) as unknown as Record<string, unknown>);
    }
  });
});
