/**
 * Badge primitive — bespoke token wrapper over `globals.css` CSS-vars,
 * NOT shadcn/Radix/cva (no new deps). Server-safe (RSC): a pure presentational `<span>`. Used for
 * availability / status pills (e.g. PDP in-stock / out-of-stock).
 *
 * a11y: colour is NEVER the sole signal — the badge always carries a text label, so
 * the in-stock/out-of-stock state reads correctly without colour perception. Semantic token colours
 * (`--success`/`--destructive`/`--muted`) only reinforce the label.
 *
 * The `availability` variant reproduces the PDP's existing inline colour-text rendering EXACTLY
 * (`text-xs` + `text-success`/`text-destructive`, no border/background) so swapping it in is a
 * no-visual-change refactor; `solid`/`outline` are pill variants available for later chunks.
 */
import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeVariant = 'availability' | 'solid' | 'outline';
export type BadgeTone = 'success' | 'destructive' | 'muted' | 'primary';

/** Tone → text colour token (used by the inline `availability` variant). */
const TONE_TEXT: Record<BadgeTone, string> = {
  success: 'text-success',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
  primary: 'text-primary',
};

/** Tone → solid pill background + foreground token. */
const TONE_SOLID: Record<BadgeTone, string> = {
  success: 'bg-success text-success-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
  muted: 'bg-muted text-muted-foreground',
  primary: 'bg-primary text-primary-foreground',
};

const PILL_BASE = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium';

export function badgeClasses(variant: BadgeVariant, tone: BadgeTone, className?: string): string {
  if (variant === 'availability') {
    // Inline colour-text only — matches the PDP's existing `ms-2 text-xs text-success/destructive`.
    return ['text-xs', TONE_TEXT[tone], className].filter(Boolean).join(' ');
  }
  if (variant === 'outline') {
    return [PILL_BASE, 'border border-border', TONE_TEXT[tone], className]
      .filter(Boolean)
      .join(' ');
  }
  return [PILL_BASE, TONE_SOLID[tone], className].filter(Boolean).join(' ');
}

export type BadgeProps = {
  variant?: BadgeVariant;
  tone?: BadgeTone;
  children: ReactNode;
} & HTMLAttributes<HTMLSpanElement>;

/** A token-styled status badge. Always renders its text `children` so colour is never the sole signal. */
export function Badge({
  variant = 'solid',
  tone = 'muted',
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span className={badgeClasses(variant, tone, className)} {...rest}>
      {children}
    </span>
  );
}
