/**
 * Dark-mode (light/dark) resolution helpers.
 *
 * Two consumers share this logic:
 *   - the no-FOUC inline `<script>` injected in `layout.tsx` `<head>` (which sets the `.dark` class on
 *     `<html>` BEFORE first paint), and
 *   - the client `ThemeToggle` (which reads the current mode and persists the visitor's choice).
 *
 * Persistence is a COOKIE (not localStorage) so the choice is available to SSR/ISR and survives a
 * hard navigation (the choice persists via cookie across SSR). The default on first
 * visit (no cookie) is the OS preference (`prefers-color-scheme`)
 *
 * The inline-script source is exported as a STRING (`THEME_INIT_SCRIPT`) so the layout can drop it
 * into a `<script>` verbatim and this module can unit-test the resolution logic without a DOM.
 */

/** The persisted theme cookie name + the two valid stored values. */
export const THEME_COOKIE = 'theme';
export type ThemeMode = 'light' | 'dark';

/** A stored value is only honoured when it is exactly `'light'` or `'dark'`. */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

/** Read the `theme` cookie from a raw `document.cookie` string, or `null` when absent/invalid. */
export function readThemeCookie(cookieString: string): ThemeMode | null {
  for (const part of cookieString.split(';')) {
    const [rawKey, ...rawVal] = part.split('=');
    if (rawKey?.trim() === THEME_COOKIE) {
      const value = decodeURIComponent(rawVal.join('=').trim());
      return isThemeMode(value) ? value : null;
    }
  }
  return null;
}

/**
 * Resolve the effective theme: an explicit cookie choice wins; otherwise fall back to the OS
 * preference (`prefersDark`); otherwise `'light'`. Pure + side-effect-free so it is unit-testable.
 */
export function resolveInitialTheme(cookie: ThemeMode | null, prefersDark: boolean): ThemeMode {
  if (cookie) return cookie;
  return prefersDark ? 'dark' : 'light';
}

/**
 * The no-FOUC inline script source (runs in the browser before paint, in `<head>`): reads the
 * `theme` cookie, falls back to `prefers-color-scheme`, and toggles the `.dark` class on
 * `<html>` accordingly. Self-contained (no imports) — it executes before the React bundle loads, so
 * it MUST NOT reference module-scope symbols. Wrapped in try/catch so a hostile/odd environment can
 * never break the document render (the page just shows light mode).
 */
export const THEME_INIT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);var v=m?decodeURIComponent(m[1]):null;var d=v==='dark'||(v!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;
