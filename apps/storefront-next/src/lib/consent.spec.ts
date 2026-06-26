/**
 * consent cookie parse/serialize. Two categories (analytics, marketing).
 * `null` = no decision yet (banner shows). Legacy `dismissed` value = decided, both off (a returning
 * visitor who dismissed the old informational banner is NOT re-prompted and gets no tracking).
 */
import { describe, it, expect } from 'vitest';
import { parseConsent, serializeConsent, isConsentDowngrade } from './consent';

describe('parseConsent', () => {
  it('absent / empty → null (undecided)', () => {
    expect(parseConsent(undefined)).toBeNull();
    expect(parseConsent('')).toBeNull();
  });

  it('legacy "dismissed" → decided, both categories off', () => {
    expect(parseConsent('dismissed')).toEqual({ analytics: false, marketing: false });
  });

  it('parses the a/m flag encoding', () => {
    expect(parseConsent('a1m0')).toEqual({ analytics: true, marketing: false });
    expect(parseConsent('a0m1')).toEqual({ analytics: false, marketing: true });
    expect(parseConsent('a1m1')).toEqual({ analytics: true, marketing: true });
  });

  it('garbage → null (re-prompt rather than assume consent)', () => {
    expect(parseConsent('lolnope')).toBeNull();
  });
});

describe('isConsentDowngrade', () => {
  it('first decision (prev null) is never a downgrade', () => {
    expect(isConsentDowngrade(null, { analytics: false, marketing: false })).toBe(false);
  });
  it('revoking a granted category is a downgrade (needs reload)', () => {
    expect(
      isConsentDowngrade(
        { analytics: true, marketing: false },
        { analytics: false, marketing: false },
      ),
    ).toBe(true);
    expect(
      isConsentDowngrade(
        { analytics: false, marketing: true },
        { analytics: true, marketing: false },
      ),
    ).toBe(true);
  });
  it('granting more (or unchanged) is not a downgrade', () => {
    expect(
      isConsentDowngrade(
        { analytics: false, marketing: false },
        { analytics: true, marketing: true },
      ),
    ).toBe(false);
    expect(
      isConsentDowngrade(
        { analytics: true, marketing: true },
        { analytics: true, marketing: true },
      ),
    ).toBe(false);
  });
});

describe('serializeConsent', () => {
  it('round-trips through parseConsent', () => {
    for (const s of [
      { analytics: false, marketing: false },
      { analytics: true, marketing: false },
      { analytics: false, marketing: true },
      { analytics: true, marketing: true },
    ]) {
      expect(parseConsent(serializeConsent(s))).toEqual(s);
    }
  });
});
