/**
 * C2 widget — `product-carousel`. READ-ONLY, server component (RSC).
 *
 * Renders the validated C1 product cards. `title` reaches the DOM as React-escaped text; `imageUrl` is
 * rendered as an `<img src>` ONLY after a http(s)-scheme check ({@link safeImageUrl}) — a `javascript:`/
 * `data:`/protocol-relative URL is DROPPED (no img). No HTML, no `dangerouslySetInnerHTML`, no module URL
 * used as a src without the scheme gate. A plain `<a>` (not the intl `Link`) keeps this fragment free of
 * next-intl server context — the href is a simple relative path the browser resolves under the locale.
 *
 * The `slug` builds a `/product/<slug>` href, `encodeURIComponent`-encoded into a SINGLE inert path
 * segment (defense in depth — C1 already bars `/`/`\`/`..` traversal in the slug). So even a malicious
 * `slug` can never add path segments or traverse to another route (a within-origin redirect): it stays a
 * literal, percent-encoded segment under `/product/`.
 */
import type { ProductCarouselProps } from '@sovecom/theme-sdk';
import { safeImageUrl } from './safeUrl';

/** An optional heading + a horizontally-scrollable strip of bounded product cards. */
export function ProductCarousel({ heading, items }: ProductCarouselProps) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" data-widget="product-carousel">
      {heading ? <h2 className="text-lg font-semibold text-foreground">{heading}</h2> : null}
      <ul className="flex gap-4 overflow-x-auto pb-2">
        {items.map((item) => {
          const src = safeImageUrl(item.imageUrl);
          return (
            <li key={item.productId} className="w-40 shrink-0">
              <a
                href={`/product/${encodeURIComponent(item.slug)}`}
                className="group block rounded-lg border border-border bg-card overflow-hidden hover:shadow-md transition-shadow"
              >
                <div className="aspect-square bg-muted">
                  {src ? (
                    <img
                      src={src}
                      alt={item.title}
                      width={160}
                      height={160}
                      className="h-full w-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : null}
                </div>
                <p className="p-2 text-sm font-medium text-foreground line-clamp-2">{item.title}</p>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
