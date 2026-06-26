import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ColumnsSection } from './ColumnsSection';

/**
 * the generic `columns` layout primitive. Parity is the gate: the sidebar
 * grid wrapper + the results-column wrapper classes are byte-for-byte the pre-refactor PLP markup.
 */
describe('ColumnsSection', () => {
  function renderColumns(settings: Record<string, unknown> = {}) {
    const node = ColumnsSection.Component({
      settings,
      data: undefined,
      locale: 'en',
      regions: {
        left: [
          <aside key="l" data-testid="left-child">
            SIDEBAR
          </aside>,
        ],
        right: [
          <div key="r" data-testid="right-child">
            GRID
          </div>,
        ],
      },
    });
    return render(<>{node}</>);
  }

  it('renders the verbatim sidebar-grid wrapper + results column with both regions', () => {
    const { container } = renderColumns();
    // Verbatim outer wrapper class from the pre-refactor category/search pages.
    const outer = container.querySelector('div.flex.flex-col.gap-8.sm\\:flex-row');
    expect(outer).not.toBeNull();
    // Verbatim results-column wrapper.
    expect(container.querySelector('div.min-w-0.flex-1')).not.toBeNull();
    // Both regions rendered, left before the results column.
    expect(screen.getByTestId('left-child')).toBeInTheDocument();
    expect(screen.getByTestId('right-child')).toBeInTheDocument();
    // The right child is INSIDE the results column; the left child is a direct child of the wrapper.
    const results = container.querySelector('div.min-w-0.flex-1')!;
    expect(results.querySelector('[data-testid="right-child"]')).not.toBeNull();
    expect(results.querySelector('[data-testid="left-child"]')).toBeNull();
  });

  it('renders nothing for an absent region (graceful)', () => {
    const node = ColumnsSection.Component({
      settings: {},
      data: undefined,
      locale: 'en',
      regions: {
        right: [
          <div key="r" data-testid="only-right">
            R
          </div>,
        ],
      },
    });
    const { container } = render(<>{node}</>);
    expect(screen.getByTestId('only-right')).toBeInTheDocument();
    // The left slot simply contributes nothing (no crash).
    expect(container.querySelector('div.min-w-0.flex-1')).not.toBeNull();
  });

  it('emits the verbatim PDP grid: bare left, right region in a `space-y-6` cell with 2+ sections (3.9e-i)', () => {
    // The REAL PDP shape: left = bare gallery; right = the `space-y-6` cell holding BOTH product-info
    // AND variant-selector. A MULTI-ELEMENT bare/grouped right region must collapse under ONE wrapper
    // (so the grid stays a 2-child grid; the variant doesn't leak out as a 3rd grid child — B1 parity).
    const node = ColumnsSection.Component({
      settings: {
        containerClass: 'grid grid-cols-1 md:grid-cols-2 gap-8',
        rightClass: 'space-y-6',
      },
      data: undefined,
      locale: 'en',
      regions: {
        left: [
          <div key="g" data-testid="gallery">
            GALLERY
          </div>,
        ],
        right: [
          <div key="i" data-testid="info">
            INFO
          </div>,
          <div key="v" data-testid="variant">
            VARIANT
          </div>,
        ],
      },
    });
    const { container } = render(<>{node}</>);
    const grid = container.querySelector('div.grid.grid-cols-1.md\\:grid-cols-2.gap-8')!;
    expect(grid).not.toBeNull();
    // No PLP results-column wrapper; the right cell is the `space-y-6` wrapper.
    expect(container.querySelector('div.min-w-0.flex-1')).toBeNull();
    // EXACTLY 2 direct grid children — the bare gallery + the single `space-y-6` right cell. A 2-section
    // right region leaking out as separate grid children would make this 3 (the B1 regression).
    expect(grid.children).toHaveLength(2);
    expect(grid.querySelector(':scope > [data-testid="gallery"]')).not.toBeNull();
    const rightCell = container.querySelector('div.space-y-6')!;
    expect(rightCell).not.toBeNull();
    // BOTH right-region sections are DESCENDANTS of the single `space-y-6` cell (siblings inside it).
    expect(rightCell.querySelector('[data-testid="info"]')).not.toBeNull();
    expect(rightCell.querySelector('[data-testid="variant"]')).not.toBeNull();
  });

  it('renders a multi-section BARE region inline (no wrapper) when the wrapper class is empty', () => {
    // When the right wrapper is explicitly emptied, a multi-element region renders its nodes INLINE as
    // direct grid children (no grouping div) — the other half of the bare-region contract.
    const node = ColumnsSection.Component({
      settings: { containerClass: 'grid grid-cols-2', rightClass: '' },
      data: undefined,
      locale: 'en',
      regions: {
        left: [<div key="l" data-testid="l" />],
        right: [<div key="a" data-testid="ra" />, <div key="b" data-testid="rb" />],
      },
    });
    const { container } = render(<>{node}</>);
    const grid = container.querySelector('div.grid.grid-cols-2')!;
    // bare left (1) + two inline bare right nodes (2) = 3 direct grid children.
    expect(grid.children).toHaveLength(3);
    expect(grid.querySelector(':scope > [data-testid="ra"]')).not.toBeNull();
    expect(grid.querySelector(':scope > [data-testid="rb"]')).not.toBeNull();
  });

  it('wraps the left region when leftClass is set (cart 2-col), right bare when rightClass empty', () => {
    const node = ColumnsSection.Component({
      settings: {
        containerClass: 'grid gap-8 lg:grid-cols-[1fr_20rem]',
        leftClass: 'flex flex-col gap-6',
        rightClass: '',
      },
      data: undefined,
      locale: 'en',
      regions: {
        left: [<ul key="l" data-testid="items" />],
        right: [<aside key="r" data-testid="summary" />],
      },
    });
    const { container } = render(<>{node}</>);
    expect(container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]')).not.toBeNull();
    // Left region wrapped in the verbatim cart left column; the items live inside it.
    const leftCol = container.querySelector('div.flex.flex-col.gap-6')!;
    expect(leftCol).not.toBeNull();
    expect(leftCol.querySelector('[data-testid="items"]')).not.toBeNull();
    // Right (aside) is bare — no results-column wrapper.
    expect(container.querySelector('div.min-w-0.flex-1')).toBeNull();
    const grid = container.querySelector('div.grid')!;
    expect(grid.querySelector(':scope > [data-testid="summary"]')).not.toBeNull();
  });

  it('honours custom region names + wrapper classes from settings', () => {
    const node = ColumnsSection.Component({
      settings: {
        left: 'aside',
        right: 'body',
        containerClass: 'custom-grid',
        rightClass: 'custom-body',
      },
      data: undefined,
      locale: 'en',
      regions: {
        aside: [
          <div key="a" data-testid="a">
            A
          </div>,
        ],
        body: [
          <div key="b" data-testid="b">
            B
          </div>,
        ],
      },
    });
    const { container } = render(<>{node}</>);
    expect(container.querySelector('div.custom-grid')).not.toBeNull();
    expect(container.querySelector('div.custom-body')).not.toBeNull();
    expect(screen.getByTestId('a')).toBeInTheDocument();
    expect(screen.getByTestId('b')).toBeInTheDocument();
  });
});
