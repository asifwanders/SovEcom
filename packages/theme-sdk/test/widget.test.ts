import { describe, it, expect } from 'vitest';
import {
  parseWidget,
  WIDGET_TYPES,
  widgetDescriptorSchema,
  starRatingSummaryPropsSchema,
  reviewListPropsSchema,
  productCarouselPropsSchema,
  toggleButtonPropsSchema,
  submitFormPropsSchema,
  WIDGET_MAX_BYTES,
} from '../src/index.js';
import type {
  WidgetDescriptor,
  StarRatingSummaryProps,
  ReviewListProps,
  ProductCarouselProps,
  ToggleButtonProps,
  SubmitFormProps,
} from '../src/index.js';

/**
 * Follow-up C1 — the closed, core-owned MIT widget vocabulary + its pure validators.
 * Mirrors the manifest/template test style: per-widget `valid*()` fixtures + targeted rejections, all
 * driving `parseWidget` (the byte-cap + JSON.parse + discriminated-union Zod pipeline) which returns
 * the typed descriptor or `null` on ANY failure (never throws — C1's defensive contract, distinct from
 * `parseTemplate` which throws). No raw control bytes appear in any test string (escapes only).
 */

// ── per-widget valid `props` fixtures ─────────────────────────────────────────────
function validStarRating(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { average: 4.2, count: 17, ...over };
}
function validReviewList(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [
      { id: 'r1', rating: 5, body: 'Great', author: 'Ada', createdAt: '2026-06-22T10:00:00.000Z' },
      { id: 'r2', rating: 3, body: 'Okay', createdAt: '2026-06-21T09:00:00.000Z' },
    ],
    ...over,
  };
}
function validProductCarousel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    heading: 'You may also like',
    items: [
      { productId: 'p1', slug: 'blue-shirt', title: 'Blue Shirt', imageUrl: '/img/blue.jpg' },
      { productId: 'p2', slug: 'red-hat', title: 'Red Hat' },
    ],
    ...over,
  };
}
function validToggleButton(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    initialOn: false,
    onAction: { path: '/store/v1/modules/wishlist/add' },
    offAction: { path: '/store/v1/modules/wishlist/remove' },
    labels: { on: 'Saved', off: 'Save' },
    icon: 'heart',
    ...over,
  };
}
function validSubmitForm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: { path: '/store/v1/modules/reviews/submit' },
    submitLabel: 'Post review',
    fields: [
      { name: 'rating', label: 'Rating', kind: 'rating', required: true },
      { name: 'body', label: 'Your review', kind: 'textarea', required: true },
      {
        name: 'size',
        label: 'Size',
        kind: 'select',
        required: false,
        options: ['S', 'M', 'L'],
      },
    ],
    successMessage: 'Thanks for your review!',
    ...over,
  };
}

// ── full descriptor helpers ───────────────────────────────────────────────────────
function descriptor(type: string, props: Record<string, unknown>): Record<string, unknown> {
  return { type, props };
}
const validDescriptors: Record<string, Record<string, unknown>> = {
  'star-rating-summary': descriptor('star-rating-summary', validStarRating()),
  'review-list': descriptor('review-list', validReviewList()),
  'product-carousel': descriptor('product-carousel', validProductCarousel()),
  'toggle-button': descriptor('toggle-button', validToggleButton()),
  'submit-form': descriptor('submit-form', validSubmitForm()),
};

describe('WIDGET_TYPES', () => {
  it('is the closed, expected vocabulary', () => {
    expect(WIDGET_TYPES).toEqual([
      'star-rating-summary',
      'review-list',
      'product-carousel',
      'toggle-button',
      'submit-form',
    ]);
  });
});

describe('parseWidget — valid descriptors', () => {
  for (const type of WIDGET_TYPES) {
    it(`parses a valid ${type} descriptor (string + object input)`, () => {
      const raw = validDescriptors[type]!;
      const fromString = parseWidget(JSON.stringify(raw));
      expect(fromString).not.toBeNull();
      expect(fromString!.type).toBe(type);
      // also accepts an already-parsed object (mirrors how the storefront may hand it the parsed JSON)
      const fromObject = parseWidget(raw);
      expect(fromObject).not.toBeNull();
      expect(fromObject!.type).toBe(type);
    });
  }

  it('returns a fully-typed descriptor with its props', () => {
    const w = parseWidget(JSON.stringify(validDescriptors['star-rating-summary']));
    expect(w).not.toBeNull();
    const props = w!.props as StarRatingSummaryProps;
    expect(props.average).toBe(4.2);
    expect(props.count).toBe(17);
  });

  it('drops optional fields when absent (review author / carousel heading+imageUrl / form success)', () => {
    const w = parseWidget(JSON.stringify(validDescriptors['review-list']));
    const props = w!.props as ReviewListProps;
    expect(props.items[1]!.author).toBeUndefined();
  });
});

describe('parseWidget — type/shape failures (null, never throws)', () => {
  it('returns null for an unknown widget type', () => {
    expect(parseWidget(JSON.stringify(descriptor('marquee', {})))).toBeNull();
  });

  it('returns null when props do not match the type (discriminator mismatch)', () => {
    // star-rating props handed to review-list
    expect(parseWidget(JSON.stringify(descriptor('review-list', validStarRating())))).toBeNull();
    // review-list props handed to product-carousel
    expect(
      parseWidget(JSON.stringify(descriptor('product-carousel', validReviewList()))),
    ).toBeNull();
  });

  it('returns null for a non-object input', () => {
    expect(parseWidget(JSON.stringify(42))).toBeNull();
    expect(parseWidget(JSON.stringify('a string'))).toBeNull();
    expect(parseWidget(JSON.stringify([{ type: 'star-rating-summary' }]))).toBeNull();
    expect(parseWidget(JSON.stringify(null))).toBeNull();
  });

  it('returns null for a non-JSON string (never throws)', () => {
    expect(parseWidget('{not json')).toBeNull();
    expect(parseWidget('')).toBeNull();
  });

  it('returns null for undefined / non-string-non-object raw', () => {
    expect(parseWidget(undefined)).toBeNull();
    expect(parseWidget(123)).toBeNull();
  });

  it('rejects an unknown key at the descriptor level (.strict)', () => {
    const raw = { ...validDescriptors['star-rating-summary'], rogue: 1 };
    expect(parseWidget(JSON.stringify(raw))).toBeNull();
  });

  it('rejects an unknown key at the props level (.strict)', () => {
    const raw = descriptor('star-rating-summary', validStarRating({ rogue: 1 }));
    expect(parseWidget(JSON.stringify(raw))).toBeNull();
  });

  it('rejects a descriptor missing props or type', () => {
    expect(parseWidget(JSON.stringify({ type: 'star-rating-summary' }))).toBeNull();
    expect(parseWidget(JSON.stringify({ props: validStarRating() }))).toBeNull();
  });

  it('rejects a raw larger than the byte cap', () => {
    const huge = descriptor(
      'product-carousel',
      validProductCarousel({ heading: 'x'.repeat(WIDGET_MAX_BYTES) }),
    );
    expect(parseWidget(JSON.stringify(huge))).toBeNull();
  });
});

describe('star-rating-summary bounds', () => {
  it('accepts the boundary values (0 and 5, count 0)', () => {
    expect(
      parseWidget(JSON.stringify(descriptor('star-rating-summary', { average: 0, count: 0 }))),
    ).not.toBeNull();
    expect(
      parseWidget(JSON.stringify(descriptor('star-rating-summary', { average: 5, count: 99 }))),
    ).not.toBeNull();
  });
  it('rejects average < 0 or > 5', () => {
    expect(
      parseWidget(
        JSON.stringify(descriptor('star-rating-summary', validStarRating({ average: -0.1 }))),
      ),
    ).toBeNull();
    expect(
      parseWidget(
        JSON.stringify(descriptor('star-rating-summary', validStarRating({ average: 5.1 }))),
      ),
    ).toBeNull();
  });
  it('rejects a non-integer or negative count', () => {
    expect(
      parseWidget(
        JSON.stringify(descriptor('star-rating-summary', validStarRating({ count: 2.5 }))),
      ),
    ).toBeNull();
    expect(
      parseWidget(
        JSON.stringify(descriptor('star-rating-summary', validStarRating({ count: -1 }))),
      ),
    ).toBeNull();
  });
  it('rejects NaN / Infinity for average (JSON.parse cannot carry them, but lock the schema in)', () => {
    // NaN/Infinity are not representable in JSON, so feed the parsed-object path directly.
    expect(parseWidget(descriptor('star-rating-summary', { average: NaN, count: 1 }))).toBeNull();
    expect(
      parseWidget(descriptor('star-rating-summary', { average: Infinity, count: 1 })),
    ).toBeNull();
    expect(
      parseWidget(descriptor('star-rating-summary', { average: -Infinity, count: 1 })),
    ).toBeNull();
  });
});

describe('review-list bounds', () => {
  it('rejects an over-length items array', () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      id: `r${i}`,
      rating: 4,
      body: 'ok',
      createdAt: '2026-06-22T10:00:00.000Z',
    }));
    expect(parseWidget(JSON.stringify(descriptor('review-list', { items })))).toBeNull();
  });
  it('rejects rating out of 1..5 or non-integer', () => {
    expect(
      parseWidget(
        JSON.stringify(
          descriptor('review-list', {
            items: [{ id: 'r1', rating: 0, body: 'x', createdAt: '2026-06-22T10:00:00.000Z' }],
          }),
        ),
      ),
    ).toBeNull();
    expect(
      parseWidget(
        JSON.stringify(
          descriptor('review-list', {
            items: [{ id: 'r1', rating: 6, body: 'x', createdAt: '2026-06-22T10:00:00.000Z' }],
          }),
        ),
      ),
    ).toBeNull();
  });
  it('rejects an over-length id / body / author', () => {
    const base = { id: 'r1', rating: 4, body: 'x', createdAt: '2026-06-22T10:00:00.000Z' };
    expect(
      parseWidget(
        JSON.stringify(descriptor('review-list', { items: [{ ...base, id: 'x'.repeat(65) }] })),
      ),
    ).toBeNull();
    expect(
      parseWidget(
        JSON.stringify(descriptor('review-list', { items: [{ ...base, body: 'x'.repeat(2001) }] })),
      ),
    ).toBeNull();
    expect(
      parseWidget(
        JSON.stringify(
          descriptor('review-list', { items: [{ ...base, author: 'x'.repeat(121) }] }),
        ),
      ),
    ).toBeNull();
  });
  it('rejects NaN / Infinity for rating (parsed-object path)', () => {
    const item = (rating: number) => ({
      id: 'r1',
      body: 'x',
      createdAt: '2026-06-22T10:00:00.000Z',
      rating,
    });
    expect(parseWidget(descriptor('review-list', { items: [item(NaN)] }))).toBeNull();
    expect(parseWidget(descriptor('review-list', { items: [item(Infinity)] }))).toBeNull();
  });
  it('rejects a non-ISO createdAt', () => {
    expect(
      parseWidget(
        JSON.stringify(
          descriptor('review-list', {
            items: [{ id: 'r1', rating: 4, body: 'x', createdAt: 'last tuesday' }],
          }),
        ),
      ),
    ).toBeNull();
  });
});

describe('product-carousel bounds', () => {
  it('rejects an over-length items array', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      productId: `p${i}`,
      slug: `s${i}`,
      title: `T${i}`,
    }));
    expect(parseWidget(JSON.stringify(descriptor('product-carousel', { items })))).toBeNull();
  });
  it('rejects over-length heading / productId / slug / title / imageUrl', () => {
    expect(
      parseWidget(
        JSON.stringify(
          descriptor('product-carousel', validProductCarousel({ heading: 'x'.repeat(121) })),
        ),
      ),
    ).toBeNull();
    const bad = (over: Record<string, unknown>) =>
      descriptor('product-carousel', {
        items: [{ productId: 'p1', slug: 's', title: 't', ...over }],
      });
    expect(parseWidget(JSON.stringify(bad({ productId: 'x'.repeat(65) })))).toBeNull();
    expect(parseWidget(JSON.stringify(bad({ slug: 'x'.repeat(201) })))).toBeNull();
    expect(parseWidget(JSON.stringify(bad({ title: 'x'.repeat(201) })))).toBeNull();
    expect(parseWidget(JSON.stringify(bad({ imageUrl: 'x'.repeat(2049) })))).toBeNull();
  });
  it('accepts an item without the optional imageUrl', () => {
    expect(
      parseWidget(
        JSON.stringify(
          descriptor('product-carousel', { items: [{ productId: 'p1', slug: 's', title: 't' }] }),
        ),
      ),
    ).not.toBeNull();
  });
  it('REJECTS a slug carrying a path-traversal mechanism (within-origin redirect guard)', () => {
    const bad = (slug: string) =>
      descriptor('product-carousel', { items: [{ productId: 'p1', slug, title: 't' }] });
    for (const slug of ['../../admin', '..', 'a/b', 'foo/../bar', 'x\\y', '/abs', 'a/']) {
      expect(parseWidget(JSON.stringify(bad(slug)))).toBeNull();
    }
  });
  it('accepts a normal slug with hyphens / unicode (not over-constrained to a strict charset)', () => {
    for (const slug of ['blue-shirt', 'chemise-bleue', 'tee_2', 'café-noir']) {
      expect(
        parseWidget(
          JSON.stringify(
            descriptor('product-carousel', { items: [{ productId: 'p1', slug, title: 't' }] }),
          ),
        ),
      ).not.toBeNull();
    }
  });
});

describe('toggle-button bounds + enums', () => {
  it('accepts each valid icon enum value', () => {
    for (const icon of ['heart', 'bell', 'star']) {
      expect(
        parseWidget(JSON.stringify(descriptor('toggle-button', validToggleButton({ icon })))),
      ).not.toBeNull();
    }
  });
  it('rejects an icon outside the enum', () => {
    expect(
      parseWidget(
        JSON.stringify(descriptor('toggle-button', validToggleButton({ icon: 'flame' }))),
      ),
    ).toBeNull();
  });
  it('rejects a non-boolean initialOn', () => {
    expect(
      parseWidget(
        JSON.stringify(descriptor('toggle-button', validToggleButton({ initialOn: 'yes' }))),
      ),
    ).toBeNull();
  });
  it('rejects over-length labels', () => {
    expect(
      parseWidget(
        JSON.stringify(
          descriptor(
            'toggle-button',
            validToggleButton({ labels: { on: 'x'.repeat(61), off: 'Save' } }),
          ),
        ),
      ),
    ).toBeNull();
  });
  it('rejects a bad onAction/offAction path (absolute URL)', () => {
    expect(
      parseWidget(
        JSON.stringify(
          descriptor(
            'toggle-button',
            validToggleButton({
              onAction: { path: 'https://evil.test/store/v1/modules/wishlist/add' },
            }),
          ),
        ),
      ),
    ).toBeNull();
  });
});

describe('submit-form bounds + enums', () => {
  it('accepts each valid field kind', () => {
    for (const kind of ['text', 'textarea', 'rating', 'email', 'select']) {
      const f = { name: 'f', label: 'F', kind, required: false };
      expect(
        parseWidget(
          JSON.stringify(
            descriptor('submit-form', {
              action: { path: '/store/v1/modules/reviews/submit' },
              submitLabel: 'Go',
              fields: [f],
            }),
          ),
        ),
      ).not.toBeNull();
    }
  });
  it('rejects a field kind outside the enum', () => {
    const f = { name: 'f', label: 'F', kind: 'password', required: false };
    expect(
      parseWidget(JSON.stringify(descriptor('submit-form', validSubmitForm({ fields: [f] })))),
    ).toBeNull();
  });
  it('rejects an over-length fields array (> 8)', () => {
    const fields = Array.from({ length: 9 }, (_, i) => ({
      name: `f${i}`,
      label: 'F',
      kind: 'text',
      required: false,
    }));
    expect(
      parseWidget(JSON.stringify(descriptor('submit-form', validSubmitForm({ fields })))),
    ).toBeNull();
  });
  it('rejects over-length field name / label / submitLabel / successMessage', () => {
    const ok = { name: 'f', label: 'F', kind: 'text', required: false };
    expect(
      parseWidget(
        JSON.stringify(
          descriptor('submit-form', validSubmitForm({ fields: [{ ...ok, name: 'x'.repeat(41) }] })),
        ),
      ),
    ).toBeNull();
    expect(
      parseWidget(
        JSON.stringify(
          descriptor(
            'submit-form',
            validSubmitForm({ fields: [{ ...ok, label: 'x'.repeat(121) }] }),
          ),
        ),
      ),
    ).toBeNull();
    expect(
      parseWidget(
        JSON.stringify(descriptor('submit-form', validSubmitForm({ submitLabel: 'x'.repeat(61) }))),
      ),
    ).toBeNull();
    expect(
      parseWidget(
        JSON.stringify(
          descriptor('submit-form', validSubmitForm({ successMessage: 'x'.repeat(201) })),
        ),
      ),
    ).toBeNull();
  });
  it('rejects an over-length options array (> 20) and over-length option', () => {
    const manyOpts = Array.from({ length: 21 }, (_, i) => `o${i}`);
    const f1 = { name: 'f', label: 'F', kind: 'select', required: false, options: manyOpts };
    expect(
      parseWidget(JSON.stringify(descriptor('submit-form', validSubmitForm({ fields: [f1] })))),
    ).toBeNull();
    const f2 = {
      name: 'f',
      label: 'F',
      kind: 'select',
      required: false,
      options: ['x'.repeat(121)],
    };
    expect(
      parseWidget(JSON.stringify(descriptor('submit-form', validSubmitForm({ fields: [f2] })))),
    ).toBeNull();
  });
  it('rejects a bad action path', () => {
    expect(
      parseWidget(
        JSON.stringify(
          descriptor(
            'submit-form',
            validSubmitForm({ action: { path: '/admin/v1/modules/reviews/submit' } }),
          ),
        ),
      ),
    ).toBeNull();
  });
});

describe('action-path shape validation (header-injection-safe relative path)', () => {
  // these all run through the toggle-button onAction.path schema via parseWidget
  function pathOk(path: string): boolean {
    return (
      parseWidget(
        JSON.stringify(descriptor('toggle-button', validToggleButton({ onAction: { path } }))),
      ) !== null
    );
  }
  it('accepts a clean relative module path', () => {
    expect(pathOk('/store/v1/modules/foo/add')).toBe(true);
    expect(pathOk('/store/v1/modules/foo/sub/path-123')).toBe(true);
  });
  it('rejects a path not under /store/v1/modules/', () => {
    expect(pathOk('/store/v1/products/foo')).toBe(false);
    expect(pathOk('/anything/else')).toBe(false);
    expect(pathOk('store/v1/modules/foo')).toBe(false); // missing leading slash
  });
  it('rejects an absolute URL with a scheme/host', () => {
    expect(pathOk('https://evil.test/store/v1/modules/foo')).toBe(false);
    expect(pathOk('//evil.test/store/v1/modules/foo')).toBe(false);
    expect(pathOk('http:/store/v1/modules/foo')).toBe(false);
  });
  it('rejects `..` traversal', () => {
    expect(pathOk('/store/v1/modules/foo/../../bar')).toBe(false);
    expect(pathOk('/store/v1/modules/../secret')).toBe(false);
  });
  it('rejects CR / LF (header injection)', () => {
    expect(pathOk('/store/v1/modules/foo\r\nX-Inject: 1')).toBe(false);
    expect(pathOk('/store/v1/modules/foo\nbar')).toBe(false);
    expect(pathOk('/store/v1/modules/foo\rbar')).toBe(false);
  });
  it('rejects other control characters', () => {
    expect(pathOk('/store/v1/modules/foo\u0000bar')).toBe(false);
    expect(pathOk('/store/v1/modules/foo\tbar')).toBe(false);
    expect(pathOk('/store/v1/modules/foo\u007fbar')).toBe(false);
  });
  it('rejects an over-length path', () => {
    expect(pathOk('/store/v1/modules/foo/' + 'a'.repeat(4096))).toBe(false);
  });
  it('rejects percent-encoding entirely (no encoding channel for `..` / CRLF)', () => {
    // `%` is banned from the char class, so encoded traversal/CRLF cannot slip past the raw
    // segment refine (which never decodes). All of these must reject on the `%` alone.
    expect(pathOk('/store/v1/modules/foo/%2e%2e/admin')).toBe(false);
    expect(pathOk('/store/v1/modules/foo/%2E%2E/admin')).toBe(false);
    expect(pathOk('/store/v1/modules/foo/.%2e/admin')).toBe(false);
    expect(pathOk('/store/v1/modules/foo/%2e./admin')).toBe(false);
    expect(pathOk('/store/v1/modules/foo%0d%0aX-Inject:evil/bar')).toBe(false);
    expect(pathOk('/store/v1/modules/foo%20bar')).toBe(false);
    // even a single bare `%` rejects — there is no legitimate need for it in an action path.
    expect(pathOk('/store/v1/modules/foo%bar')).toBe(false);
  });
});

describe('per-widget props schemas (direct, .strict())', () => {
  it('starRatingSummaryPropsSchema validates a clean shape and rejects extras', () => {
    expect(starRatingSummaryPropsSchema.safeParse(validStarRating()).success).toBe(true);
    expect(starRatingSummaryPropsSchema.safeParse(validStarRating({ extra: 1 })).success).toBe(
      false,
    );
  });
  it('reviewListPropsSchema / productCarouselPropsSchema / toggleButtonPropsSchema / submitFormPropsSchema are exported and strict', () => {
    expect(reviewListPropsSchema.safeParse(validReviewList()).success).toBe(true);
    expect(productCarouselPropsSchema.safeParse(validProductCarousel()).success).toBe(true);
    expect(toggleButtonPropsSchema.safeParse(validToggleButton()).success).toBe(true);
    expect(submitFormPropsSchema.safeParse(validSubmitForm()).success).toBe(true);
  });
});

describe('widgetDescriptorSchema (discriminated union)', () => {
  it('validates each widget type against its own props', () => {
    for (const type of WIDGET_TYPES) {
      expect(widgetDescriptorSchema.safeParse(validDescriptors[type]).success).toBe(true);
    }
  });
  it('is .strict() at the descriptor level', () => {
    expect(
      widgetDescriptorSchema.safeParse({ ...validDescriptors['review-list'], rogue: 1 }).success,
    ).toBe(false);
  });
});

describe('type exports', () => {
  it('WidgetDescriptor + per-widget prop types are usable', () => {
    const props: StarRatingSummaryProps = { average: 4, count: 1 };
    const w: WidgetDescriptor = { type: 'star-rating-summary', props };
    expect(w.type).toBe('star-rating-summary');
    // each prop type is referenceable
    const rl: ReviewListProps = { items: [] };
    const pc: ProductCarouselProps = { items: [] };
    const tb: ToggleButtonProps = validToggleButton() as unknown as ToggleButtonProps;
    const sf: SubmitFormProps = validSubmitForm() as unknown as SubmitFormProps;
    expect(rl.items).toEqual([]);
    expect(pc.items).toEqual([]);
    expect(tb.icon).toBe('heart');
    expect(sf.submitLabel).toBe('Post review');
  });
});
