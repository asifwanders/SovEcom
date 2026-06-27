/**
 * WS-3d — Registry integration test: the 4 marketing section types must resolve to components.
 */
import { describe, it, expect } from 'vitest';
import { getSection } from '@/lib/sections/registry';

describe('marketing section registry entries', () => {
  const TYPES = ['hero-banner', 'cta-banner', 'promo-tiles', 'rich-text'] as const;

  for (const type of TYPES) {
    it(`"${type}" resolves to a registered section with a Component`, () => {
      const section = getSection(type);
      expect(section).toBeDefined();
      expect(section?.Component).toBeTypeOf('function');
      // All 4 are RSC (no client flag)
      expect((section as { client?: boolean }).client).toBeFalsy();
    });
  }

  it('unknown type returns undefined (graceful skip)', () => {
    expect(getSection('not-a-real-section')).toBeUndefined();
  });
});
