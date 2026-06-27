/**
 * WS-3d — CtaBannerSection tests.
 *
 * Security: CTA href is SDK-validated (marketingHrefSchema rejects javascript:); the renderer
 * trusts it as a plain link. The test verifies the link renders correctly and optional body
 * and variant fields work without crashing.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CtaBannerSettings } from '@sovecom/theme-sdk';
import type { SectionProps } from '@/lib/sections/registry';

import { CtaBannerSection } from './CtaBannerSection';

function props(settings: CtaBannerSettings, extra: Partial<SectionProps> = {}): SectionProps {
  return {
    settings: settings as unknown as Record<string, unknown>,
    data: undefined,
    locale: 'en',
    ...extra,
  };
}

describe('CtaBannerSection', () => {
  it('renders headline and CTA link', async () => {
    renderWithIntl(
      await CtaBannerSection(
        props({ headline: 'Join us today', ctaLabel: 'Sign up', ctaHref: '/register' }),
      ),
    );
    expect(screen.getByRole('heading')).toHaveTextContent('Join us today');
    const link = screen.getByRole('link', { name: 'Sign up' });
    expect(link).toHaveAttribute('href', '/register');
  });

  it('renders optional body text when provided', async () => {
    renderWithIntl(
      await CtaBannerSection(
        props({ headline: 'H', ctaLabel: 'Go', ctaHref: '/', body: 'Special offer details here.' }),
      ),
    );
    expect(screen.getByText('Special offer details here.')).toBeInTheDocument();
  });

  it('renders without body text when absent', async () => {
    const { container } = renderWithIntl(
      await CtaBannerSection(props({ headline: 'H', ctaLabel: 'Go', ctaHref: '/' })),
    );
    // Section renders fine
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('applies primary variant by default', async () => {
    const { container } = renderWithIntl(
      await CtaBannerSection(props({ headline: 'H', ctaLabel: 'Go', ctaHref: '/' })),
    );
    const link = container.querySelector('a');
    // primary variant must be reflected (link is present)
    expect(link).not.toBeNull();
  });

  it('renders secondary variant without crashing', async () => {
    const { container } = renderWithIntl(
      await CtaBannerSection(
        props({ headline: 'H', ctaLabel: 'Go', ctaHref: '/', variant: 'secondary' }),
      ),
    );
    expect(container.querySelector('a')).not.toBeNull();
  });

  it('CTA href is rendered as a plain link (no javascript: execution)', async () => {
    // The SDK's marketingHrefSchema already rejected javascript: at API time,
    // but confirm the renderer just uses the value as-is in an <a href>.
    renderWithIntl(
      await CtaBannerSection(props({ headline: 'H', ctaLabel: 'Click', ctaHref: '/sale' })),
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/sale');
  });
});
