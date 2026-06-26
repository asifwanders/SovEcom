import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import en from '../messages/en.json';
import fr from '../messages/fr.json';

/**
 * Global next-intl test shim. The RSC route/layout components call
 * `getTranslations`/`setRequestLocale` from `next-intl/server`, which has no request context under
 * Vitest. We mock it to resolve a translator backed by the requested locale's catalog so the route
 * specs keep asserting on real chrome strings without standing up a server runtime.
 *
 * The shim is STATEFUL to mirror next-intl's real behaviour: a page calls `setRequestLocale(locale)`
 * (from the `[locale]` param) and a subsequent `getTranslations('ns')` resolves against THAT locale.
 * The explicit `getTranslations({ locale, namespace })` form is honoured directly. This lets a spec
 * drive a FR render simply by passing `params: { locale: 'fr' }` to the page (as the app does).
 *
 * `t(key, values)` does a simple `{var}` interpolation — enough for the chrome strings these tests
 * render. Client-side `useTranslations` is exercised via `renderWithIntl` (`src/test-intl.tsx`).
 */
type Catalog = Record<string, unknown>;
const CATALOGS: Record<string, Catalog> = { en, fr };

// Mutable request-locale, set by the mocked `setRequestLocale` and read by `getTranslations('ns')`.
let requestLocale = 'en';

function resolveNamespace(messages: Catalog, namespace?: string): Catalog {
  if (!namespace) return messages;
  return namespace.split('.').reduce<Catalog>((acc, k) => (acc[k] as Catalog) ?? {}, messages);
}

function interpolate(template: string, values?: Record<string, unknown>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in values ? String(values[k]) : `{${k}}`,
  );
}

function makeTranslator(locale: string, namespace?: string) {
  const catalog: Catalog = CATALOGS[locale] ?? en;
  const ns = resolveNamespace(catalog, namespace);
  return (key: string, values?: Record<string, unknown>) => {
    const raw = ns[key];
    return typeof raw === 'string' ? interpolate(raw, values) : key;
  };
}

vi.mock('next-intl/server', () => ({
  setRequestLocale: (locale: string) => {
    if (locale) requestLocale = locale;
  },
  // `getLocale()` resolves the current request-locale (set by `setRequestLocale`); RSC chrome
  // (e.g. the Header passing `locale` into the client SearchBar island) reads it.
  getLocale: async () => requestLocale,
  getTranslations: async (arg?: string | { locale?: string; namespace?: string }) => {
    if (typeof arg === 'string') return makeTranslator(requestLocale, arg);
    return makeTranslator(arg?.locale ?? requestLocale, arg?.namespace);
  },
}));
