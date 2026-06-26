import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const fetchLegalPage = vi.fn();
vi.mock('@/lib/pages', () => ({
  fetchLegalPage: (...a: unknown[]) => fetchLegalPage(...a),
}));

// notFound() throws a sentinel we can assert on (mirrors Next's control-flow throw).
const NOT_FOUND = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

import LegalPage, { generateMetadata } from './page';

function props(slug: string, locale: 'en' | 'fr' = 'en') {
  return { params: Promise.resolve({ locale, slug }) };
}

const PAGE = {
  slug: 'terms',
  title: 'Terms of Service',
  body: '# Terms\n\nThese are the **terms** of service.',
  locale: 'en',
  seoTitle: 'Terms | Shop',
  seoDescription: 'Our terms of service.',
};

beforeEach(() => {
  fetchLegalPage.mockReset();
});

describe('LegalPage (content wired, Markdown render)', () => {
  it('calls notFound() when there is no page for the slug', async () => {
    fetchLegalPage.mockResolvedValue(null);
    await expect(LegalPage(props('terms'))).rejects.toBe(NOT_FOUND);
  });

  it('calls notFound() for an unknown slug', async () => {
    fetchLegalPage.mockResolvedValue(null);
    await expect(LegalPage(props('does-not-exist'))).rejects.toBe(NOT_FOUND);
  });

  it('passes the route locale into fetchLegalPage (locale-aware content)', async () => {
    fetchLegalPage.mockResolvedValue(PAGE);
    await LegalPage(props('terms', 'fr'));
    expect(fetchLegalPage).toHaveBeenCalledWith('terms', 'fr');
  });

  it('renders title + Markdown body (heading + bold) when a page exists', async () => {
    fetchLegalPage.mockResolvedValue(PAGE);
    const { container } = render(await LegalPage(props('terms')));
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeInTheDocument();
    // The page TITLE is the sole <h1>; the body's leading `# Terms` is downshifted to <h2>
    // (shiftHeadings) so the page keeps exactly one h1 (a11y/SEO).
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h1')?.textContent).toBe('Terms of Service');
    expect(container.querySelector('h2')?.textContent).toBe('Terms');
    expect(container.querySelector('strong')?.textContent).toBe('terms');
  });

  it('does NOT execute markup in the body — script/handlers are stripped (XSS guard)', async () => {
    fetchLegalPage.mockResolvedValue({
      ...PAGE,
      slug: 'privacy',
      title: 'Privacy',
      body: '<script>window.__pwned = true;</script><img src=x onerror="window.__pwned=true">',
    });
    const { container } = render(await LegalPage(props('privacy')));
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.innerHTML).not.toContain('window.__pwned');
  });
});

describe('LegalPage generateMetadata', () => {
  it('uses seoTitle + seoDescription + canonical/hreflang when present', async () => {
    fetchLegalPage.mockResolvedValue(PAGE);
    const meta = await generateMetadata(props('terms'));
    expect(meta).toMatchObject({ title: 'Terms | Shop', description: 'Our terms of service.' });
    // Enriches title/description with canonical + per-locale hreflang alternates.
    expect(meta.alternates?.canonical).toMatch(/\/en\/terms$/);
    expect(Object.keys(meta.alternates?.languages ?? {})).toEqual(['en', 'fr']);
    expect((meta.openGraph as Record<string, unknown>).type).toBe('article');
  });

  it('falls back to the page title when seoTitle is null', async () => {
    fetchLegalPage.mockResolvedValue({ ...PAGE, seoTitle: null, seoDescription: null });
    const meta = await generateMetadata(props('terms'));
    expect(meta.title).toBe('Terms of Service');
    expect(meta.description).toBeUndefined();
    expect(meta.alternates?.canonical).toMatch(/\/en\/terms$/);
  });

  it('returns empty metadata when the page is missing', async () => {
    fetchLegalPage.mockResolvedValue(null);
    expect(await generateMetadata(props('nope'))).toEqual({});
  });
});
