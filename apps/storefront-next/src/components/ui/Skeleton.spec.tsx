import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import { Skeleton, ProductGridSkeleton } from './Skeleton';
import { ListingSkeleton, ProductDetailSkeleton } from './PageSkeleton';

describe('Skeleton primitive', () => {
  it('renders a decorative token-coloured block', () => {
    const { container } = render(<Skeleton className="h-4 w-10" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toHaveAttribute('aria-hidden', 'true');
    expect(block.className).toContain('bg-muted');
  });

  it('only animates under motion-safe (reduced-motion disables the pulse)', () => {
    const { container } = render(<Skeleton />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.className).toContain('motion-safe:animate-pulse');
  });

  it('ProductGridSkeleton renders the requested number of card placeholders', () => {
    const { container } = render(<ProductGridSkeleton count={4} />);
    // Each card placeholder is a bordered card div.
    const cards = container.querySelectorAll('.border.border-border');
    expect(cards.length).toBe(4);
  });
});

describe('Page skeletons', () => {
  it('ListingSkeleton exposes a single localized busy status', () => {
    renderWithIntl(<ListingSkeleton />, 'en');
    const status = screen.getByRole('status', { name: 'Loading content' });
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('ProductDetailSkeleton exposes the localized busy status in French', () => {
    renderWithIntl(<ProductDetailSkeleton />, 'fr');
    expect(screen.getByRole('status', { name: 'Chargement du contenu' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });
});
