/**
 * robots.ts test. Allows indexing, disallows the internal search
 * results path (query permutations), and references the sitemap URL built from the site origin.
 */
import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://shop.example');

import robots from './robots';

describe('robots', () => {
  it('allows all user agents to index the site and disallows internal search', () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule).toMatchObject({ userAgent: '*', allow: '/' });
    const disallow = Array.isArray(rule?.disallow) ? rule?.disallow : [rule?.disallow];
    expect(disallow).toContain('/*/search');
  });

  it('points at the absolute sitemap URL', () => {
    expect(robots().sitemap).toBe('https://shop.example/sitemap.xml');
  });
});
