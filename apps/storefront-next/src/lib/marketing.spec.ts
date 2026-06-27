/**
 * WS-3d — marketing.ts loader tests.
 *
 * Critical: graceful degrade — API unreachable / non-200 / non-array body → returns [].
 * The home page must never crash due to a cold marketing API.
 * Invalid entries (schema violations) are dropped; valid entries are returned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock createStoreClient so we control the transport.
const mockRequest = vi.fn();
vi.mock('@/lib/store-client', () => ({
  createStoreClient: () => ({ request: mockRequest }),
}));

import { fetchMarketingSections } from './marketing';

const VALID_HERO = {
  type: 'hero-banner',
  settings: { headline: 'Summer Sale', ctaLabel: 'Shop', ctaHref: '/sale' },
};
const VALID_CTA = {
  type: 'cta-banner',
  settings: { headline: 'Join us', ctaLabel: 'Sign up', ctaHref: '/register' },
};
const INVALID_ENTRY = {
  type: 'hero-banner',
  settings: {
    /* missing headline */
  },
};
const UNKNOWN_TYPE = { type: 'unknown-section', settings: {} };

describe('fetchMarketingSections', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('returns validated sections on a successful API response', async () => {
    mockRequest.mockResolvedValue({ sections: [VALID_HERO, VALID_CTA], updatedAt: '2024-01-01' });
    const result = await fetchMarketingSections();
    expect(result).toHaveLength(2);
    expect(result[0]?.type).toBe('hero-banner');
    expect(result[1]?.type).toBe('cta-banner');
  });

  it('returns [] when API throws (ECONNREFUSED / network error)', async () => {
    mockRequest.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchMarketingSections();
    expect(result).toEqual([]);
  });

  it('returns [] when API returns a non-array sections value', async () => {
    mockRequest.mockResolvedValue({ sections: null, updatedAt: '2024-01-01' });
    const result = await fetchMarketingSections();
    expect(result).toEqual([]);
  });

  it('returns [] when API response is not an object', async () => {
    mockRequest.mockResolvedValue('bad-response');
    const result = await fetchMarketingSections();
    expect(result).toEqual([]);
  });

  it('drops invalid entries (schema violations) silently', async () => {
    mockRequest.mockResolvedValue({
      sections: [INVALID_ENTRY, VALID_HERO],
      updatedAt: '2024-01-01',
    });
    const result = await fetchMarketingSections();
    // INVALID_ENTRY dropped, VALID_HERO kept
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('hero-banner');
  });

  it('drops unknown section types silently', async () => {
    mockRequest.mockResolvedValue({ sections: [UNKNOWN_TYPE, VALID_CTA], updatedAt: '2024-01-01' });
    const result = await fetchMarketingSections();
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('cta-banner');
  });

  it('returns [] when sections array is empty', async () => {
    mockRequest.mockResolvedValue({ sections: [], updatedAt: '2024-01-01' });
    const result = await fetchMarketingSections();
    expect(result).toEqual([]);
  });

  it('returns [] when API response is null', async () => {
    mockRequest.mockResolvedValue(null);
    const result = await fetchMarketingSections();
    expect(result).toEqual([]);
  });
});
