/**
 * HomeSectionsService unit tests.
 *
 * Pins the validation-boundary invariants:
 *   - `replace()` rejects the entire request when ANY entry has an unknown type (fail-closed, 422).
 *   - `replace()` rejects the entire request when ANY entry fails settings validation (fail-closed,
 *     422) — including `javascript:` hrefs rejected by the SDK schema.
 *   - `replace()` rejects when the array exceeds the MAX_SECTIONS cap.
 *   - `replace()` only persists after ALL entries are validated — the repo is never called for an
 *     invalid request.
 *   - `getForStore()` drops a corrupt stored row entry instead of throwing (defence-in-depth).
 *   - `getForAdmin()` returns an empty list when no row exists yet.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { HomeSectionsService, MAX_SECTIONS } from './home-sections.service';
import { HomeSectionsRepository } from './home-sections.repository';
import type { StorefrontHomeSection } from '../database/schema/storefront_home_sections';
import type { MarketingSectionDescriptor } from '@sovecom/theme-sdk';

const TENANT = '01900000-0000-7000-8000-0000000000bb';

const VALID_HERO: MarketingSectionDescriptor = {
  type: 'hero-banner',
  settings: { headline: 'Welcome', align: 'center', overlay: false },
};

const VALID_CTA: MarketingSectionDescriptor = {
  type: 'cta-banner',
  settings: {
    headline: 'Shop now',
    ctaLabel: 'Browse',
    ctaHref: '/shop',
  },
};

function makeRow(sections: unknown[] = [VALID_HERO]): StorefrontHomeSection {
  return {
    id: 'row-id',
    tenantId: TENANT,
    sections,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  } as unknown as StorefrontHomeSection;
}

describe('HomeSectionsService (unit)', () => {
  let repo: jest.Mocked<HomeSectionsRepository>;
  let svc: HomeSectionsService;

  beforeEach(() => {
    repo = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(makeRow()),
    } as unknown as jest.Mocked<HomeSectionsRepository>;
    svc = new HomeSectionsService(repo);
  });

  // ── getForAdmin ───────────────────────────────────────────────────────────

  describe('getForAdmin', () => {
    it('returns empty sections when no row exists yet', async () => {
      repo.get.mockResolvedValue(null);
      const out = await svc.getForAdmin(TENANT);
      expect(out.sections).toEqual([]);
    });

    it('returns validated sections when a row exists', async () => {
      repo.get.mockResolvedValue(makeRow([VALID_HERO]));
      const out = await svc.getForAdmin(TENANT);
      expect(out.sections).toHaveLength(1);
      expect(out.sections[0]!.type).toBe('hero-banner');
    });
  });

  // ── replace ───────────────────────────────────────────────────────────────

  describe('replace', () => {
    it('validates and persists a well-formed array (calls repo.set)', async () => {
      repo.set.mockResolvedValue(makeRow([VALID_HERO, VALID_CTA]));
      await svc.replace(TENANT, [VALID_HERO, VALID_CTA]);
      expect(repo.set).toHaveBeenCalledWith(TENANT, [VALID_HERO, VALID_CTA]);
    });

    it('returns an empty sections list when given an empty array', async () => {
      repo.set.mockResolvedValue(makeRow([]));
      const out = await svc.replace(TENANT, []);
      expect(out.sections).toEqual([]);
    });

    it('rejects (422) when any entry has an unknown type — never calls repo.set', async () => {
      const bad = { type: 'unknown-widget', settings: {} };
      await expect(svc.replace(TENANT, [VALID_HERO, bad])).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repo.set).not.toHaveBeenCalled();
    });

    it('rejects (422) when settings fail schema validation — e.g. missing required headline', async () => {
      const bad = { type: 'hero-banner', settings: { headline: '' } }; // headline min(1) fails
      await expect(svc.replace(TENANT, [bad])).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repo.set).not.toHaveBeenCalled();
    });

    it('rejects (422) when a ctaHref contains a javascript: URI (SDK schema rejects it)', async () => {
      const bad = {
        type: 'cta-banner',
        settings: {
          headline: 'Click me',
          ctaLabel: 'Go',
          ctaHref: 'javascript:alert(1)',
        },
      };
      await expect(svc.replace(TENANT, [bad])).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repo.set).not.toHaveBeenCalled();
    });

    it('rejects (422) when array length exceeds MAX_SECTIONS', async () => {
      const oversized = Array.from({ length: MAX_SECTIONS + 1 }, () => VALID_HERO);
      await expect(svc.replace(TENANT, oversized)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repo.set).not.toHaveBeenCalled();
    });

    it('rejects the ENTIRE request on the first invalid entry (fail-closed — no partial save)', async () => {
      const entries = [VALID_HERO, { type: 'not-real', settings: {} }, VALID_CTA];
      await expect(svc.replace(TENANT, entries)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repo.set).not.toHaveBeenCalled();
    });
  });

  // ── getForStore ───────────────────────────────────────────────────────────

  describe('getForStore', () => {
    it('returns valid sections from a clean row', async () => {
      repo.get.mockResolvedValue(makeRow([VALID_HERO]));
      const out = await svc.getForStore(TENANT);
      expect(out.sections).toHaveLength(1);
      expect(out.sections[0]!.type).toBe('hero-banner');
    });

    it('silently drops a corrupt stored entry (defence-in-depth — never throws)', async () => {
      const corruptEntry = { type: 'unknown-corrupt', settings: { broken: true } };
      repo.get.mockResolvedValue(makeRow([VALID_HERO, corruptEntry]));
      const out = await svc.getForStore(TENANT);
      // The corrupt entry is dropped; only the valid one is returned.
      expect(out.sections).toHaveLength(1);
      expect(out.sections[0]!.type).toBe('hero-banner');
    });

    it('returns empty sections without throwing when the stored array is entirely corrupt', async () => {
      repo.get.mockResolvedValue(makeRow([{ not: 'a-section' }, { broken: true }]));
      const out = await svc.getForStore(TENANT);
      expect(out.sections).toEqual([]);
    });

    it('returns empty sections without throwing when the stored value is not an array', async () => {
      // Simulates a row mutated out-of-band (e.g. direct SQL injection into the JSONB column).
      repo.get.mockResolvedValue(makeRow('not-an-array' as unknown as unknown[]));
      const out = await svc.getForStore(TENANT);
      expect(out.sections).toEqual([]);
    });

    it('returns empty sections when no row exists yet', async () => {
      repo.get.mockResolvedValue(null);
      const out = await svc.getForStore(TENANT);
      expect(out.sections).toEqual([]);
    });
  });
});
