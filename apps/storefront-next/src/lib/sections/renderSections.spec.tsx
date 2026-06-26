import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

/**
 * the section runtime. Covers ordering, the unknown-type SKIP, loader data
 * reaching components, invalid-template fallback to the `default` set, AND the REAL registry for the
 * `home` page (mocking only the catalog seam the loaders call).
 */

// The `home` template's loaders call these catalog reads; mock at the catalog seam so the real
// registry/template/renderer run end-to-end for the `home` page.
const fetchProducts = vi.fn();
const fetchCategoryTree = vi.fn();
// The per-card `product-card-actions` slot is rendered by an async `<Slot>` RSC.
// These tests render the grid SYNCHRONOUSLY, so stub the provider to the no-module-bound default
// (renders nothing — DOM byte-identical to before activation). The per-card slot's own rendering
// is covered by ProductCard.slot.spec.tsx + Slot.spec.tsx + the Playwright slot e2e.
vi.mock('@/components/cardActions', () => ({
  productCardActions: () => null,
}));
vi.mock('@/lib/catalog', () => ({
  fetchProducts: (...a: unknown[]) => fetchProducts(...a),
  fetchCategoryTree: (...a: unknown[]) => fetchCategoryTree(...a),
}));

import { renderSections } from './renderSections';
import type { Section } from './registry';

/**
 * COMPILE-TIME guard: a `client: true` section's Component must be SYNCHRONOUS —
 * the server renderer `createElement`s it un-awaited, so an async client Component would render
 * `[object Promise]`. The discriminated `Section` union enforces this; the `@ts-expect-error` below
 * fails the TYPECHECK if that enforcement ever regresses (an async client Component being accepted).
 */
const _syncClientOk: Section = { type: 'ok', client: true, Component: () => null };
// @ts-expect-error — an async (Promise-returning) Component is not assignable to a client section.
const _asyncClientRejected: Section = { type: 'bad', client: true, Component: async () => null };
void _syncClientOk;
void _asyncClientRejected;

beforeEach(() => {
  fetchProducts.mockReset();
  fetchCategoryTree.mockReset();
  fetchProducts.mockResolvedValue({ products: [], nextCursor: null });
  fetchCategoryTree.mockResolvedValue([]);
});

describe('renderSections (real home registry)', () => {
  it('returns the home sections in template order (hero, featured, then optional category)', async () => {
    fetchProducts.mockResolvedValue({
      products: [
        {
          id: 'p1',
          slug: 'tee',
          title: 'Cotton Tee',
          thumbnailUrl: null,
          priceAmount: 1000,
          currency: 'EUR',
        },
      ],
      nextCursor: null,
    });
    fetchCategoryTree.mockResolvedValue([
      { id: 'c1', slug: 'apparel', name: 'Apparel', parentId: null, children: [] },
    ]);
    const nodes = await renderSections({ page: 'home', themeName: undefined, locale: 'en' });
    // hero + featured-products + category-list, all registered → 3 nodes.
    expect(nodes).toHaveLength(3);
  });

  it('runs loaders so their data reaches the components (featured grid renders the product)', async () => {
    fetchProducts.mockResolvedValue({
      products: [
        {
          id: 'p1',
          slug: 'tee',
          title: 'Cotton Tee',
          thumbnailUrl: null,
          priceAmount: 1000,
          currency: 'EUR',
        },
      ],
      nextCursor: null,
    });
    const nodes = await renderSections({ page: 'home', themeName: undefined, locale: 'en' });
    // The featured section renders a ProductCard whose locale-aware Link needs the intl provider.
    renderWithIntl(<>{nodes}</>, 'en');
    // The product the loader fetched is rendered by the featured-products section.
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(fetchProducts).toHaveBeenCalledWith({ pageSize: 8 });
  });

  it('falls back to the default set for an unknown theme name (still renders home sections)', async () => {
    const nodes = await renderSections({ page: 'home', themeName: 'does-not-exist', locale: 'en' });
    expect(nodes.length).toBeGreaterThan(0);
  });
});

/**
 * The ordering / unknown-skip / loader-data / invalid-template-fallback behaviours, isolated from the
 * real registry by mocking the registry + themes modules. This proves the renderer's CONTROL FLOW.
 */
describe('renderSections (control flow with a stubbed registry)', () => {
  it('skips an unknown section type without throwing, preserving the order of the rest', async () => {
    vi.resetModules();
    const knownLoader = vi.fn(async () => ({ tag: 'A-data' }));
    vi.doMock('./registry', () => ({
      getSection: (type: string) =>
        type === 'known-a'
          ? {
              type: 'known-a',
              loader: knownLoader,
              Component: ({ data }: { data: unknown }) => (
                <div data-testid="a">{(data as { tag: string }).tag}</div>
              ),
            }
          : type === 'known-b'
            ? {
                type: 'known-b',
                Component: () => <div data-testid="b">B</div>,
              }
            : undefined,
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({
        home: {
          page: 'home',
          sections: [{ type: 'known-a' }, { type: 'mystery' }, { type: 'known-b' }],
        },
      }),
    }));
    const mod = await import('./renderSections');
    const nodes = await mod.renderSections({ page: 'home', themeName: undefined, locale: 'en' });
    // Unknown 'mystery' skipped → only A and B render, in order; loader data reached A.
    render(<>{nodes}</>);
    expect(screen.getByTestId('a')).toHaveTextContent('A-data');
    expect(screen.getByTestId('b')).toBeInTheDocument();
    expect(nodes).toHaveLength(2);
    expect(knownLoader).toHaveBeenCalledTimes(1);
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('passes the render params through to each section loader', async () => {
    vi.resetModules();
    const loader = vi.fn(async (_settings: unknown, _ctx: unknown) => ({ ok: true }));
    vi.doMock('./registry', () => ({
      getSection: (type: string) =>
        type === 'needs-params'
          ? {
              type,
              loader,
              Component: () => <div data-testid="needs-params" />,
            }
          : undefined,
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({
        product: { page: 'product', sections: [{ type: 'needs-params' }] },
      }),
    }));
    const mod = await import('./renderSections');
    await mod.renderSections({
      page: 'product',
      themeName: undefined,
      locale: 'en',
      params: { slug: 'tee' },
    });
    // The loader receives the render ctx as its 2nd arg with `{ locale, params }`.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]![1]).toMatchObject({ locale: 'en', params: { slug: 'tee' } });
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('renders nested region sub-sections in order + runs their loaders, passing the regions prop', async () => {
    vi.resetModules();
    const leftLoader = vi.fn(async () => ({ tag: 'L' }));
    const rightLoader = vi.fn(async () => ({ tag: 'R' }));
    vi.doMock('./registry', () => ({
      getSection: (type: string) => {
        if (type === 'cols')
          return {
            type: 'cols',
            Component: ({ regions }: { regions?: Record<string, ReactNode[]> }) => (
              <div data-testid="cols">
                <div data-testid="left">{regions?.left}</div>
                <div data-testid="right">{regions?.right}</div>
              </div>
            ),
          };
        if (type === 'left-sec')
          return {
            type: 'left-sec',
            loader: leftLoader,
            Component: ({ data }: { data: unknown }) => (
              <span data-testid="left-node">{(data as { tag: string }).tag}</span>
            ),
          };
        if (type === 'right-a')
          return {
            type: 'right-a',
            loader: rightLoader,
            Component: ({ data }: { data: unknown }) => (
              <span data-testid="right-a">{(data as { tag: string }).tag}</span>
            ),
          };
        if (type === 'right-b')
          return { type: 'right-b', Component: () => <span data-testid="right-b">B</span> };
        return undefined;
      },
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({
        category: {
          page: 'category',
          sections: [
            {
              type: 'cols',
              regions: {
                left: [{ type: 'left-sec' }],
                right: [{ type: 'right-a' }, { type: 'mystery' }, { type: 'right-b' }],
              },
            },
          ],
        },
      }),
    }));
    const mod = await import('./renderSections');
    const nodes = await mod.renderSections({
      page: 'category',
      themeName: undefined,
      locale: 'en',
      searchParams: { sort: 'newest' },
    });
    render(<>{nodes}</>);
    // The layout section received its regions prop → left + right rendered in order; nested loaders ran.
    expect(screen.getByTestId('left-node')).toHaveTextContent('L');
    expect(screen.getByTestId('right-a')).toHaveTextContent('R');
    expect(screen.getByTestId('right-b')).toBeInTheDocument();
    // Unknown nested 'mystery' was skipped (graceful) — only A and B in the right region.
    const right = screen.getByTestId('right');
    expect(right.querySelectorAll('[data-testid="right-a"], [data-testid="right-b"]')).toHaveLength(
      2,
    );
    expect(leftLoader).toHaveBeenCalledTimes(1);
    expect(rightLoader).toHaveBeenCalledTimes(1);
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('threads searchParams through to every (nested) section loader ctx', async () => {
    vi.resetModules();
    const loader = vi.fn(async (_s: unknown, _ctx: unknown) => ({ ok: true }));
    vi.doMock('./registry', () => ({
      getSection: (type: string) => {
        if (type === 'cols')
          return {
            type: 'cols',
            Component: ({ regions }: { regions?: Record<string, ReactNode[]> }) => (
              <div>{regions?.main}</div>
            ),
          };
        if (type === 'leaf') return { type: 'leaf', loader, Component: () => <div /> };
        return undefined;
      },
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({
        category: {
          page: 'category',
          sections: [{ type: 'cols', regions: { main: [{ type: 'leaf' }] } }],
        },
      }),
    }));
    const mod = await import('./renderSections');
    await mod.renderSections({
      page: 'category',
      themeName: undefined,
      locale: 'en',
      params: { slug: 'apparel' },
      searchParams: { sort: 'price_asc', page: '2' },
    });
    // The NESTED leaf loader receives the full ctx including searchParams + params.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]![1]).toMatchObject({
      locale: 'en',
      params: { slug: 'apparel' },
      searchParams: { sort: 'price_asc', page: '2' },
    });
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('renders a CLIENT section as an element (not awaited) so the server can compose client islands', async () => {
    vi.resetModules();
    // A `client` section's Component is a (sync) function component, NOT an async RSC. The renderer must
    // render it as a JSX element via createElement (never `await Component(props)`), so an async client
    // section function would NOT be awaited. We assert the rendered output + that data reached it.
    const clientLoader = vi.fn(async () => ({ label: 'ISLAND' }));
    const clientComponent = vi.fn(({ data }: { data: unknown }) => (
      <div data-testid="island">{(data as { label: string }).label}</div>
    ));
    vi.doMock('./registry', () => ({
      getSection: (type: string) =>
        type === 'island'
          ? { type: 'island', client: true, loader: clientLoader, Component: clientComponent }
          : undefined,
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({
        product: { page: 'product', sections: [{ type: 'island' }] },
      }),
    }));
    const mod = await import('./renderSections');
    const nodes = await mod.renderSections({
      page: 'product',
      themeName: undefined,
      locale: 'en',
      params: { slug: 'tee' },
    });
    // The component is rendered as an ELEMENT — it is invoked by React at render time, not awaited by
    // the renderer. The loader ran and its serializable data reached the island.
    render(<>{nodes}</>);
    expect(screen.getByTestId('island')).toHaveTextContent('ISLAND');
    expect(clientLoader).toHaveBeenCalledTimes(1);
    expect(nodes).toHaveLength(1);
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('renders a WIRE template for the page, OVERRIDING the bundled set (3.9h-ii)', async () => {
    vi.resetModules();
    vi.doMock('./registry', () => ({
      getSection: (type: string) =>
        type === 'wire-sec'
          ? { type, Component: () => <div data-testid="wire">WIRE</div> }
          : type === 'bundled-sec'
            ? { type, Component: () => <div data-testid="bundled">BUNDLED</div> }
            : undefined,
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({
        home: { page: 'home', sections: [{ type: 'bundled-sec' }] },
      }),
    }));
    const mod = await import('./renderSections');
    const nodes = await mod.renderSections({
      page: 'home',
      themeName: undefined,
      // The active theme delivered a (validated) wire `home` template — it must win over the bundled set.
      wireTemplates: { home: { page: 'home', sections: [{ type: 'wire-sec' }] } },
      locale: 'en',
    });
    render(<>{nodes}</>);
    expect(screen.getByTestId('wire')).toBeInTheDocument();
    expect(screen.queryByTestId('bundled')).toBeNull();
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('uses the bundled template when NO wire template is given for the page (parity)', async () => {
    vi.resetModules();
    vi.doMock('./registry', () => ({
      getSection: (type: string) =>
        type === 'bundled-sec'
          ? { type, Component: () => <div data-testid="bundled">BUNDLED</div> }
          : undefined,
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({
        home: { page: 'home', sections: [{ type: 'bundled-sec' }] },
      }),
    }));
    const mod = await import('./renderSections');
    // A wire-templates bag with NO entry for `home` → the bundled `home` template renders (parity).
    const nodes = await mod.renderSections({
      page: 'home',
      themeName: undefined,
      wireTemplates: { product: { page: 'product', sections: [] } },
      locale: 'en',
    });
    render(<>{nodes}</>);
    expect(screen.getByTestId('bundled')).toBeInTheDocument();
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('falls back to the bundled template when the WIRE template is invalid (defense in depth)', async () => {
    vi.resetModules();
    vi.doMock('./registry', () => ({
      getSection: (type: string) =>
        type === 'bundled-sec'
          ? { type, Component: () => <div data-testid="bundled">BUNDLED</div> }
          : type === 'should-not-render'
            ? { type, Component: () => <div data-testid="wire-bad">NOPE</div> }
            : undefined,
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({
        home: { page: 'home', sections: [{ type: 'bundled-sec' }] },
      }),
    }));
    const mod = await import('./renderSections');
    // A structurally INVALID wire template (bad `page`) must fail re-validation → bundled fallback.
    const nodes = await mod.renderSections({
      page: 'home',
      themeName: undefined,
      wireTemplates: {
        home: { page: 'NOT_A_PAGE', sections: [{ type: 'should-not-render' }] } as never,
      },
      locale: 'en',
    });
    render(<>{nodes}</>);
    expect(screen.getByTestId('bundled')).toBeInTheDocument();
    expect(screen.queryByTestId('wire-bad')).toBeNull();
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('skips an UNKNOWN section type inside a wire template, rendering the known ones', async () => {
    vi.resetModules();
    vi.doMock('./registry', () => ({
      getSection: (type: string) =>
        type === 'known-a'
          ? { type, Component: () => <div data-testid="known-a">A</div> }
          : type === 'known-b'
            ? { type, Component: () => <div data-testid="known-b">B</div> }
            : undefined,
    }));
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: () => ({ home: { page: 'home', sections: [] } }),
    }));
    const mod = await import('./renderSections');
    // The wire template names a section type this storefront build lacks — it is SKIPPED, not errored.
    const nodes = await mod.renderSections({
      page: 'home',
      themeName: undefined,
      wireTemplates: {
        home: {
          page: 'home',
          sections: [
            { type: 'known-a' },
            { type: 'section-this-build-lacks' },
            { type: 'known-b' },
          ],
        },
      },
      locale: 'en',
    });
    render(<>{nodes}</>);
    expect(screen.getByTestId('known-a')).toBeInTheDocument();
    expect(screen.getByTestId('known-b')).toBeInTheDocument();
    // The unknown section contributed nothing; only the two known sections rendered.
    expect(nodes).toHaveLength(2);
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });

  it('falls back to the default set template when the resolved template is invalid', async () => {
    vi.resetModules();
    vi.doMock('./registry', () => ({
      getSection: (type: string) =>
        type === 'fallback-section'
          ? { type, Component: () => <div data-testid="fallback">FALLBACK</div> }
          : undefined,
    }));
    // The active theme yields a STRUCTURALLY INVALID template (bad page); only the default set's
    // template is valid. The renderer must fall back to the default template and render IT.
    vi.doMock('@/themes', () => ({
      DEFAULT_THEME_NAME: 'default',
      resolveTemplateSet: (name?: string) =>
        name === 'broken'
          ? { home: { page: 'NOT_A_PAGE', sections: [{ type: 'should-not-render' }] } }
          : { home: { page: 'home', sections: [{ type: 'fallback-section' }] } },
    }));
    const mod = await import('./renderSections');
    const nodes = await mod.renderSections({ page: 'home', themeName: 'broken', locale: 'en' });
    render(<>{nodes}</>);
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    vi.doUnmock('./registry');
    vi.doUnmock('@/themes');
  });
});
