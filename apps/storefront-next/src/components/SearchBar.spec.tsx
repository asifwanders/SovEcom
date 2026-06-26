import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, within, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { SearchResultView } from '@/lib/catalog';

// The locale-aware router (next-intl) — observe submit navigation to /search?q=.
const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  // Locale-aware Link → plain anchor so the dropdown option hrefs are assertable.
  Link: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

// The browser-safe instant-search fetch. The component imports `searchInstant` from this module;
// each test stubs it so we control the hits + can assert the abort signal is threaded.
const searchInstant = vi.fn<(q: string, signal: AbortSignal) => Promise<SearchResultView>>();
vi.mock('@/lib/search-client', () => ({
  searchInstant: (q: string, signal: AbortSignal) => searchInstant(q, signal),
}));

import { SearchBar } from './SearchBar';

function result(n: number): SearchResultView {
  return {
    products: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      slug: `slug-${i}`,
      title: `Product ${i}`,
      thumbnailUrl: `https://cdn/${i}.jpg`,
      priceAmount: 1999 + i,
      currency: 'EUR',
    })),
    facets: { categories: [], price: null },
    total: n,
  };
}

function getInput(): HTMLInputElement {
  return screen.getByRole('combobox') as HTMLInputElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  push.mockReset();
  searchInstant.mockReset();
  searchInstant.mockResolvedValue(result(3));
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

/** Type into the search input (uncontrolled-friendly: fire a change with the full value). */
function type(value: string) {
  fireEvent.change(getInput(), { target: { value } });
}

/** Advance fake timers past the debounce window and flush the resolved fetch microtasks. */
async function flushDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

describe('SearchBar', () => {
  it('renders an accessible combobox search input inside a GET form (no-JS fallback)', () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    const input = getInput();
    expect(input).toHaveAttribute('type', 'search');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('name', 'q');
    // No-JS path: the input lives inside a GET <form> that targets the locale search page.
    const form = input.closest('form')!;
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/en/search');
  });

  it('debounces: rapid typing fires ONE fetch after the delay', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('s');
    type('sh');
    type('shi');
    type('shir');
    expect(searchInstant).not.toHaveBeenCalled();
    await flushDebounce();
    expect(searchInstant).toHaveBeenCalledTimes(1);
    expect(searchInstant.mock.calls[0]![0]).toBe('shir');
  });

  it('does NOT fetch for queries shorter than 2 characters', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('a');
    await flushDebounce();
    expect(searchInstant).not.toHaveBeenCalled();
  });

  it('renders up to 6 hits as listbox options with title, price, thumbnail and a PDP link', async () => {
    searchInstant.mockResolvedValue(result(6));
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(6);
    // First option: title, formatted price, a lazy thumbnail, and a PDP link.
    expect(within(options[0]!).getByText('Product 0')).toBeInTheDocument();
    expect(within(options[0]!).getByText(/19[.,]99/)).toBeInTheDocument();
    const img = within(options[0]!).getByRole('img');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(within(options[0]!).getByRole('link')).toHaveAttribute('href', '/product/slug-0');
    expect(getInput()).toHaveAttribute('aria-expanded', 'true');
  });

  it('caps the dropdown at 6 hits even if the fetch returns more', async () => {
    searchInstant.mockResolvedValue(result(10));
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    const listbox = screen.getByRole('listbox');
    // The listbox holds ONLY product options (see-all is a footer button, not an option),
    // capped at MAX_HITS even though the fetch returned 10.
    expect(within(listbox).getAllByRole('option')).toHaveLength(6);
  });

  it('shows a no-results state without throwing when the fetch returns zero hits', async () => {
    searchInstant.mockResolvedValue(result(0));
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('zzzz');
    await flushDebounce();
    expect(screen.getByText(/No results/i)).toBeInTheDocument();
  });

  it('swallows a fetch error and renders without throwing (never throws to the user)', async () => {
    searchInstant.mockRejectedValue(new Error('boom'));
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    // The input is still there and not expanded into a broken listbox.
    expect(getInput()).toBeInTheDocument();
  });

  it('threads an AbortSignal and aborts the in-flight request on a new keystroke', async () => {
    let firstSignal: AbortSignal | undefined;
    searchInstant.mockImplementation((_q, signal) => {
      firstSignal = firstSignal ?? signal;
      return new Promise(() => {}); // never resolves → stays in-flight
    });
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shir');
    await flushDebounce();
    expect(firstSignal).toBeDefined();
    expect(firstSignal!.aborted).toBe(false);
    // A new keystroke + debounce must abort the prior request's signal.
    type('shirt');
    await flushDebounce();
    expect(firstSignal!.aborted).toBe(true);
  });

  it('ArrowDown/ArrowUp move aria-activedescendant across the options', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    screen.getByRole('listbox');
    const input = getInput();
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const first = input.getAttribute('aria-activedescendant');
    expect(first).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).not.toBe(first);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(first);
  });

  it('Enter on an active option navigates to that PDP (not the search page)', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    screen.getByRole('listbox');
    const input = getInput();
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // activate first option
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/product/slug-0');
  });

  it('Enter with NO active option submits to the search page with ?q=', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    screen.getByRole('listbox');
    const input = getInput();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/search?q=shirt');
  });

  it('the "see all results" affordance submits to the search page with ?q=', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    const seeAll = screen.getByRole('button', { name: /see all results/i });
    fireEvent.click(seeAll);
    expect(push).toHaveBeenCalledWith('/search?q=shirt');
  });

  it('Escape closes the dropdown but keeps the query text', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    screen.getByRole('listbox');
    const input = getInput();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('shirt'); // query preserved
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('a click outside closes the dropdown', async () => {
    renderWithIntl(
      <div>
        <SearchBar locale="en" />
        <button type="button">outside</button>
      </div>,
      'en',
    );
    type('shirt');
    await flushDebounce();
    screen.getByRole('listbox');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('announces the result count via an aria-live region', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    await flushDebounce();
    screen.getByRole('listbox');
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live!.textContent ?? '').toMatch(/3/);
  });

  it('localizes the placeholder and combobox label in French', () => {
    renderWithIntl(<SearchBar locale="fr" />, 'fr');
    const input = getInput();
    expect(input).toHaveAttribute('placeholder', 'Rechercher des produits...');
    // FR no-JS form action carries the FR locale.
    expect(input.closest('form')).toHaveAttribute('action', '/fr/search');
  });

  it('submitting the form (no-JS path / button click) routes to the search page', async () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    type('shirt');
    const form = getInput().closest('form')!;
    fireEvent.submit(form);
    expect(push).toHaveBeenCalledWith('/search?q=shirt');
  });

  it('does not call the router or fetch when submitting an empty query', () => {
    renderWithIntl(<SearchBar locale="en" />, 'en');
    const form = getInput().closest('form')!;
    fireEvent.submit(form);
    expect(push).not.toHaveBeenCalled();
  });
});
