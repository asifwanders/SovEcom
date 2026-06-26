'use client';

/**
 * Category navigation component. Desktop = a single "Browse" dropdown of the
 * category tree; mobile = a hamburger that opens a slide-in drawer of the same tree. The RSC `Header`
 * fetches `fetchCategoryTree()` SERVER-SIDE and passes the tree in as `categories` — so this client
 * component does the interactivity ONLY (server-fetch + client-interactivity; NO client fetch, NO
 * Server Actions). Links are locale-aware (`@/i18n/navigation` `Link` → `/<locale>/category/<slug>`).
 *
 * Accessibility: a real `<nav>`; the disclosure buttons carry `aria-expanded` +
 * `aria-controls`; ESC closes an open menu and returns focus to its trigger; the mobile drawer traps
 * focus (Tab/Shift-Tab cycle within it) and is labelled; ≥44px targets; an overlay click closes the
 * drawer. Motion is CSS and respects `prefers-reduced-motion` (globals.css). Renders the trigger but
 * no menu items when the tree is empty (graceful — the Header still shows its flat links).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Menu, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { CategoryView } from '@/lib/catalog';
import { type HeaderLayout, DEFAULT_HEADER_LAYOUT } from '@/lib/chrome-variants';

/** Tab-focusable elements inside a container, for the drawer focus trap. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The MEGA-MENU desktop panel — a multi-column layout built from the already-fetched category tree
 * (no new data): a nested `<ul>` where each top-level category is a link heading with its children
 * in a nested list beneath. Accessibility lives on the PARENT: the panel is the trigger's
 * `aria-controls`/`aria-expanded` target, and ESC + click-outside close it (handled by the
 * CategoryNav wrapper). Every entry is a real focusable link, so the panel is keyboard-navigable; the
 * structure is a plain semantic nested list (no extra ARIA roles needed). When a top category has no
 * children only its own link renders.
 */
function MegaPanel({
  categories,
  onNavigate,
}: {
  categories: CategoryView[];
  onNavigate: () => void;
}) {
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-3">
      {categories.map((cat) => (
        <li key={cat.id} className="min-w-0">
          <Link
            href={`/category/${cat.slug}`}
            onClick={onNavigate}
            className="block rounded-md px-2 py-1 text-sm font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {cat.name}
          </Link>
          {cat.children.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {cat.children.map((child) => (
                <li key={child.id}>
                  <Link
                    href={`/category/${child.slug}`}
                    onClick={onNavigate}
                    className="block rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {child.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function CategoryLinks({
  categories,
  onNavigate,
  className,
}: {
  categories: CategoryView[];
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <ul className={className}>
      {categories.map((cat) => (
        <li key={cat.id}>
          <Link
            href={`/category/${cat.slug}`}
            onClick={onNavigate}
            className="flex min-h-11 items-center rounded-md px-3 py-2 text-sm text-foreground hover:bg-muted hover:text-primary"
          >
            {cat.name}
          </Link>
          {cat.children.length > 0 && (
            <CategoryLinks
              categories={cat.children}
              onNavigate={onNavigate}
              className="ms-3 border-s border-border ps-2"
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function CategoryNav({
  categories,
  layout = DEFAULT_HEADER_LAYOUT,
}: {
  categories: CategoryView[];
  /** Header layout variant: `simple` = single-column dropdown; `mega` = multi-column panel. */
  layout?: HeaderLayout;
}) {
  const t = useTranslations('nav');
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMega = layout === 'mega';

  const desktopMenuId = useId();
  const drawerId = useId();
  const desktopTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const desktopWrapRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const closeDesktop = useCallback(() => {
    setDesktopOpen(false);
    desktopTriggerRef.current?.focus();
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    drawerTriggerRef.current?.focus();
  }, []);

  // ESC closes whichever menu is open (and returns focus to its trigger).
  useEffect(() => {
    if (!desktopOpen && !drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (drawerOpen) closeDrawer();
        else if (desktopOpen) closeDesktop();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [desktopOpen, drawerOpen, closeDesktop, closeDrawer]);

  // Click-outside closes the desktop dropdown (the drawer uses its overlay instead).
  useEffect(() => {
    if (!desktopOpen) return;
    function onClick(e: MouseEvent) {
      if (desktopWrapRef.current && !desktopWrapRef.current.contains(e.target as Node)) {
        setDesktopOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [desktopOpen]);

  // Move focus into the drawer when it opens (focus management for the modal-ish drawer).
  useEffect(() => {
    if (drawerOpen) {
      const first = drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }
  }, [drawerOpen]);

  // Trap Tab focus within the open drawer.
  function onDrawerKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab' || !drawerRef.current) return;
    const nodes = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const hasCategories = categories.length > 0;

  return (
    <nav aria-label={t('categoriesNav')} className="flex items-center">
      {/* Desktop dropdown (md+) */}
      <div ref={desktopWrapRef} className="relative hidden md:block">
        <button
          ref={desktopTriggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={desktopOpen}
          aria-controls={desktopMenuId}
          onClick={() => setDesktopOpen((v) => !v)}
          className="inline-flex min-h-11 items-center gap-1 px-2 text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
        >
          {t('browse')}
          <ChevronDown aria-hidden="true" className="h-4 w-4" />
        </button>
        {desktopOpen && hasCategories && (
          <div
            id={desktopMenuId}
            className={`absolute start-0 top-full z-40 mt-1 max-h-[70vh] overflow-auto rounded-md border border-border bg-popover p-4 shadow-lg motion-safe:transition-opacity ${
              isMega ? 'w-[36rem] max-w-[90vw]' : 'w-64 p-2'
            }`}
          >
            {isMega ? (
              <MegaPanel categories={categories} onNavigate={() => setDesktopOpen(false)} />
            ) : (
              <CategoryLinks categories={categories} onNavigate={() => setDesktopOpen(false)} />
            )}
          </div>
        )}
      </div>

      {/* Mobile hamburger (below md) */}
      <button
        ref={drawerTriggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={drawerOpen}
        aria-controls={drawerId}
        aria-label={t('openMenu')}
        onClick={() => setDrawerOpen(true)}
        className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Menu aria-hidden="true" className="h-5 w-5" />
      </button>

      {drawerOpen && (
        <>
          {/* Overlay — click closes; decorative (the close button is the labelled control). */}
          <div
            className="fixed inset-0 z-40 bg-foreground/20 md:hidden motion-safe:transition-opacity"
            onClick={closeDrawer}
            aria-hidden="true"
          />
          <div
            ref={drawerRef}
            id={drawerId}
            role="dialog"
            aria-modal="true"
            aria-label={t('menuLabel')}
            onKeyDown={onDrawerKeyDown}
            className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[80vw] flex-col bg-card p-4 shadow-xl md:hidden motion-safe:transition-transform"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">{t('allCategories')}</span>
              <button
                type="button"
                onClick={closeDrawer}
                aria-label={t('closeMenu')}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-auto">
              {hasCategories ? (
                <CategoryLinks categories={categories} onNavigate={closeDrawer} />
              ) : null}
            </div>
          </div>
        </>
      )}
    </nav>
  );
}
