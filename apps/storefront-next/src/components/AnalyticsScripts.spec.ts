/**
 * the analytics gating decision. Plausible is cookieless (domain only);
 * GA4 requires `analytics` consent; Meta requires `marketing` consent.
 */
import { describe, it, expect } from 'vitest';
import { activeTrackers } from './AnalyticsScripts';

const FULL = { plausibleDomain: 'a.com', ga4Id: 'G-1', metaPixelId: '99' };

describe('activeTrackers', () => {
  it('no config → nothing active', () => {
    expect(activeTrackers(null, { analytics: true, marketing: true })).toEqual({
      plausible: null,
      ga4: null,
      meta: null,
    });
  });

  it('Plausible loads on domain alone, regardless of consent', () => {
    expect(activeTrackers({ plausibleDomain: 'a.com' }, null).plausible).toBe('a.com');
    expect(
      activeTrackers({ plausibleDomain: 'a.com' }, { analytics: false, marketing: false })
        .plausible,
    ).toBe('a.com');
  });

  it('GA4 only with analytics consent', () => {
    expect(activeTrackers(FULL, { analytics: false, marketing: true }).ga4).toBeNull();
    expect(activeTrackers(FULL, { analytics: true, marketing: false }).ga4).toBe('G-1');
  });

  it('Meta only with marketing consent', () => {
    expect(activeTrackers(FULL, { analytics: true, marketing: false }).meta).toBeNull();
    expect(activeTrackers(FULL, { analytics: false, marketing: true }).meta).toBe('99');
  });

  it('undecided consent (null) gates GA4 + Meta off, Plausible on', () => {
    expect(activeTrackers(FULL, null)).toEqual({ plausible: 'a.com', ga4: null, meta: null });
  });

  it('consent on but id missing → still null', () => {
    expect(
      activeTrackers({ plausibleDomain: 'a.com' }, { analytics: true, marketing: true }),
    ).toEqual({ plausible: 'a.com', ga4: null, meta: null });
  });
});
