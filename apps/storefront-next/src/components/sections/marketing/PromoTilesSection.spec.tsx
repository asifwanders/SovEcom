/**
 * WS-3d — PromoTilesSection tests.
 *
 * Security tests:
 *   - Per-tile imageUrl off-allowlist / missing → no <img> for that tile.
 *   - Tile href is rendered as a plain link (SDK-validated safe scheme).
 *   - Unknown columns value falls back gracefully (default 3 columns).
 *   - alt text is always present when an image renders.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { PromoTilesSettings } from '@sovecom/theme-sdk';
import type { SectionProps } from '@/lib/sections/registry';

const safeImageUrlMock = vi.fn((v: unknown) =>
  typeof v === 'string' && v.startsWith('/') ? v : undefined,
);
vi.mock('@/lib/widgets/safeUrl', () => ({
  safeImageUrl: (v: unknown) => safeImageUrlMock(v),
}));

import { PromoTilesSection } from './PromoTilesSection';

function props(settings: PromoTilesSettings, extra: Partial<SectionProps> = {}): SectionProps {
  return {
    settings: settings as unknown as Record<string, unknown>,
    data: undefined,
    locale: 'en',
    ...extra,
  };
}

const TILE_NO_IMG = { label: 'Summer', href: '/summer' };
const TILE_WITH_IMG = { label: 'Winter', href: '/winter', imageUrl: '/images/winter.jpg' };

describe('PromoTilesSection', () => {
  beforeEach(() => {
    safeImageUrlMock.mockImplementation((v: unknown) =>
      typeof v === 'string' && v.startsWith('/') ? v : undefined,
    );
  });

  it('renders tile labels as links', async () => {
    renderWithIntl(await PromoTilesSection(props({ tiles: [TILE_NO_IMG, TILE_WITH_IMG] })));
    const summerLink = screen.getByRole('link', { name: /summer/i });
    expect(summerLink).toHaveAttribute('href', '/summer');
    const winterLink = screen.getByRole('link', { name: /winter/i });
    expect(winterLink).toHaveAttribute('href', '/winter');
  });

  it('does NOT render <img> when tile imageUrl is absent', async () => {
    const { container } = renderWithIntl(await PromoTilesSection(props({ tiles: [TILE_NO_IMG] })));
    expect(container.querySelector('img')).toBeNull();
  });

  it('does NOT render <img> when safeImageUrl returns undefined (off-allowlist)', async () => {
    safeImageUrlMock.mockReturnValue(undefined);
    const { container } = renderWithIntl(
      await PromoTilesSection(
        props({ tiles: [{ label: 'X', href: '/x', imageUrl: 'https://evil.com/img.jpg' }] }),
      ),
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders <img> with alt text when safeImageUrl returns a value', async () => {
    safeImageUrlMock.mockReturnValue('/images/winter.jpg');
    const { container } = renderWithIntl(
      await PromoTilesSection(props({ tiles: [TILE_WITH_IMG] })),
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', '/images/winter.jpg');
    // alt must be non-empty (a11y)
    expect(img?.getAttribute('alt')).toBeTruthy();
  });

  it('renders caption when provided', async () => {
    renderWithIntl(
      await PromoTilesSection(
        props({ tiles: [{ label: 'New', href: '/new', caption: 'Limited time offer' }] }),
      ),
    );
    expect(screen.getByText('Limited time offer')).toBeInTheDocument();
  });

  it('renders with default columns (3) when columns is absent', async () => {
    const { container } = renderWithIntl(await PromoTilesSection(props({ tiles: [TILE_NO_IMG] })));
    // Grid must render without crashing
    expect(container.querySelector('[class*="grid"]')).not.toBeNull();
  });

  it('renders with columns=2 without crashing', async () => {
    const { container } = renderWithIntl(
      await PromoTilesSection(props({ tiles: [TILE_NO_IMG], columns: 2 })),
    );
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('renders with columns=4 without crashing', async () => {
    const { container } = renderWithIntl(
      await PromoTilesSection(props({ tiles: [TILE_NO_IMG], columns: 4 })),
    );
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('renders multiple tiles', async () => {
    renderWithIntl(
      await PromoTilesSection(
        props({
          tiles: [
            { label: 'A', href: '/a' },
            { label: 'B', href: '/b' },
            { label: 'C', href: '/c' },
          ],
        }),
      ),
    );
    expect(screen.getByRole('link', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'B' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'C' })).toBeInTheDocument();
  });
});
