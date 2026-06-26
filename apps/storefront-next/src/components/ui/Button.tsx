/**
 * Button primitive — a bespoke, presentational thin wrapper over the
 * existing `globals.css` CSS-var tokens + Tailwind aliases. NOT shadcn/Radix/cva, NOT a headless a11y lib.
 * Server-safe (RSC): no "use client", no hooks, no event state — it
 * just maps `variant`/`size` to the exact token classes the routes already hand-roll, so extracting
 * inline buttons into it is a no-visual-change refactor.
 *
 * Renders a native `<button>` by default, or an `<a>` when `asChild`-style `href` is NOT used — here
 * polymorphism is kept minimal: pass `as="a"` (with an `href`) to render an anchor (e.g. a CTA link)
 * while sharing the same token styling. Native props are forwarded (incl. `ref`, `disabled`, `type`,
 * `aria-*`) so it composes with `next-intl`'s `Link` via `className` when a routed link is needed.
 *
 * a11y: visible `--ring` focus via `focus-visible:ring-2 focus-visible:ring-ring`,
 * ~40px (h-10) touch target at md/lg, color never the sole signal (the label text carries meaning).
 */
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, AnchorHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Token classes per variant — these are the EXACT strings the routes hand-rolled (no redesign). */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary: 'border border-input bg-transparent hover:bg-muted',
  ghost: 'bg-transparent hover:bg-muted',
};

/**
 * Size → height + inline padding. These map to the EXACT sizes the routes hand-roll (no redesign):
 *   sm  = h-9 px-3  (category sort "Apply")
 *   md  = h-10 px-4 (search submit)
 *   lg  = h-10 px-6 (home hero CTA, "Load more", pagination prev/next)
 * `lg` keeps h-10 (the shipped height) rather than growing it — visual parity over a taller target.
 */
const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3',
  md: 'h-10 px-4',
  lg: 'h-10 px-6',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'disabled:pointer-events-none disabled:opacity-50';

/** Compose the token class list for a given variant/size + caller `className`. */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return [BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className]
    .filter(Boolean)
    .join(' ');
}

type ButtonAsButton = { as?: 'button' } & ButtonHTMLAttributes<HTMLButtonElement>;
type ButtonAsAnchor = { as: 'a' } & AnchorHTMLAttributes<HTMLAnchorElement>;

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
} & (ButtonAsButton | ButtonAsAnchor);

/**
 * A token-styled button. Renders `<button type="button">` by default; `as="a"` renders an `<a>`
 * with the same styling (for CTAs). All native props are forwarded; `ref` targets the rendered tag.
 */
export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function Button({ variant = 'primary', size = 'md', className, as = 'button', ...rest }, ref) {
    const classes = buttonClasses(variant, size, className);
    if (as === 'a') {
      const anchorProps = rest as AnchorHTMLAttributes<HTMLAnchorElement>;
      return <a ref={ref as React.Ref<HTMLAnchorElement>} className={classes} {...anchorProps} />;
    }
    const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        type={buttonProps.type ?? 'button'}
        className={classes}
        {...buttonProps}
      />
    );
  },
);
