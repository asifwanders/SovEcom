import { describe, it, expect } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import { ImageGallery } from './ImageGallery';
import type { ProductImageView } from '@/lib/catalog';

const threeImages: ProductImageView[] = [
  { thumbnailUrl: 'https://cdn/a.jpg', altText: 'Alpha' },
  { thumbnailUrl: 'https://cdn/b.jpg', altText: 'Bravo' },
  { thumbnailUrl: 'https://cdn/c.jpg', altText: null },
];

/** The single, large/main image (the tabpanel image). */
function mainImage(): HTMLImageElement {
  return within(screen.getByRole('tabpanel')).getByRole('img') as HTMLImageElement;
}

describe('ImageGallery', () => {
  it('renders the main image + one thumbnail tab per image', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    // The first image is the initial main image.
    expect(mainImage().getAttribute('src')).toBe('https://cdn/a.jpg');
  });

  it('makes the first image eager + high priority (LCP) and thumbnails lazy', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    const main = mainImage();
    expect(main.getAttribute('loading')).toBe('eager');
    expect(main.getAttribute('fetchpriority')).toBe('high');
    expect(main.getAttribute('decoding')).toBe('async');
    // Thumbnail <img>s (inside the tabs) are lazy.
    const thumbImgs = screen
      .getAllByRole('tab')
      .map((tab) => within(tab).getByRole('img', { hidden: true }));
    for (const img of thumbImgs) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('decoding')).toBe('async');
    }
  });

  it('uses the image altText as the main image accessible name (falls back to product title)', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    expect(mainImage().getAttribute('alt')).toBe('Alpha');
    // Select the third image, whose altText is null → falls back to the product title.
    fireEvent.click(screen.getAllByRole('tab')[2]!);
    expect(mainImage().getAttribute('alt')).toBe('Tee');
  });

  it('clicking a thumbnail changes the main image (src) and marks it selected', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[1]!);
    expect(mainImage().getAttribute('src')).toBe('https://cdn/b.jpg');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
  });

  it('roving tabindex: only the selected tab is tabbable (tabIndex 0); others are -1', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]!.getAttribute('tabindex')).toBe('0');
    expect(tabs[1]!.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(tabs[2]!);
    expect(tabs[2]!.getAttribute('tabindex')).toBe('0');
    expect(tabs[0]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowRight/ArrowLeft move the selection and update the main image (wrapping)', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(mainImage().getAttribute('src')).toBe('https://cdn/b.jpg');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(mainImage().getAttribute('src')).toBe('https://cdn/c.jpg');
    // Wrap forward → back to first.
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(mainImage().getAttribute('src')).toBe('https://cdn/a.jpg');
    // Wrap backward → last.
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(mainImage().getAttribute('src')).toBe('https://cdn/c.jpg');
  });

  it('Home/End jump to the first/last image', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'End' });
    expect(mainImage().getAttribute('src')).toBe('https://cdn/c.jpg');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(mainImage().getAttribute('src')).toBe('https://cdn/a.jpg');
  });

  it('prev/next controls change the main image and wrap', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    const next = screen.getByRole('button', { name: /next image/i });
    const prev = screen.getByRole('button', { name: /previous image/i });
    fireEvent.click(next);
    expect(mainImage().getAttribute('src')).toBe('https://cdn/b.jpg');
    // Prev from first wraps to last.
    fireEvent.click(prev);
    fireEvent.click(prev);
    expect(mainImage().getAttribute('src')).toBe('https://cdn/c.jpg');
  });

  it('exposes a labelled tablist (group) and a labelled tabpanel', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    expect(screen.getByRole('tablist', { name: 'Product images' })).toBeInTheDocument();
    // The tabpanel exists and is the main-image region.
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  it('one image: renders the single image with no thumbnail strip and no prev/next', () => {
    renderWithIntl(
      <ImageGallery
        images={[{ thumbnailUrl: 'https://cdn/only.jpg', altText: 'Only' }]}
        productTitle="Tee"
      />,
      'en',
    );
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://cdn/only.jpg');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: /next image/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /previous image/i })).toBeNull();
  });

  it('zero images: renders a placeholder, no crash, no <img>', () => {
    renderWithIntl(<ImageGallery images={[]} productTitle="Tee" />, 'en');
    expect(screen.getByText('No image')).toBeInTheDocument();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('localizes the gallery chrome in French', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'fr');
    expect(screen.getByRole('tablist', { name: 'Images du produit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /image suivante/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /image précédente/i })).toBeInTheDocument();
  });

  it('default layout (no prop) is the carousel (tablist) — unchanged', () => {
    renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" />, 'en');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  // Grid layout: all-images, editorial display mode
  describe('grid layout', () => {
    it('renders ALL images at once with NO carousel/tablist/prev-next', () => {
      renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" layout="grid" />, 'en');
      const imgs = screen.getAllByRole('img');
      expect(imgs).toHaveLength(3);
      expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
        'https://cdn/a.jpg',
        'https://cdn/b.jpg',
        'https://cdn/c.jpg',
      ]);
      // No picker chrome in grid mode.
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.queryByRole('tab')).toBeNull();
      expect(screen.queryByRole('button', { name: /next image/i })).toBeNull();
    });

    it('each image keeps an accessible name (altText, falling back to the product title)', () => {
      renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" layout="grid" />, 'en');
      expect(screen.getByRole('img', { name: 'Alpha' })).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Bravo' })).toBeInTheDocument();
      // Third image's altText is null → product title.
      expect(screen.getByRole('img', { name: 'Tee' })).toBeInTheDocument();
    });

    it('the first grid image is the LCP (eager + high priority); the rest are lazy', () => {
      renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" layout="grid" />, 'en');
      const imgs = screen.getAllByRole('img');
      expect(imgs[0]!.getAttribute('loading')).toBe('eager');
      expect(imgs[0]!.getAttribute('fetchpriority')).toBe('high');
      expect(imgs[1]!.getAttribute('loading')).toBe('lazy');
      expect(imgs[2]!.getAttribute('loading')).toBe('lazy');
    });

    it('grid: a labelled list groups the images (distinct from the carousel tablist label)', () => {
      renderWithIntl(<ImageGallery images={threeImages} productTitle="Tee" layout="grid" />, 'en');
      expect(screen.getByRole('list', { name: 'Product image gallery' })).toBeInTheDocument();
    });

    it('grid: zero images still renders the placeholder (no crash)', () => {
      renderWithIntl(<ImageGallery images={[]} productTitle="Tee" layout="grid" />, 'en');
      expect(screen.getByText('No image')).toBeInTheDocument();
      expect(screen.queryAllByRole('img')).toHaveLength(0);
    });
  });
});
