import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// Locale-aware Link → plain anchor so the CTA href is assertable without a Next router.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

import { HeroSection } from './HeroSection';

/** The rendered <section> element (the hero shell). */
async function renderHero(settings: Record<string, unknown>) {
  const node = await HeroSection({ settings, data: undefined, locale: 'en' });
  const { container } = renderWithIntl(<>{node}</>, 'en');
  return container.querySelector('section')!;
}

/**
 * ii — the OPT-IN `fullBleed` hero setting. Defaults to off (the rounded-card hero, unchanged
 * for the default home); `true` switches to the full-bleed editorial band (boutique home).
 */
describe('HeroSection fullBleed setting (3.9e-ii)', () => {
  it('default (no setting) is the rounded card — DEFAULT home unchanged', async () => {
    const section = await renderHero({});
    expect(section).toHaveClass('rounded-2xl');
    expect(section.className).not.toMatch(/w-screen/);
    // CTA + localized chrome still render.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/products');
  });

  it('fullBleed: true → the full-bleed editorial band (no rounded card)', async () => {
    const section = await renderHero({ fullBleed: true });
    expect(section.className).toMatch(/w-screen/);
    expect(section).not.toHaveClass('rounded-2xl');
  });

  it('a non-true value defensively keeps the default card', async () => {
    for (const v of ['true', 1, {}, 'yes']) {
      const section = await renderHero({ fullBleed: v });
      expect(section).toHaveClass('rounded-2xl');
    }
  });
});
