/**
 * C2 widget — `star-rating-summary`. READ-ONLY, server component (RSC).
 *
 * Renders ONLY its validated C1 props (`{ average, count }`) — both NUMBERS, so they reach the DOM
 * only as React-escaped text. No module string is interpolated as markup; no URL, no HTML. Average is
 * in [0,5], count is a non-negative integer (C1-bounded), so the star fill is safe to derive.
 */
import type { StarRatingSummaryProps } from '@sovecom/theme-sdk';

/** A 0–5 average rendered as filled/empty stars + the numeric average and review count. */
export function StarRatingSummary({ average, count }: StarRatingSummaryProps) {
  // Clamp defensively (C1 already bounds [0,5], but never trust a single layer for an index).
  const rounded = Math.max(0, Math.min(5, Math.round(average)));
  const stars = '★★★★★'.slice(0, rounded) + '☆☆☆☆☆'.slice(0, 5 - rounded);
  return (
    <div
      className="flex items-center gap-2 text-sm"
      data-widget="star-rating-summary"
      aria-label={`Average rating ${average} out of 5 from ${count} reviews`}
    >
      <span aria-hidden="true" className="text-amber-500">
        {stars}
      </span>
      <span className="text-foreground font-medium">{average.toFixed(1)}</span>
      <span className="text-muted-foreground">({count})</span>
    </div>
  );
}
