/**
 * the module slot-widget CONTRACT + vocabulary.
 *
 * A sandboxed module contributes storefront UI by returning a typed **widget descriptor**
 * `{ type, props }` — a widget `type` from a CLOSED, core-owned MIT vocabulary plus validated props.
 * The storefront renders its OWN known MIT components with that data; NO code, NO HTML, NO SVG
 * crosses the boundary — only DATA.
 *
 * Like `manifest.ts` / `template.ts`, this file is a declarative ASSET contract: PURE validators +
 * types only. There is NO React, NO fetch, NO Node runtime API, NO render here. `parseWidget` mirrors
 * `parseTemplate`'s byte-cap + JSON.parse + Zod pipeline, with ONE deliberate difference: it returns
 * `null` on ANY failure (never throws) — the defensive fail-closed contract the storefront RSC relies
 * on to "render nothing, never 500 the page".
 *
 * The byte cap is its own constant ({@link WIDGET_MAX_BYTES}) but reuses the manifest cap value so a
 * widget descriptor is gated by the same finite bound — one numeric home, no divergence.
 */
import { z } from 'zod';
import { MANIFEST_MAX_BYTES } from './manifest.js';

/**
 * The CLOSED, core-owned widget vocabulary. A module author CANNOT register a new type;
 * adding one is an MIT storefront contribution reviewed like adding a section. The
 * `component` slug in a module manifest's `slots[]` IS one of these `type`s. The literal-tuple
 * `as const` lets the discriminated union below mirror it exactly.
 */
export const WIDGET_TYPES = [
  'star-rating-summary',
  'review-list',
  'product-carousel',
  'toggle-button',
  'submit-form',
] as const;

/** A validated widget type (one of {@link WIDGET_TYPES}). */
export type WidgetType = (typeof WIDGET_TYPES)[number];

/**
 * Byte cap for a raw widget descriptor. Reuses the manifest cap VALUE (one source of truth) — a
 * descriptor is small data, so this generous bound only rejects pathological payloads up front, before
 * any JSON.parse or schema work.
 */
export const WIDGET_MAX_BYTES = MANIFEST_MAX_BYTES;

// ── shared field bounds (every string capped, every array `.max`, every number ranged) ───
const MAX_ID_LEN = 64;
const MAX_REVIEW_BODY_LEN = 2000;
const MAX_AUTHOR_LEN = 120;
const MAX_REVIEW_ITEMS = 50;
const MAX_HEADING_LEN = 120;
const MAX_SLUG_LEN = 200;
const MAX_TITLE_LEN = 200;
const MAX_IMAGE_URL_LEN = 2048;
const MAX_CAROUSEL_ITEMS = 24;
const MAX_LABEL_LEN = 60;
const MAX_FIELD_NAME_LEN = 40;
const MAX_FIELD_LABEL_LEN = 120;
const MAX_FORM_FIELDS = 8;
const MAX_OPTION_LEN = 120;
const MAX_OPTIONS = 20;
const MAX_SUCCESS_MSG_LEN = 200;
/** Generous-but-finite bound on an action path — rejects a pathological path before refining it. */
const MAX_ACTION_PATH_LEN = 512;

/**
 * The required prefix for an interactive widget's POST-back `action`/`onAction`/`offAction` path.
 * This layer can only validate the SHAPE — it cannot know the originating module's name. The storefront
 * enforces that the path targets the ORIGINATING module's own mount (the module name comes from the slot
 * BINDING, never from the descriptor). See {@link actionPathSchema}.
 */
const ACTION_PATH_PREFIX = '/store/v1/modules/';

/**
 * A header-injection-safe RELATIVE action path. This layer validates the SHAPE only; the storefront binds
 * it to the originating module's mount. Rejects: anything not starting with {@link ACTION_PATH_PREFIX}
 * (so no absolute `https://`/`http:`/`//host` URL, no scheme, no other origin); any `..` path traversal; any
 * CR/LF or other ASCII control character (header-injection / response-splitting); and over-length.
 *
 * The allowlist regex is the real gate: a clean path is a `/store/v1/modules/` prefix followed only by
 * URL-safe path characters (`A–Z a–z 0–9 - _ . ~ / : @ ! $ & ' ( ) * + , ; =`). Because `/` is the
 * only structural separator and `\r`/`\n`/space/control bytes are NOT in the class, CRLF and control
 * chars cannot match; `..` is rejected by an explicit segment check (defence in depth — a `.` IS in the
 * class, so the regex alone would admit `..`).
 *
 * `%` is DELIBERATELY EXCLUDED from the class. An action path is a simple relative endpoint (POST
 * params ride the body, never the path), so it never needs percent-encoding — and admitting `%` would
 * open an encoding channel where `%2e%2e` (→ `..`) or `%0d%0a` (→ CR/LF) passes the char-by-char regex
 * AND the RAW `split('/')` segment refine (which never decodes), re-introducing traversal / response-
 * splitting after the fact. With `%` banned there is NO encoding channel: a literal `..` is caught by
 * the segment refine, and CRLF / space / control / backslash / unicode are all already outside the class.
 */
const SAFE_PATH_BODY_RE = /^\/store\/v1\/modules\/[A-Za-z0-9\-._~/:@!$&'()*+,;=]*$/;

export const actionPathSchema = z
  .string()
  .min(ACTION_PATH_PREFIX.length)
  .max(MAX_ACTION_PATH_LEN)
  .regex(SAFE_PATH_BODY_RE, 'action path must be a clean relative /store/v1/modules/... path')
  .refine((p) => !p.split('/').includes('..'), {
    message: 'action path must not contain `..` traversal',
  });

/** An interactive widget's action target: just a validated relative `path` (C1 shape-only). */
export const actionSchema = z.object({ path: actionPathSchema }).strict();

// ── per-widget props schemas (each `.strict()`, fully bounded) ────────────────────

/** `star-rating-summary` props: an average in [0,5] and a non-negative integer count. */
export const starRatingSummaryPropsSchema = z
  .object({
    average: z.number().min(0).max(5),
    count: z.number().int().min(0),
  })
  .strict();

/** `review-list` props: a bounded list of bounded review items (id/rating/body/author/createdAt). */
export const reviewListPropsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(MAX_ID_LEN),
            rating: z.number().int().min(1).max(5),
            body: z.string().max(MAX_REVIEW_BODY_LEN),
            author: z.string().max(MAX_AUTHOR_LEN).optional(),
            // An ISO-8601 datetime string (e.g. `2026-06-22T10:00:00.000Z`). z.iso.datetime is a pure
            // format check — no Date construction, no I/O.
            createdAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(MAX_REVIEW_ITEMS),
  })
  .strict();

/**
 * A product `slug` used to build a `/product/<slug>` link. Bounded length + a TRAVERSAL guard: it must
 * not contain `/` or `\` (no extra path segments) and must not be a `..` segment — so a module can't
 * return `slug:'../../admin'` and turn the carousel link into a within-origin redirect to another route.
 * NOT constrained to a strict charset (real slugs vary by locale/tenant); only the traversal MECHANISM
 * is barred. C2 ALSO `encodeURIComponent`s the slug at render (defense in depth) — this is the contract
 * layer that rejects the descriptor outright. The `..` check is on the whole value (the slash ban already
 * means a `..` can only appear as the entire slug, but checking explicitly keeps the intent legible).
 */
const carouselSlugSchema = z
  .string()
  .min(1)
  .max(MAX_SLUG_LEN)
  .refine((s) => !s.includes('/') && !s.includes('\\') && s !== '..', {
    message: 'slug must not contain path separators or a `..` traversal segment',
  });

/** `product-carousel` props: an optional heading + a bounded list of bounded product cards. */
export const productCarouselPropsSchema = z
  .object({
    heading: z.string().max(MAX_HEADING_LEN).optional(),
    items: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(MAX_ID_LEN),
            slug: carouselSlugSchema,
            title: z.string().min(1).max(MAX_TITLE_LEN),
            imageUrl: z.string().max(MAX_IMAGE_URL_LEN).optional(),
          })
          .strict(),
      )
      .max(MAX_CAROUSEL_ITEMS),
  })
  .strict();

/** `toggle-button` props: on/off actions (relative paths), bounded labels, enum-only icon. */
export const toggleButtonPropsSchema = z
  .object({
    initialOn: z.boolean(),
    onAction: actionSchema,
    offAction: actionSchema,
    labels: z
      .object({
        on: z.string().min(1).max(MAX_LABEL_LEN),
        off: z.string().min(1).max(MAX_LABEL_LEN),
      })
      .strict(),
    icon: z.enum(['heart', 'bell', 'star']),
  })
  .strict();

/** `submit-form` props: a relative action path, a bounded field list with enum-only kinds. */
export const submitFormPropsSchema = z
  .object({
    action: actionSchema,
    submitLabel: z.string().min(1).max(MAX_LABEL_LEN),
    fields: z
      .array(
        z
          .object({
            name: z.string().min(1).max(MAX_FIELD_NAME_LEN),
            label: z.string().min(1).max(MAX_FIELD_LABEL_LEN),
            kind: z.enum(['text', 'textarea', 'rating', 'email', 'select']),
            required: z.boolean(),
            options: z.array(z.string().max(MAX_OPTION_LEN)).max(MAX_OPTIONS).optional(),
          })
          .strict(),
      )
      .max(MAX_FORM_FIELDS),
    successMessage: z.string().max(MAX_SUCCESS_MSG_LEN).optional(),
  })
  .strict();

/**
 * The widget descriptor: `{ type, props }` discriminated on `type`, so each widget's props are
 * validated against ITS OWN schema (wrong props for a type ⇒ fail). `.strict()` on each member rejects
 * unknown keys at the descriptor level; the per-widget props schemas are `.strict()` too, so unknown
 * keys are rejected at BOTH levels.
 */
export const widgetDescriptorSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('star-rating-summary'), props: starRatingSummaryPropsSchema })
    .strict(),
  z.object({ type: z.literal('review-list'), props: reviewListPropsSchema }).strict(),
  z.object({ type: z.literal('product-carousel'), props: productCarouselPropsSchema }).strict(),
  z.object({ type: z.literal('toggle-button'), props: toggleButtonPropsSchema }).strict(),
  z.object({ type: z.literal('submit-form'), props: submitFormPropsSchema }).strict(),
]);

// ── exported prop + descriptor types ──────────────────────────────────────────────
export type StarRatingSummaryProps = z.infer<typeof starRatingSummaryPropsSchema>;
export type ReviewListProps = z.infer<typeof reviewListPropsSchema>;
export type ProductCarouselProps = z.infer<typeof productCarouselPropsSchema>;
export type ToggleButtonProps = z.infer<typeof toggleButtonPropsSchema>;
export type SubmitFormProps = z.infer<typeof submitFormPropsSchema>;
/** A validated widget descriptor (the discriminated `{ type, props }`). */
export type WidgetDescriptor = z.infer<typeof widgetDescriptorSchema>;

/**
 * Parse + verify a raw widget descriptor. PURE — no I/O, no code execution, no render.
 *
 * Accepts either a JSON string (the wire form — byte-capped, then `JSON.parse`d, mirroring
 * {@link parseTemplate}) or an already-parsed value (so the storefront can hand it the parsed JSON
 * directly). Enforces the byte cap on the string form, validates against {@link widgetDescriptorSchema}
 * (the discriminated union + per-widget `.strict()` props), and returns the typed descriptor — or
 * `null` on ANY failure: oversized, non-JSON, non-object, unknown type, discriminator mismatch, an
 * out-of-bounds / bad-enum / bad-path prop, or an unknown key at either level. It NEVER throws: the
 * fail-closed contract the storefront RSC relies on to "render nothing, never block or 500 the page".
 */
export function parseWidget(raw: unknown): WidgetDescriptor | null {
  let candidate: unknown = raw;

  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > WIDGET_MAX_BYTES) return null;
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const result = widgetDescriptorSchema.safeParse(candidate);
  return result.success ? result.data : null;
}
