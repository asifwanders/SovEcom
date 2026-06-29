/**
 * GlobalSearch — inline typeahead (combobox) for the admin topbar.
 *
 * The topbar center IS this text input — the user types directly where it sits.
 * Results appear in a dropdown anchored DIRECTLY BELOW the input (absolute, no
 * full-screen overlay/backdrop). The bar never moves.
 *
 * Fans out to:
 *   GET /admin/v1/products?q=<>&pageSize=5
 *   GET /admin/v1/orders?q=<>&pageSize=5
 *   GET /admin/v1/customers?email=<>&pageSize=5
 *
 * Per-group resilience: a failing group is silently omitted so one 403
 * (permission missing) never breaks the whole typeahead.
 *
 * Keyboard: ⌘K / Ctrl+K focuses the input; Esc closes; ↑/↓ navigates; Enter selects.
 * Mouse hover also highlights. Open when focused + query ≥2 chars; close on Esc,
 * click/focus outside, and after selecting. Navigate-on-select then clear.
 * Focus STAYS in the input while arrowing (aria-activedescendant).
 * i18n: uses useT() / globalSearch section.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { useT } from '@/lib/i18n-context';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  label: string;
  sub?: string;
  to: string;
  group: 'products' | 'orders' | 'customers';
}

interface ProductRow {
  id: string;
  title: string;
}

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
}

interface CustomerRow {
  id: string;
  email: string;
}

interface ListResponse<T> {
  data: T[];
}

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;
const OPTION_ID_PREFIX = 'gs-option-';

// ── Main component ─────────────────────────────────────────────────────────────

export function GlobalSearch() {
  const { t } = useT();
  const navigate = useNavigate();

  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [highlighted, setHighlighted] = React.useState(0);
  const [focused, setFocused] = React.useState(false);

  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // The dropdown is open when the input is focused AND the query is long enough.
  const open = focused && query.trim().length >= MIN_CHARS;

  // ── Global ⌘K / Ctrl+K → focus the inline input (no modal) ─────────────────────

  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ── Close on click / focus outside ─────────────────────────────────────────────

  React.useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    function handleFocusIn(e: FocusEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('focusin', handleFocusIn);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, []);

  // ── Fan-out search ────────────────────────────────────────────────────────────

  const runSearch = React.useCallback(async (q: string) => {
    if (q.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const encoded = encodeURIComponent(q);

    const settled = await Promise.allSettled([
      apiFetch<ListResponse<ProductRow>>(`/admin/v1/products?q=${encoded}&pageSize=5`),
      apiFetch<ListResponse<OrderRow>>(`/admin/v1/orders?q=${encoded}&pageSize=5`),
      apiFetch<ListResponse<CustomerRow>>(`/admin/v1/customers?email=${encoded}&pageSize=5`),
    ]);

    const out: SearchResult[] = [];

    // Products
    if (settled[0].status === 'fulfilled') {
      for (const p of settled[0].value.data) {
        out.push({ id: `p-${p.id}`, label: p.title, to: `/products/${p.id}`, group: 'products' });
      }
    }

    // Orders
    if (settled[1].status === 'fulfilled') {
      for (const o of settled[1].value.data) {
        out.push({
          id: `o-${o.id}`,
          label: o.orderNumber,
          sub: o.status,
          to: `/orders/${o.id}`,
          group: 'orders',
        });
      }
    }

    // Customers
    if (settled[2].status === 'fulfilled') {
      for (const c of settled[2].value.data) {
        out.push({
          id: `c-${c.id}`,
          label: c.email,
          to: `/customers/${c.id}`,
          group: 'customers',
        });
      }
    }

    setResults(out);
    setHighlighted(0);
    setLoading(false);
  }, []);

  // ── Input change with debounce ────────────────────────────────────────────────

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(val);
    }, DEBOUNCE_MS);
  }

  // ── Keyboard navigation (focus stays in the input) ─────────────────────────────

  function handleInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      // Close the dropdown but keep the typed text; blur so it stays closed.
      setFocused(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[highlighted];
      if (r) selectResult(r);
    }
  }

  function selectResult(r: SearchResult) {
    // Clear + close, then navigate.
    setQuery('');
    setResults([]);
    setHighlighted(0);
    setFocused(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    inputRef.current?.blur();
    navigate(r.to);
  }

  // Scroll highlighted item into view as the selection moves.
  React.useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${highlighted}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  // ── Group label helper ────────────────────────────────────────────────────────

  function groupLabel(g: SearchResult['group']): string {
    if (g === 'products') return t('globalSearch', 'groupProducts');
    if (g === 'orders') return t('globalSearch', 'groupOrders');
    return t('globalSearch', 'groupCustomers');
  }

  // ── Flatten results into ordered groups (preserving the global highlight index) ─

  const groups: SearchResult['group'][] = ['products', 'orders', 'customers'];

  let flatIndex = 0;
  const groupedItems: Array<{
    group: SearchResult['group'];
    items: Array<{ r: SearchResult; idx: number }>;
  }> = groups
    .map((g) => {
      const items = results
        .filter((r) => r.group === g)
        .map((r) => {
          const idx = flatIndex++;
          return { r, idx };
        });
      return { group: g, items };
    })
    .filter((g) => g.items.length > 0);

  const activeDescendant =
    open && results.length > 0 ? `${OPTION_ID_PREFIX}${highlighted}` : undefined;

  // ── Render ──────────────────────────────────────────────────────────────────────
  // `relative` wrapper anchors the absolute dropdown directly below the input.

  return (
    <div ref={wrapperRef} className="relative w-full max-w-[420px]">
      {/* Inline input (the real search field — not a trigger button). */}
      <div
        className={cn(
          'flex items-center gap-2 h-9 rounded-md border border-input bg-background/60 px-3',
          'focus-within:ring-2 focus-within:ring-ring focus-within:border-ring',
        )}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="gs-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          aria-label={t('globalSearch', 'ariaLabel')}
          value={query}
          onChange={handleInputChange}
          onFocus={() => setFocused(true)}
          onKeyDown={handleInputKeyDown}
          placeholder={t('globalSearch', 'placeholder')}
          className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {loading && open && (
          <span className="hidden sm:inline text-xs text-muted-foreground shrink-0">
            {t('globalSearch', 'loading')}
          </span>
        )}
        <kbd
          className="hidden sm:inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground shrink-0"
          aria-hidden="true"
        >
          {t('globalSearch', 'shortcut')}
        </kbd>
      </div>

      {/* Dropdown anchored below the input — no backdrop, high z-index. */}
      {open && (
        <ul
          id="gs-listbox"
          ref={listRef}
          role="listbox"
          aria-label={t('globalSearch', 'ariaLabel')}
          className={cn(
            'absolute left-0 right-0 top-full mt-1 z-[60]',
            'max-h-[400px] overflow-y-auto rounded-md border bg-popover text-popover-foreground',
            'py-1 shadow-lg',
          )}
        >
          {!loading && results.length === 0 && (
            <li
              className="px-4 py-6 text-center text-sm text-muted-foreground"
              role="option"
              aria-selected="false"
            >
              {t('globalSearch', 'noResults')}
            </li>
          )}

          {groupedItems.map(({ group, items }) => (
            <li key={group} role="presentation">
              <div className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {groupLabel(group)}
              </div>
              <ul role="group">
                {items.map(({ r, idx }) => (
                  <li
                    key={r.id}
                    id={`${OPTION_ID_PREFIX}${idx}`}
                    role="option"
                    aria-selected={highlighted === idx}
                    data-idx={idx}
                    // onMouseDown (not onClick) so selection fires before the
                    // input's blur/outside-click handler tears the dropdown down.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectResult(r);
                    }}
                    onMouseEnter={() => setHighlighted(idx)}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer',
                      highlighted === idx
                        ? 'bg-teal-600/10 text-teal-700 dark:text-teal-300'
                        : 'hover:bg-muted',
                    )}
                  >
                    <span className="flex-1 truncate">{r.label}</span>
                    {r.sub && (
                      <span className="shrink-0 text-xs text-muted-foreground capitalize">
                        {r.sub}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
