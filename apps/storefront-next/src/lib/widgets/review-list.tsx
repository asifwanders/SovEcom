/**
 * C2 widget — `review-list`. READ-ONLY, server component (RSC).
 *
 * Renders the validated C1 review items. Every module-supplied string (`body`, `author`) reaches the
 * DOM only as React-escaped CHILDREN — an XSS-y body renders as inert text, never markup. No
 * `dangerouslySetInnerHTML`, no module URL, no HTML. `rating` is a C1-bounded 1–5 integer; `createdAt`
 * is a C1-validated ISO datetime string (rendered as text only — no Date parsing needed for display).
 */
import type { ReviewListProps } from '@sovecom/theme-sdk';

/** A bounded list of bounded review items (id/rating/body/author/createdAt). */
export function ReviewList({ items }: ReviewListProps) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-4" data-widget="review-list">
      {items.map((item) => {
        const filled = Math.max(1, Math.min(5, item.rating));
        const stars = '★★★★★'.slice(0, filled) + '☆☆☆☆☆'.slice(0, 5 - filled);
        return (
          <li key={item.id} className="border-b border-border pb-4 last:border-b-0">
            <div className="flex items-center gap-2 text-sm">
              <span aria-hidden="true" className="text-amber-500">
                {stars}
              </span>
              {item.author ? (
                <span className="font-medium text-foreground">{item.author}</span>
              ) : null}
              <time className="text-muted-foreground">{item.createdAt}</time>
            </div>
            <p className="mt-1 whitespace-pre-line text-sm text-foreground">{item.body}</p>
          </li>
        );
      })}
    </ul>
  );
}
