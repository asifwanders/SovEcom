import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const fetchContentPage = vi.fn();
vi.mock('@/lib/pages', () => ({
  fetchContentPage: (...a: unknown[]) => fetchContentPage(...a),
}));

const NOT_FOUND = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

import ContentPage, { generateMetadata } from './page';

function props(slug: string, locale: 'en' | 'fr' = 'en') {
  return { params: Promise.resolve({ locale, slug }) };
}

const PAGE = {
  slug: 'about',
  title: 'About Us',
  body: '# About\n\nWe sell **great** things.\n\n- one\n- two',
  locale: 'en',
  seoTitle: 'About | Shop',
  seoDescription: 'Learn about us.',
};

beforeEach(() => {
  fetchContentPage.mockReset();
});

describe('ContentPage (marketing route group)', () => {
  it('calls notFound() when there is no page for the slug', async () => {
    fetchContentPage.mockResolvedValue(null);
    await expect(ContentPage(props('about'))).rejects.toBe(NOT_FOUND);
  });

  it('passes the route locale into fetchContentPage (locale-aware content)', async () => {
    fetchContentPage.mockResolvedValue(PAGE);
    await ContentPage(props('about', 'fr'));
    expect(fetchContentPage).toHaveBeenCalledWith('about', 'fr');
  });

  it('renders title + Markdown body (heading + bold + list)', async () => {
    fetchContentPage.mockResolvedValue(PAGE);
    const { container } = render(await ContentPage(props('about')));
    expect(screen.getByRole('heading', { level: 1, name: 'About Us' })).toBeInTheDocument();
    // The page TITLE is the sole <h1>; the body's leading `# About` is downshifted to <h2>.
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h2')?.textContent).toBe('About');
    expect(container.querySelector('strong')?.textContent).toBe('great');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('strips dangerous markup in the body (XSS guard)', async () => {
    fetchContentPage.mockResolvedValue({
      ...PAGE,
      body: '<script>window.__pwned=true</script>[x](javascript:alert(1))',
    });
    const { container } = render(await ContentPage(props('about')));
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain('javascript:');
  });
});

describe('ContentPage generateMetadata', () => {
  it('uses seoTitle + seoDescription + canonical/hreflang when present', async () => {
    fetchContentPage.mockResolvedValue(PAGE);
    const meta = await generateMetadata(props('about'));
    expect(meta).toMatchObject({ title: 'About | Shop', description: 'Learn about us.' });
    // Adds canonical (under /pages/) + per-locale hreflang alternates + article OG.
    expect(meta.alternates?.canonical).toMatch(/\/en\/pages\/about$/);
    expect(Object.keys(meta.alternates?.languages ?? {})).toEqual(['en', 'fr']);
    expect((meta.openGraph as Record<string, unknown>).type).toBe('article');
  });

  it('returns empty metadata when the page is missing', async () => {
    fetchContentPage.mockResolvedValue(null);
    expect(await generateMetadata(props('nope'))).toEqual({});
  });
});
