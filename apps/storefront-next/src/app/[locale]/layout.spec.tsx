import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { Children, isValidElement } from 'react';
import type { ActiveThemeView } from '@/lib/theme';

// Mock only the network fetch; keep the REAL themeToCssVars / themeLogoUrl mapping so the test
// exercises settings → CSS-var mapping for real.
const fetchActiveTheme = vi.fn<() => Promise<ActiveThemeView | null>>();
vi.mock('@/lib/theme', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/theme')>();
  return { ...actual, fetchActiveTheme: () => fetchActiveTheme() };
});

// next-intl server helpers are no-ops in the unit context; `setRequestLocale` just records the call.
const setRequestLocale = vi.fn();
vi.mock('next-intl/server', () => ({
  setRequestLocale: (l: string) => setRequestLocale(l),
  getTranslations: async () => (k: string) => k,
}));
// The client provider + chrome components pull in navigation; stub them to inert markers so the
// layout's <html>/<body>/theme wiring can be asserted in isolation.
vi.mock('next-intl', () => ({
  hasLocale: (locales: readonly string[], l: string) => locales.includes(l),
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/Header', () => ({ Header: () => <header data-testid="header" /> }));
vi.mock('@/components/Footer', () => ({ Footer: () => <footer data-testid="footer" /> }));
// StorefrontProviders pulls in the cart/auth contexts + the CartDrawer (which uses locale navigation);
// stub it to a passthrough so the layout's <html>/<body>/theme wiring is asserted in isolation.
vi.mock('@/lib/providers', () => ({
  StorefrontProviders: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/CookieBanner', () => ({
  CookieBanner: () => <div data-testid="cookie-banner" />,
}));

const NOT_FOUND = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

import LocaleLayout, { generateStaticParams } from './layout';

type Props = Record<string, unknown>;

function findByType(node: unknown, type: string): ReactElement | null {
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  const kids = (node.props as Props).children;
  let found: ReactElement | null = null;
  Children.forEach(kids, (child) => {
    if (!found) found = findByType(child, type);
  });
  return found;
}

async function renderLayout(locale: string, theme: ActiveThemeView | null) {
  fetchActiveTheme.mockResolvedValue(theme);
  return LocaleLayout({
    children: <div data-testid="child">hi</div>,
    params: Promise.resolve({ locale }),
  });
}

function bodyStyle(body: ReactElement): Record<string, string> {
  return ((body.props as Props).style as Record<string, string>) ?? {};
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('LocaleLayout', () => {
  it('renders <html lang> + dir=ltr for en', async () => {
    const jsx = await renderLayout('en', null);
    const html = findByType(jsx, 'html');
    expect(html).not.toBeNull();
    expect((html!.props as Props).lang).toBe('en');
    expect((html!.props as Props).dir).toBe('ltr');
  });

  it('renders <html lang=fr dir=ltr> for fr', async () => {
    const jsx = await renderLayout('fr', null);
    const html = findByType(jsx, 'html');
    expect((html!.props as Props).lang).toBe('fr');
    expect((html!.props as Props).dir).toBe('ltr');
  });

  it('opts the tree into the request locale via setRequestLocale', async () => {
    await renderLayout('fr', null);
    expect(setRequestLocale).toHaveBeenCalledWith('fr');
  });

  it('calls notFound() for an unknown locale', async () => {
    await expect(renderLayout('de', null)).rejects.toBe(NOT_FOUND);
  });

  it('maps theme.settings onto the CSS custom properties on <body>', async () => {
    const jsx = await renderLayout('en', {
      name: 'midnight',
      version: '1.0.0',
      settings: { primary: '#123456', background: '#0a0a0a', radius: '0.75rem' },
    });
    const body = findByType(jsx, 'body');
    expect(bodyStyle(body!)).toEqual({
      '--primary': '#123456',
      '--background': '#0a0a0a',
      '--radius': '0.75rem',
    });
  });

  it('sets no CSS vars when the theme is null (defaults show through)', async () => {
    const jsx = await renderLayout('en', null);
    const body = findByType(jsx, 'body');
    expect(bodyStyle(body!)).toEqual({});
  });

  it('generateStaticParams returns both locales', () => {
    expect(generateStaticParams()).toEqual([{ locale: 'en' }, { locale: 'fr' }]);
  });

  it('renders <main id="main-content"> as the skip-link target', async () => {
    const jsx = await renderLayout('en', null);
    const main = findByType(jsx, 'main');
    expect(main).not.toBeNull();
    expect((main!.props as Props).id).toBe('main-content');
  });

  it('renders a skip-to-content link targeting #main-content', async () => {
    const jsx = await renderLayout('en', null);
    const anchor = findByType(jsx, 'a');
    expect(anchor).not.toBeNull();
    expect((anchor!.props as Props).href).toBe('#main-content');
  });

  it('injects the no-FOUC theme bootstrap script in <head>', async () => {
    const jsx = await renderLayout('en', null);
    const head = findByType(jsx, 'head');
    expect(head).not.toBeNull();
    const script = findByType(head, 'script');
    expect(script).not.toBeNull();
    const html = ((script!.props as Props).dangerouslySetInnerHTML as { __html: string }).__html;
    expect(html).toContain("classList.toggle('dark'");
  });
});
