'use client';

/**
 * Instant-search typeahead. A CLIENT island mounted in the RSC
 * `Header`. It debounces (~280ms, min query ≥2) browser-side fetches to the EXISTING public
 * `/store/v1/search` via `lib/search-client` (`@sovecom/client-js` over `NEXT_PUBLIC_API_BASE_URL` —
 * browser-safe, NO `next/headers`, NO API change), shows a dropdown of up to 6 product hits, and on
 * Enter / "see all" submits to the existing `/[locale]/search` page via next-intl's `useRouter`
 * (URL-state — NO Server Action). Each in-flight request is cancelled with an `AbortController` on the
 * next keystroke. Loading/error/empty degrade gracefully — the typeahead NEVER throws to the user.
 *
 * No-JS resilience: the input is wrapped in a real `<form method="get" action=
 * "/<locale>/search">` so search works WITHOUT JavaScript; the typeahead progressively enhances it
 * (the submit handler prevents the native GET and uses the client router instead).
 *
 * a11y combobox (bespoke — NO headless lib): the input is `role="combobox"` with
 * `aria-expanded`/`aria-controls`/`aria-autocomplete="list"`; the dropdown is a `listbox` of `option`s;
 * ArrowUp/Down move the active option (`aria-activedescendant`); Enter opens the active option's PDP
 * or submits the query when none is active; Esc closes (keeping the query); a click outside closes;
 * ≥44px targets; visible `--ring` focus; motion respects `prefers-reduced-motion`; an
 * `aria-live="polite"` region announces the result count (not on every keystroke).
 *
 * NO tracking/analytics, NO query logging.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { formatPrice } from '@/lib/api';
import { searchInstant } from '@/lib/search-client';
import type { ProductCardView } from '@/lib/catalog';

const DEBOUNCE_MS = 280;
const MIN_QUERY = 2;
const MAX_HITS = 6;

/** Is this rejection an AbortController cancellation (the expected outcome of a superseding keystroke)? */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : (err as { name?: string })?.name === 'AbortError';
}

export function SearchBar({ locale }: { locale: string }) {
  const t = useTranslations('searchBar');
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductCardView[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  // -1 = the "see all" affordance is NOT pre-active; null = nothing active; otherwise a hit index.
  const [active, setActive] = useState<number | null>(null);

  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = query.trim();

  // Debounced instant-search. A query <2 chars clears + closes without firing (rate-limit-friendly).
  useEffect(() => {
    if (trimmed.length < MIN_QUERY) {
      abortRef.current?.abort();
      setHits([]);
      setOpen(false);
      setSearched(false);
      setLoading(false);
      return;
    }
    const handle = setTimeout(() => {
      // Cancel any prior in-flight request before issuing a new one.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      searchInstant(trimmed, ctrl.signal)
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setHits(res.products.slice(0, MAX_HITS));
          setSearched(true);
          setOpen(true);
          setActive(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (isAbort(err) || ctrl.signal.aborted) return; // superseded — ignore
          // Any real failure degrades to a closed, empty typeahead — never throws to the user.
          setHits([]);
          setSearched(true);
          setOpen(false);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [trimmed]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const close = useCallback(() => {
    setOpen(false);
    setActive(null);
  }, []);

  // Click-outside closes the dropdown (mirrors CategoryNav's desktop dropdown pattern).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  /** Navigate to the full search results page (URL-state via next-intl router — NO Server Action). */
  const submitSearch = useCallback(() => {
    if (trimmed.length === 0) return;
    close();
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  }, [trimmed, close, router]);

  /** Open a product's PDP (locale-aware via next-intl router). */
  const openProduct = useCallback(
    (slug: string) => {
      close();
      router.push(`/product/${slug}`);
    },
    [close, router],
  );

  const showList = open && searched;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close(); // keeps the query text
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (!showList || hits.length === 0) return;
      e.preventDefault();
      setActive((cur) => (cur === null || cur >= hits.length - 1 ? 0 : cur + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!showList || hits.length === 0) return;
      e.preventDefault();
      setActive((cur) => (cur === null || cur <= 0 ? hits.length - 1 : cur - 1));
      return;
    }
    if (e.key === 'Enter') {
      // Enter on an active option opens its PDP; otherwise submit the query to the search page.
      // Always handle it here (don't rely on implicit form submit) so the client router is used.
      e.preventDefault();
      if (showList && active !== null && hits[active]) {
        openProduct(hits[active]!.slug);
      } else {
        submitSearch();
      }
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitSearch();
  }

  const activeDescendant = showList && active !== null ? optionId(active) : undefined;

  return (
    <div ref={rootRef} className="relative w-full max-w-xs">
      <form
        method="get"
        action={`/${locale}/search`}
        onSubmit={onSubmit}
        role="search"
        className="flex items-center"
      >
        <div className="relative w-full">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-3 text-muted-foreground"
          >
            <Search className="h-4 w-4" />
          </span>
          <input
            type="search"
            name="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => searched && setOpen(true)}
            role="combobox"
            aria-expanded={showList}
            aria-controls={showList && hits.length > 0 ? listId : undefined}
            aria-autocomplete="list"
            aria-busy={loading || undefined}
            aria-label={t('label')}
            aria-activedescendant={activeDescendant}
            autoComplete="off"
            placeholder={t('placeholder')}
            className="flex h-11 w-full rounded-md border border-input bg-transparent ps-9 pe-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        {/* Submit button: the no-JS fallback control; also visible-affordance for keyboard/mouse. */}
        <button
          type="submit"
          className="ms-1 inline-flex h-11 min-w-11 items-center justify-center rounded-md px-2 text-sm text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">{t('submit')}</span>
          <Search aria-hidden="true" className="h-4 w-4" />
        </button>
      </form>

      {/* Result-count announcement for assistive tech (polite — not on every keystroke). */}
      <div aria-live="polite" className="sr-only">
        {showList
          ? hits.length > 0
            ? t('resultCount', { count: hits.length })
            : t('noResultsAnnounce')
          : ''}
      </div>

      {showList && (
        <div className="absolute z-40 mt-1 w-72 max-w-[90vw] overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              {t('noResults', { query: trimmed })}
            </p>
          ) : (
            // The listbox holds ONLY product options (a clean combobox listbox); "See all" is a
            // separate footer action below, not an option, so arrow-nav + the option count stay
            // exactly the result set.
            <ul
              id={listId}
              role="listbox"
              aria-label={t('suggestionsLabel')}
              className="max-h-80 overflow-auto py-1"
            >
              {hits.map((hit, i) => {
                const hasPrice = hit.priceAmount !== null && hit.currency !== null;
                return (
                  <li
                    key={hit.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={active === i}
                    onMouseEnter={() => setActive(i)}
                    className={`${active === i ? 'bg-muted' : ''}`}
                  >
                    {/* The whole row is the option; the inner link carries the locale-aware PDP href.
                        We navigate via the router on click to keep the close+focus behaviour. */}
                    <a
                      href={`/product/${hit.slug}`}
                      onClick={(e) => {
                        e.preventDefault();
                        openProduct(hit.slug);
                      }}
                      className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm text-foreground"
                      tabIndex={-1}
                    >
                      {hit.thumbnailUrl ? (
                        <img
                          src={hit.thumbnailUrl}
                          alt=""
                          width={40}
                          height={40}
                          loading="lazy"
                          decoding="async"
                          className="h-10 w-10 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <span className="h-10 w-10 shrink-0 rounded bg-muted" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{hit.title}</span>
                        {hasPrice && (
                          <span className="block text-xs text-primary">
                            {formatPrice(hit.priceAmount as number, hit.currency as string, locale)}
                          </span>
                        )}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {/* "See all results" affordance — a footer action (NOT a listbox option) that submits the
              query to the full search page. Mouse-clickable; keyboard users get it via Enter. */}
          {trimmed.length >= MIN_QUERY && (
            <div className="border-t border-border">
              <button
                type="button"
                onClick={submitSearch}
                className="flex min-h-11 w-full items-center px-3 py-2 text-start text-sm font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('seeAll', { query: trimmed })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
