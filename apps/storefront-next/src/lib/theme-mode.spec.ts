import { describe, it, expect } from 'vitest';
import {
  THEME_COOKIE,
  THEME_INIT_SCRIPT,
  isThemeMode,
  readThemeCookie,
  resolveInitialTheme,
} from './theme-mode';

describe('theme-mode helpers', () => {
  it('isThemeMode accepts only light|dark', () => {
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('system')).toBe(false);
    expect(isThemeMode('')).toBe(false);
    expect(isThemeMode(undefined)).toBe(false);
  });

  it('readThemeCookie extracts a valid theme value', () => {
    expect(readThemeCookie('foo=1; theme=dark; bar=2')).toBe('dark');
    expect(readThemeCookie('theme=light')).toBe('light');
  });

  it('readThemeCookie returns null when absent or invalid', () => {
    expect(readThemeCookie('foo=1; bar=2')).toBeNull();
    expect(readThemeCookie('theme=purple')).toBeNull();
    expect(readThemeCookie('')).toBeNull();
  });

  it('resolveInitialTheme: explicit cookie choice wins over OS preference', () => {
    expect(resolveInitialTheme('light', true)).toBe('light');
    expect(resolveInitialTheme('dark', false)).toBe('dark');
  });

  it('resolveInitialTheme: falls back to OS preference when no cookie', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
    expect(resolveInitialTheme(null, false)).toBe('light');
  });

  it('THEME_INIT_SCRIPT references the theme cookie + prefers-color-scheme and toggles .dark', () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_COOKIE);
    expect(THEME_INIT_SCRIPT).toContain('prefers-color-scheme: dark');
    expect(THEME_INIT_SCRIPT).toContain("classList.toggle('dark'");
    // Wrapped in try/catch so it can never break document render.
    expect(THEME_INIT_SCRIPT).toContain('try');
  });
});
