'use client';

/**
 * Product image gallery. A client island mounted in the RSC PDP: it extracts the previously-inline
 * main-image and thumbnail-strip markup and upgrades it into a keyboard-accessible image picker using
 * local state. Server-fetches the product data; client handles interactivity only (no client fetch,
 * no Server Actions, no cart/variant logic, no tracking).
 *
 * Accessibility pattern (bespoke, no headless libraries): the WAI-ARIA tabs pattern fitted to an
 * image picker. The thumbnail strip is a `tablist` of `tab`s (roving tabindex — only the selected
 * tab is in the Tab order) and the large image is the `tabpanel` it controls. ArrowLeft/Right (and
 * Home/End) move the selection and update the main image, wrapping at the ends. Optional Prev/Next
 * buttons step the main image. This is the idiomatic ARIA fit for "pick one image to enlarge" —
 * selection follows focus.
 *
 * Images: plain `<img>` elements with explicit `width`/`height` and `decoding="async"`. The main
 * image is the PDP LCP candidate so it uses `loading="eager"` and `fetchpriority="high"`, while
 * thumbnails use `loading="lazy"`. Alt text comes from the image's `altText`, falling back to the
 * product title for the main image and empty for thumbnails (with `aria-label` on the tab itself
 * providing the accessible name).
 *
 * Degrades gracefully: 0 images shows a localized placeholder; 1 image shows just the image (no
 * tablist or buttons); many images show the full picker. Uses logical CSS for RTL support and
 * respects `prefers-reduced-motion`.
 */
import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ProductImageView } from '@/lib/catalog';

/** Intrinsic pixel dimensions for the `<img>` boxes (square) — drive aspect-ratio / CLS, not layout. */
const MAIN_PX = 800;
const THUMB_PX = 64;

/**
 * Gallery layout variant. `carousel` (default) renders the keyboard-accessible tabs picker with one
 * large image and a thumbnail strip. `grid` renders all images at once in a responsive grid (editorial
 * layout, no picker). A template passes the variant via the `product-gallery` section's `layout` setting;
 * the default product template omits it, so the carousel is the standard layout.
 */
export type GalleryLayout = 'carousel' | 'grid';
export const DEFAULT_GALLERY_LAYOUT: GalleryLayout = 'carousel';

export function ImageGallery({
  images,
  productTitle,
  layout = DEFAULT_GALLERY_LAYOUT,
}: {
  images: ProductImageView[];
  productTitle: string;
  layout?: GalleryLayout;
}) {
  const t = useTranslations('gallery');
  const [selected, setSelected] = useState(0);
  const baseId = useId();
  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = `${baseId}-panel`;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const total = images.length;

  // 0 images → placeholder. No crash, no <img>, no controls (both layouts).
  if (total === 0) {
    return (
      <div className="space-y-4">
        <div className="aspect-square rounded-lg border border-border bg-muted flex items-center justify-center text-muted-foreground">
          {t('noImage')}
        </div>
      </div>
    );
  }

  // Grid layout: render all images at once in a responsive grid with no carousel/picker. Each image
  // keeps its accessible name via altText (falling back to product title). The first image is the LCP
  // candidate (eager + high fetchpriority); the rest are lazy-loaded.
  if (layout === 'grid') {
    return (
      <ul aria-label={t('galleryLabel')} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {images.map((img, idx) => (
          <li
            key={`${img.thumbnailUrl}-${idx}`}
            className="overflow-hidden rounded-lg border border-border bg-muted"
          >
            <img
              src={img.thumbnailUrl}
              alt={img.altText ?? productTitle}
              width={MAIN_PX}
              height={MAIN_PX}
              loading={idx === 0 ? 'eager' : 'lazy'}
              fetchPriority={idx === 0 ? 'high' : undefined}
              decoding="async"
              className="h-full w-full object-cover"
            />
          </li>
        ))}
      </ul>
    );
  }

  const current = images[Math.min(selected, total - 1)]!;
  const mainAlt = current.altText ?? productTitle;

  // Move selection by a delta with wrap-around (also moves keyboard focus to the new tab).
  const move = (next: number) => {
    const wrapped = (next + total) % total;
    setSelected(wrapped);
    tabRefs.current[wrapped]?.focus();
  };

  function onTablistKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        move(selected + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        move(selected - 1);
        break;
      case 'Home':
        e.preventDefault();
        move(0);
        break;
      case 'End':
        e.preventDefault();
        move(total - 1);
        break;
    }
  }

  return (
    <div className="space-y-4">
      {/* Main / large image — the tabpanel the thumbnails control (its accessible name = "Image n of total"). */}
      <div
        id={panelId}
        role="tabpanel"
        aria-label={t('panelLabel', { current: selected + 1, total })}
        aria-labelledby={total > 1 ? tabId(selected) : undefined}
        tabIndex={0}
        className="relative aspect-square overflow-hidden rounded-lg border border-border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Plain <img>: tenant-supplied absolute URL. The main image is the PDP LCP candidate
            (eager + high fetchpriority); explicit dimensions prevent layout shift. */}
        <img
          key={current.thumbnailUrl}
          src={current.thumbnailUrl}
          alt={mainAlt}
          width={MAIN_PX}
          height={MAIN_PX}
          loading="eager"
          fetchPriority="high"
          decoding="async"
          className="h-full w-full object-cover"
        />

        {/* Prev/Next stepping the main image (wrap). Only when there's more than one image. */}
        {total > 1 && (
          <>
            <button
              type="button"
              onClick={() => move(selected - 1)}
              aria-label={t('previous')}
              className="absolute inset-y-0 start-0 my-auto ms-2 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background/80 text-foreground shadow-sm hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft aria-hidden="true" className="h-5 w-5 rtl:rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => move(selected + 1)}
              aria-label={t('next')}
              className="absolute inset-y-0 end-0 my-auto me-2 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background/80 text-foreground shadow-sm hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight aria-hidden="true" className="h-5 w-5 rtl:rotate-180" />
            </button>
          </>
        )}
      </div>

      {/* Thumbnail strip — a tablist (roving tabindex). Omitted entirely for a single image. */}
      {total > 1 && (
        <div
          role="tablist"
          aria-label={t('tablistLabel')}
          aria-orientation="horizontal"
          onKeyDown={onTablistKeyDown}
          className="flex gap-2 overflow-x-auto"
        >
          {images.map((img, idx) => {
            const isSelected = idx === selected;
            return (
              <button
                key={`${img.thumbnailUrl}-${idx}`}
                ref={(el) => {
                  tabRefs.current[idx] = el;
                }}
                type="button"
                role="tab"
                id={tabId(idx)}
                aria-selected={isSelected}
                aria-controls={panelId}
                aria-label={t('tabLabel', { current: idx + 1, total })}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => setSelected(idx)}
                className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isSelected ? 'border-primary ring-1 ring-primary' : 'border-border'
                }`}
              >
                <img
                  src={img.thumbnailUrl}
                  alt=""
                  width={THUMB_PX}
                  height={THUMB_PX}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
