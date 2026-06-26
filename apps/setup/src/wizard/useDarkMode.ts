import { useEffect } from 'react';

/**
 * Honor the OS colour scheme via the `dark` class on <html> (the tokens key off it).
 * Setup is single-use software with no preference UI, so it simply follows the system
 * setting and updates live if the user flips it mid-setup.
 */
export function useSystemDarkMode(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (dark: boolean) => {
      document.documentElement.classList.toggle('dark', dark);
    };
    apply(mq.matches);
    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
}
