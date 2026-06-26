'use client';

/**
 * Dark-mode toggle. Footer control that flips the `.dark`
 * class on `<html>` and persists the choice to the `theme` cookie (SSR-readable; the no-FOUC inline
 * script in `layout.tsx` reads the SAME cookie before paint so there is no flash).
 *
 * Client component (interactivity, NO Server Actions). On mount it reads the CURRENT
 * rendered state from `document.documentElement` (which the no-FOUC script already set) rather than
 * re-deriving from the cookie, so the button reflects exactly what the user sees. It hydrates with
 * `mounted=false` and only swaps to the resolved icon after mount to avoid an SSR/client mismatch
 * (the server can't know the per-visitor cookie/OS preference).
 *
 * a11y: a native `<button>` with `aria-pressed` (pressed = dark) + a localized
 * `aria-label`, ≥44px touch target, visible `--ring` focus. Color transition + icon swap respect
 * `prefers-reduced-motion` (the transition is CSS-gated in globals.css; no JS animation here).
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Moon, Sun } from 'lucide-react';
import { THEME_COOKIE, type ThemeMode } from '@/lib/theme-mode';

/** One year, in seconds — the persisted theme choice is long-lived. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  // SameSite=Lax + path=/ so the cookie is sent on the next top-level navigation (SSR reads it).
  document.cookie = `${THEME_COOKIE}=${mode}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function ThemeToggle() {
  const t = useTranslations('theme');
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // Reflect whatever the no-FOUC script already applied to <html>.
    setIsDark(document.documentElement.classList.contains('dark'));
    setMounted(true);
  }, []);

  function toggle() {
    const next: ThemeMode = isDark ? 'light' : 'dark';
    applyTheme(next);
    setIsDark(next === 'dark');
  }

  // Before mount we don't know the per-visitor theme; render a stable, inert placeholder with the
  // generic label so the markup is consistent between SSR and the first client paint.
  const label = !mounted ? t('label') : isDark ? t('toLight') : t('toDark');

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={mounted ? isDark : undefined}
      aria-label={label}
      title={label}
      className="inline-flex h-11 w-11 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Icon swap mirrors the action: show the Sun (go-light) when dark, the Moon (go-dark) when
          light. Decorative — the accessible name is the button's aria-label. */}
      {mounted && isDark ? (
        <Sun aria-hidden="true" className="h-5 w-5" />
      ) : (
        <Moon aria-hidden="true" className="h-5 w-5" />
      )}
    </button>
  );
}
