/**
 * Reactive locale layer for the admin SPA.
 *
 * The admin keeps its hand-rolled `t` catalog (no new i18n library),
 * but `lib/i18n.ts`'s `currentLocale` is a module-level mutable global that React
 * cannot observe — switching it does NOT re-render anything. This provider wraps
 * that global in React state so a locale switch re-renders subscribers.
 *
 * Contract:
 *  - On every change we BOTH update React state AND call `setLocale()` so the
 *    module-global stays in sync — existing static `t()` callers keep working.
 *  - The chosen locale is persisted to localStorage and restored on boot
 *    (default `en`).
 *  - `useT()` returns a `t`/`tfn` bound to the reactive locale so components that
 *    call it re-render when the locale changes (the reactivity guarantee).
 */
import React from 'react';
import {
  messages,
  setLocale as setModuleLocale,
  readStoredLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
} from './i18n';

type SectionKey = keyof (typeof messages)['en'];

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = React.createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>(() => {
    const initial = readStoredLocale();
    // Keep the module-global aligned with the persisted value before first render.
    setModuleLocale(initial);
    return initial;
  });

  const setLocale = React.useCallback((next: Locale) => {
    setModuleLocale(next); // keep non-reactive t() callers in sync
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // persistence is best-effort; ignore quota/availability errors
    }
    setLocaleState(next); // trigger re-render of subscribers
  }, []);

  const value = React.useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Access the current locale + setter. Throws if used outside <LocaleProvider>. */
export function useLocale(): LocaleContextValue {
  const ctx = React.useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useLocale must be used within a <LocaleProvider>');
  }
  return ctx;
}

/**
 * Reactive translation hook. Returns `t`/`tfn` bound to the active locale so the
 * calling component re-renders on a locale switch. Mirrors the `t(section, key)` /
 * `tfn(section, key, ...n)` signatures from `lib/i18n.ts`.
 */
export function useT() {
  const { locale } = useLocale();

  return React.useMemo(() => {
    function resolve(section: SectionKey, key: string): string | ((n: number) => string) {
      const sectionMsg = messages[locale][section] as Record<
        string,
        string | ((n: number) => string)
      >;
      const enSectionMsg = messages.en[section] as Record<string, string | ((n: number) => string)>;
      return sectionMsg[key] ?? enSectionMsg[key] ?? key;
    }

    function t<K extends SectionKey>(section: K, key: keyof (typeof messages)['en'][K]): string {
      const msg = resolve(section, key as string);
      return typeof msg === 'function' ? msg(0) : msg;
    }

    function tfn<K extends SectionKey>(
      section: K,
      key: keyof (typeof messages)['en'][K],
      ...args: number[]
    ): string {
      const msg = resolve(section, key as string);
      return typeof msg === 'function' ? msg(args[0] ?? 0) : msg;
    }

    return { t, tfn, locale };
  }, [locale]);
}
