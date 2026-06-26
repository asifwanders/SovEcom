/**
 * Test helper for rendering components that consume next-intl client context.
 *
 * The locale-aware `Link`, the `Pagination`/`Header`/`Footer` chrome, and the `LanguageSwitcher` all
 * call `useLocale`/`useTranslations`, which require a `NextIntlClientProvider`. `renderWithIntl`
 * wraps any UI under a provider for the requested locale (default `en`) with that locale's catalog,
 * so route specs can assert on real localized chrome (EN or FR) without booting a server runtime.
 *
 * RSC page components are still invoked as `await Page(props)` (they return a plain element); the
 * RESULT is what gets wrapped here when it contains client chrome.
 */
import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import fr from '../messages/fr.json';

const MESSAGES = { en, fr } as const;

export function renderWithIntl(ui: ReactElement, locale: 'en' | 'fr' = 'en'): RenderResult {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      {ui}
    </NextIntlClientProvider>,
  );
}
