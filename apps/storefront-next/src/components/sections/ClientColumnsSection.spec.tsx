import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClientColumns } from './ClientColumnsSection';

/**
 * i — the CLIENT `columns` layout primitive (cart). Mirrors the server
 * `ColumnsSection` wrapper semantics: it lays out pre-rendered regions per the template settings.
 * Parity is the gate: with the cart settings it emits the verbatim 2-column grid.
 */
describe('ClientColumns', () => {
  it('emits the verbatim cart 2-col grid: left wrapped in flex-col gap-6, summary bare', () => {
    const { container } = render(
      <ClientColumns
        settings={{
          containerClass: 'grid gap-8 lg:grid-cols-[1fr_20rem]',
          leftClass: 'flex flex-col gap-6',
          rightClass: '',
        }}
        regions={{
          left: [<ul key="l" data-testid="items" />],
          right: [<aside key="r" data-testid="summary" />],
        }}
      />,
    );
    expect(container.querySelector('div.grid.gap-8.lg\\:grid-cols-\\[1fr_20rem\\]')).not.toBeNull();
    const leftCol = container.querySelector('div.flex.flex-col.gap-6')!;
    expect(leftCol).not.toBeNull();
    expect(leftCol.querySelector('[data-testid="items"]')).not.toBeNull();
    // Right (aside) is bare — no results-column wrapper; it is a direct grid child.
    expect(container.querySelector('div.min-w-0.flex-1')).toBeNull();
    const grid = container.querySelector('div.grid')!;
    expect(grid.querySelector(':scope > [data-testid="summary"]')).not.toBeNull();
    expect(screen.getByTestId('items')).toBeInTheDocument();
    expect(screen.getByTestId('summary')).toBeInTheDocument();
  });

  it('defaults to the PLP sidebar grid when given no settings', () => {
    const { container } = render(
      <ClientColumns
        settings={{}}
        regions={{
          left: [<aside key="l" data-testid="side" />],
          right: [<div key="r" data-testid="body" />],
        }}
      />,
    );
    expect(container.querySelector('div.flex.flex-col.gap-8.sm\\:flex-row')).not.toBeNull();
    expect(container.querySelector('div.min-w-0.flex-1')).not.toBeNull();
  });

  it('renders nothing for an absent region (graceful)', () => {
    const { container } = render(
      <ClientColumns
        settings={{ rightClass: '' }}
        regions={{ right: [<div key="r" data-testid="only" />] }}
      />,
    );
    expect(screen.getByTestId('only')).toBeInTheDocument();
    expect(container.querySelector('div.flex.flex-col.gap-8.sm\\:flex-row')).not.toBeNull();
  });
});
