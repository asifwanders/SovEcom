import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// pages.ts constructs a client via createStoreClient. Mock that module so each test injects a fake
// `request` and asserts the params passed + the mapping of the raw store DTO to the view-type.
const request = vi.fn();
vi.mock('./store-client', () => ({
  createStoreClient: () => ({ request }),
}));

import { fetchLegalPage, fetchContentPage } from './pages';
import { SovEcomApiError } from '@sovecom/client-js';

const PUBLISHED_ROW = {
  slug: 'terms',
  title: 'Terms of Service',
  body: '# Terms\n\nThese are the terms.',
  locale: 'en',
  seoTitle: 'Terms | Shop',
  seoDescription: 'Our terms of service.',
};

const MAPPED_VIEW = {
  slug: 'terms',
  title: 'Terms of Service',
  body: '# Terms\n\nThese are the terms.',
  locale: 'en',
  seoTitle: 'Terms | Shop',
  seoDescription: 'Our terms of service.',
};

beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// fetchLegalPage and fetchContentPage are thin wrappers over the same fetchPage internal hitting
// the same endpoint (legal vs content are slug conventions only). Test both identically.
describe.each([
  ['fetchLegalPage', fetchLegalPage] as const,
  ['fetchContentPage', fetchContentPage] as const,
])('%s', (_name, fetchPage) => {
  it('maps a published store page DTO to the view-type', async () => {
    request.mockResolvedValue({ ...PUBLISHED_ROW });
    const page = await fetchPage('terms');
    expect(page).toEqual(MAPPED_VIEW);
  });

  it('omits the locale query param when no locale is given (API defaults to en)', async () => {
    request.mockResolvedValue({ ...PUBLISHED_ROW });
    await fetchPage('terms');
    expect(request).toHaveBeenCalledWith('get', '/store/v1/pages/{slug}', {
      path: { slug: 'terms' },
      query: {},
    });
  });

  it('forwards the locale query param when provided', async () => {
    request.mockResolvedValue({ ...PUBLISHED_ROW, locale: 'fr' });
    await fetchPage('terms', 'fr');
    expect(request).toHaveBeenCalledWith('get', '/store/v1/pages/{slug}', {
      path: { slug: 'terms' },
      query: { locale: 'fr' },
    });
  });

  it('returns null when the slug does not exist (API 404)', async () => {
    request.mockRejectedValue(new SovEcomApiError(404, 'Not Found', { message: 'Page not found' }));
    expect(await fetchPage('nope')).toBeNull();
  });

  it('returns null on transport error (cold API → notFound, never 500)', async () => {
    request.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchPage('terms')).toBeNull();
  });

  it('maps null SEO fields through unchanged', async () => {
    request.mockResolvedValue({
      slug: 'about',
      title: 'About',
      body: 'About us.',
      locale: 'en',
      seoTitle: null,
      seoDescription: null,
    });
    const page = await fetchPage('about');
    expect(page).toEqual({
      slug: 'about',
      title: 'About',
      body: 'About us.',
      locale: 'en',
      seoTitle: null,
      seoDescription: null,
    });
  });
});
