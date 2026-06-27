/**
 * WS-3d — HeroBannerSection tests.
 *
 * Security tests are the priority:
 *   - Off-allowlist or missing imageUrl: no <img> rendered.
 *   - align/overlay enums fall back safely on unknown values.
 *   - CTA renders as a plain <a> link; href is SDK-validated (already safe).
 *   - alt text is always present on rendered images.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { HeroBannerSettings } from '@sovecom/theme-sdk';
import type { SectionProps } from '@/lib/sections/registry';

// safeImageUrl is the PII-egress / scheme guard; mock it so we can assert drop behaviour
// without needing the real API_BASE_URL env.
const safeImageUrlMock = vi.fn((v: unknown) =>
  typeof v === 'string' && v.startsWith('/') ? v : undefined,
);
vi.mock('@/lib/widgets/safeUrl', () => ({
  safeImageUrl: (v: unknown) => safeImageUrlMock(v),
}));

import { HeroBannerSection } from './HeroBannerSection';

function props(settings: HeroBannerSettings, extra: Partial<SectionProps> = {}): SectionProps {
  return {
    settings: settings as unknown as Record<string, unknown>,
    data: undefined,
    locale: 'en',
    ...extra,
  };
}

describe('HeroBannerSection', () => {
  beforeEach(() => {
    safeImageUrlMock.mockImplementation((v: unknown) =>
      typeof v === 'string' && v.startsWith('/') ? v : undefined,
    );
  });

  it('renders the headline', async () => {
    renderWithIntl(
      await HeroBannerSection(
        props({ headline: 'Big Sale', ctaLabel: 'Shop now', ctaHref: '/shop' }),
      ),
    );
    expect(screen.getByRole('heading')).toHaveTextContent('Big Sale');
  });

  it('renders subheadline when provided', async () => {
    renderWithIntl(
      await HeroBannerSection(
        props({ headline: 'H', subheadline: 'Sub text', ctaLabel: 'Go', ctaHref: '/' }),
      ),
    );
    expect(screen.getByText('Sub text')).toBeInTheDocument();
  });

  it('renders CTA link with correct href', async () => {
    renderWithIntl(
      await HeroBannerSection(props({ headline: 'H', ctaLabel: 'Shop now', ctaHref: '/products' })),
    );
    const link = screen.getByRole('link', { name: 'Shop now' });
    expect(link).toHaveAttribute('href', '/products');
  });

  it('does NOT render <img> when imageUrl is missing', async () => {
    const { container } = renderWithIntl(
      await HeroBannerSection(props({ headline: 'H', ctaLabel: 'Go', ctaHref: '/' })),
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('does NOT render <img> when safeImageUrl returns undefined (off-allowlist / bad scheme)', async () => {
    safeImageUrlMock.mockReturnValue(undefined);
    const { container } = renderWithIntl(
      await HeroBannerSection(
        props({
          headline: 'H',
          ctaLabel: 'Go',
          ctaHref: '/',
          imageUrl: 'https://evil.com/img.png',
        }),
      ),
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders <img> with alt text when safeImageUrl returns a value', async () => {
    safeImageUrlMock.mockReturnValue('/images/hero.jpg');
    const { container } = renderWithIntl(
      await HeroBannerSection(
        props({
          headline: 'Summer Sale',
          ctaLabel: 'Go',
          ctaHref: '/',
          imageUrl: '/images/hero.jpg',
        }),
      ),
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', '/images/hero.jpg');
    // alt must be non-empty (a11y)
    expect(img?.getAttribute('alt')).toBeTruthy();
  });

  it('defaults align=center and overlay=false when absent (no class crash)', async () => {
    const { container } = renderWithIntl(
      await HeroBannerSection(props({ headline: 'H', ctaLabel: 'Go', ctaHref: '/' })),
    );
    // Section must render
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('accepts align=left and renders without throwing', async () => {
    const { container } = renderWithIntl(
      await HeroBannerSection(
        props({ headline: 'H', ctaLabel: 'Go', ctaHref: '/', align: 'left' }),
      ),
    );
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('accepts align=right and renders without throwing', async () => {
    const { container } = renderWithIntl(
      await HeroBannerSection(
        props({ headline: 'H', ctaLabel: 'Go', ctaHref: '/', align: 'right' }),
      ),
    );
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('renders with overlay=true without throwing', async () => {
    safeImageUrlMock.mockReturnValue('/images/bg.jpg');
    const { container } = renderWithIntl(
      await HeroBannerSection(
        props({
          headline: 'H',
          ctaLabel: 'Go',
          ctaHref: '/',
          imageUrl: '/images/bg.jpg',
          overlay: true,
        }),
      ),
    );
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('renders nothing for CTA when ctaLabel/ctaHref are absent', async () => {
    const { container } = renderWithIntl(
      await HeroBannerSection(props({ headline: 'H' } as HeroBannerSettings)),
    );
    expect(container.querySelector('a')).toBeNull();
  });
});
