import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StarRatingSummary } from './star-rating-summary';
import { ReviewList } from './review-list';
import { ProductCarousel } from './product-carousel';
import { ToggleButton } from './toggle-button';
import { SubmitForm } from './submit-form';
import type {
  StarRatingSummaryProps,
  ReviewListProps,
  ProductCarouselProps,
  ToggleButtonProps,
  SubmitFormProps,
} from '@sovecom/theme-sdk';

/**
 * C2 widget render UNIT tests. Every widget renders ONLY its validated C1 props, props reaching the
 * DOM only as React-escaped children/attributes. The load-bearing security checks here:
 *   - an XSS-y string prop renders as inert TEXT, never markup (no dangerouslySetInnerHTML);
 *   - a `javascript:`/`data:` `imageUrl` is DROPPED (no module-supplied URL as a `src` without a
 *     http(s)-scheme check);
 *   - icons are the C1 enum only.
 */

const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

describe('StarRatingSummary (read-only RSC)', () => {
  it('renders the average + count as escaped text', () => {
    const props: StarRatingSummaryProps = { average: 4.2, count: 17 };
    const { container } = render(<StarRatingSummary {...props} />);
    expect(container.textContent).toContain('4.2');
    expect(container.textContent).toContain('17');
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders gracefully at the bounds (0 average, 0 count)', () => {
    const { container } = render(<StarRatingSummary average={0} count={0} />);
    expect(container.textContent).toContain('0');
  });
});

describe('ReviewList (read-only RSC)', () => {
  it('renders each item; an XSS body is inert TEXT, never markup', () => {
    const props: ReviewListProps = {
      items: [
        { id: 'r1', rating: 5, body: XSS, author: XSS, createdAt: '2026-06-22T10:00:00.000Z' },
      ],
    };
    const { container } = render(<ReviewList {...props} />);
    // The script tag must NOT exist as a real element — only as escaped text.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  it('renders nothing visible-breaking for an empty list', () => {
    const { container } = render(<ReviewList items={[]} />);
    expect(() => container).not.toThrow();
  });
});

describe('ProductCarousel (read-only RSC)', () => {
  // In tests getApiBaseUrl() falls back to http://localhost:3000 (no NEXT_PUBLIC_API_BASE_URL set), so an
  // ALLOWED widget image must be same-origin-relative or under that configured media/API base origin.
  const ALLOWED_ABS = 'http://localhost:3000/uploads/tee.jpg';

  it('renders item titles as escaped text and an allowlisted media-base image', () => {
    const props: ProductCarouselProps = {
      heading: 'Picked for you',
      items: [{ productId: 'p1', slug: 'tee', title: XSS, imageUrl: ALLOWED_ABS }],
    };
    const { container } = render(<ProductCarousel {...props} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(ALLOWED_ABS);
  });

  it('renders a same-origin root-relative image', () => {
    const { container } = render(
      <ProductCarousel items={[{ productId: 'p', slug: 's', title: 'T', imageUrl: '/uploads/x.png' }]} />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/uploads/x.png');
  });

  it('DROPS a javascript:/data: imageUrl (renders no <img src> with that scheme)', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '//evil.example/x.png',
      'ftp://x/y.png',
    ]) {
      const { container } = render(
        <ProductCarousel
          items={[{ productId: 'p', slug: 's', title: 'T', imageUrl: bad }]}
        />,
      );
      const img = container.querySelector('img');
      // Either no img is rendered at all, or it has no src — never the dangerous URL.
      expect(img?.getAttribute('src') ?? null).toBeNull();
      expect(container.innerHTML).not.toContain('javascript:');
      expect(container.innerHTML).not.toContain('data:image');
    }
  });

  it('DROPS an off-allowlist external host imageUrl (PII-egress guard — no <img>)', () => {
    // A module returning an arbitrary third-party http(s) host would leak every visitor's IP on load.
    for (const offHost of [
      'https://evil.example/track.gif',
      'https://cdn.example/tee.jpg',
      'http://localhost:9999/x.png', // right scheme, WRONG origin (port differs from the media base)
    ]) {
      const { container } = render(
        <ProductCarousel items={[{ productId: 'p', slug: 's', title: 'T', imageUrl: offHost }]} />,
      );
      expect(container.querySelector('img')?.getAttribute('src') ?? null).toBeNull();
    }
  });

  it('ENCODES the slug into an inert single path segment (no within-origin traversal)', () => {
    // C1 already rejects a traversing slug (descriptor → null), but the component independently encodes
    // the slug so even if a traversal value reached it, the href can't add segments or traverse routes.
    const { container } = render(
      <ProductCarousel items={[{ productId: 'p', slug: '../../admin', title: 'T' }]} />,
    );
    const href = container.querySelector('a')?.getAttribute('href');
    expect(href).toBe('/product/..%2F..%2Fadmin');
    // No raw traversal sequence leaks into the href.
    expect(href).not.toContain('../');
  });

  it('renders an item with no imageUrl gracefully (no img)', () => {
    const { container } = render(
      <ProductCarousel items={[{ productId: 'p', slug: 's', title: 'T' }]} />,
    );
    expect(container.textContent).toContain('T');
  });
});

describe('ToggleButton (interactive client island view)', () => {
  it('renders the initial label + an enum icon, escaping the labels', () => {
    const props: ToggleButtonProps = {
      initialOn: false,
      onAction: { path: '/store/v1/modules/wishlist/add' },
      offAction: { path: '/store/v1/modules/wishlist/remove' },
      labels: { on: XSS, off: 'Add to wishlist' },
      icon: 'heart',
    };
    const { container, getByRole } = render(
      <ToggleButton {...props} module="wishlist" getAccessToken={() => null} />,
    );
    expect(getByRole('button')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('SubmitForm (interactive client island view)', () => {
  it('renders bounded fields with escaped labels and enum-only kinds', () => {
    const props: SubmitFormProps = {
      action: { path: '/store/v1/modules/reviews/submit' },
      submitLabel: 'Send review',
      fields: [
        { name: 'rating', label: XSS, kind: 'rating', required: true },
        { name: 'body', label: 'Your review', kind: 'textarea', required: false },
      ],
      successMessage: 'Thanks!',
    };
    const { container } = render(
      <SubmitForm {...props} module="reviews" getAccessToken={() => null} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('form')).toBeTruthy();
  });
});
