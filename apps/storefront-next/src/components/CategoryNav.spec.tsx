import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { CategoryView } from '@/lib/catalog';

// Stub the locale-aware Link to a plain anchor so we can assert hrefs without a Next router.
vi.mock('@/i18n/navigation', () => ({
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

import { CategoryNav } from './CategoryNav';

const tree: CategoryView[] = [
  {
    id: 'c1',
    slug: 'apparel',
    name: 'Apparel',
    parentId: null,
    children: [{ id: 'c1a', slug: 'shirts', name: 'Shirts', parentId: 'c1', children: [] }],
  },
  { id: 'c2', slug: 'shoes', name: 'Shoes', parentId: null, children: [] },
];

beforeEach(() => {
  // jsdom has no layout; reset focus between tests.
  document.body.focus();
});

describe('CategoryNav', () => {
  it('renders a labelled <nav> with the Browse + hamburger triggers', () => {
    renderWithIntl(<CategoryNav categories={tree} />, 'en');
    expect(screen.getByRole('navigation', { name: 'Category navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Open categories menu' })).toBeInTheDocument();
  });

  it('desktop dropdown: toggles aria-expanded and reveals the category tree from props', () => {
    renderWithIntl(<CategoryNav categories={tree} />, 'en');
    const trigger = screen.getByRole('button', { name: 'Browse' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Tree rendered with locale-aware hrefs.
    expect(screen.getByRole('link', { name: 'Apparel' })).toHaveAttribute(
      'href',
      '/category/apparel',
    );
    expect(screen.getByRole('link', { name: 'Shirts' })).toHaveAttribute(
      'href',
      '/category/shirts',
    );
    expect(screen.getByRole('link', { name: 'Shoes' })).toHaveAttribute('href', '/category/shoes');
  });

  it('desktop dropdown: Escape closes it and restores focus to the trigger', () => {
    renderWithIntl(<CategoryNav categories={tree} />, 'en');
    const trigger = screen.getByRole('button', { name: 'Browse' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);
  });

  it('mobile drawer: opens via hamburger, exposes a labelled modal dialog, and lists categories', () => {
    renderWithIntl(<CategoryNav categories={tree} />, 'en');
    const hamburger = screen.getByRole('button', { name: 'Open categories menu' });
    fireEvent.click(hamburger);
    expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'Categories menu' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('link', { name: 'Apparel' })).toBeInTheDocument();
  });

  it('mobile drawer: close button closes it and restores focus to the hamburger', () => {
    renderWithIntl(<CategoryNav categories={tree} />, 'en');
    const hamburger = screen.getByRole('button', { name: 'Open categories menu' });
    fireEvent.click(hamburger);
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(hamburger);
  });

  it('mobile drawer: Escape closes it', () => {
    renderWithIntl(<CategoryNav categories={tree} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: 'Open categories menu' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders no menu items (but keeps the triggers) when the tree is empty', () => {
    renderWithIntl(<CategoryNav categories={[]} />, 'en');
    const trigger = screen.getByRole('button', { name: 'Browse' });
    fireEvent.click(trigger);
    // Open, but no category links exist.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('localizes the triggers in French', () => {
    renderWithIntl(<CategoryNav categories={tree} />, 'fr');
    expect(screen.getByRole('button', { name: 'Parcourir' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Ouvrir le menu des catégories' }),
    ).toBeInTheDocument();
  });

  // Layout variants: simple vs mega chrome behavior.
  describe('layout variant', () => {
    it('default (no layout) opens the SIMPLE single-column dropdown (parity)', () => {
      renderWithIntl(<CategoryNav categories={tree} />, 'en');
      const trigger = screen.getByRole('button', { name: 'Browse' });
      fireEvent.click(trigger);
      const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
      // Simple dropdown has no multi-column grid.
      expect(menu.querySelector('.grid')).toBeNull();
      expect(within(menu).getByRole('link', { name: 'Apparel' })).toBeInTheDocument();
    });

    it('layout="mega" opens a multi-COLUMN panel built from the same tree (incl. children)', () => {
      renderWithIntl(<CategoryNav categories={tree} layout="mega" />, 'en');
      const trigger = screen.getByRole('button', { name: 'Browse' });
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
      // The mega panel is a multi-column grid.
      expect(menu.querySelector('.grid')).not.toBeNull();
      // Top-level categories AND their children are listed (no new data — same tree).
      expect(within(menu).getByRole('link', { name: 'Apparel' })).toHaveAttribute(
        'href',
        '/category/apparel',
      );
      expect(within(menu).getByRole('link', { name: 'Shirts' })).toHaveAttribute(
        'href',
        '/category/shirts',
      );
      expect(within(menu).getByRole('link', { name: 'Shoes' })).toHaveAttribute(
        'href',
        '/category/shoes',
      );
    });

    it('mega: aria + Escape still work (accessible parity with simple)', () => {
      renderWithIntl(<CategoryNav categories={tree} layout="mega" />, 'en');
      const trigger = screen.getByRole('button', { name: 'Browse' });
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      fireEvent.click(trigger);
      const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
      expect(menu).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(document.activeElement).toBe(trigger);
    });
  });
});
