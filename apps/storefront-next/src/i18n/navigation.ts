/**
 * Locale-aware navigation primitives. next-intl wraps Next's navigation so
 * `Link`/`useRouter`/`usePathname`/`redirect` are locale-prefix aware: a `<Link>` to
 * `/products` automatically targets `/en/products` or `/fr/products` for the active locale, and the
 * footer language switcher uses `usePathname` (locale-stripped) + `useRouter` to swap ONLY the
 * locale segment while preserving the current path (and next-intl persists the choice in its cookie).
 */
import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
