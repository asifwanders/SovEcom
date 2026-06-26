import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import type { ThemeTemplate } from '@sovecom/theme-sdk';
import { renderClientSections, type ClientSection } from './renderClientSections';

/**
 * the CLIENT section renderer. Mirrors the server renderer's contract for
 * client islands that read context (e.g. `useCart()`): renders the registry's components in template
 * order; an UNKNOWN section type is SKIPPED, never throws. No loaders (client sections read context).
 * i: also recurses into a section's `regions` so a CLIENT layout section can place them.
 */

function tmpl(types: string[]): ThemeTemplate {
  return { page: 'cart', sections: types.map((type) => ({ type })) };
}

const registry: Record<string, ClientSection> = {
  'sec-a': { type: 'sec-a', Component: () => <div data-testid="a">A</div> },
  'sec-b': { type: 'sec-b', Component: () => <div data-testid="b">B</div> },
};

describe('renderClientSections', () => {
  it('renders the registered client sections in template order', () => {
    const nodes = renderClientSections({ template: tmpl(['sec-a', 'sec-b']), registry });
    render(<>{nodes}</>);
    const rendered = screen.getAllByTestId(/^(a|b)$/);
    expect(rendered.map((el) => el.textContent)).toEqual(['A', 'B']);
  });

  it('skips an unknown section type without throwing', () => {
    const nodes = renderClientSections({
      template: tmpl(['sec-a', 'mystery', 'sec-b']),
      registry,
    });
    render(<>{nodes}</>);
    expect(screen.getByTestId('a')).toBeInTheDocument();
    expect(screen.getByTestId('b')).toBeInTheDocument();
    expect(screen.queryByText('mystery')).toBeNull();
    expect(nodes).toHaveLength(2);
  });

  it('renders nothing for an empty template', () => {
    const nodes = renderClientSections({ template: tmpl([]), registry });
    expect(nodes).toHaveLength(0);
  });

  it('recurses into a layout section: renders regions in order + passes them + settings (3.9e-i)', () => {
    const layoutRegistry: Record<string, ClientSection> = {
      cols: {
        type: 'cols',
        Component: ({
          settings,
          regions,
        }: {
          settings: Record<string, unknown>;
          regions?: Record<string, ReactNode[]>;
        }) => (
          <div data-testid="cols" data-grid={String(settings.containerClass)}>
            <div data-testid="left">{regions?.left}</div>
            <div data-testid="right">{regions?.right}</div>
          </div>
        ),
      },
      'sec-a': registry['sec-a']!,
      'sec-b': registry['sec-b']!,
    };
    const template: ThemeTemplate = {
      page: 'cart',
      sections: [
        {
          type: 'cols',
          settings: { containerClass: 'grid-x' },
          regions: { left: [{ type: 'sec-a' }, { type: 'mystery' }], right: [{ type: 'sec-b' }] },
        },
      ],
    };
    const nodes = renderClientSections({ template, registry: layoutRegistry });
    render(<>{nodes}</>);
    // The layout got its settings + regions; the left region's unknown 'mystery' was skipped.
    expect(screen.getByTestId('cols').getAttribute('data-grid')).toBe('grid-x');
    const left = screen.getByTestId('left');
    expect(left.querySelector('[data-testid="a"]')).not.toBeNull();
    const right = screen.getByTestId('right');
    expect(right.querySelector('[data-testid="b"]')).not.toBeNull();
    expect(screen.queryByText('mystery')).toBeNull();
  });
});
