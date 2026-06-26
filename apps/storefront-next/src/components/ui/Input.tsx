/**
 * Input primitive — bespoke token wrapper over `globals.css` CSS-vars,
 * NOT shadcn/Radix/cva (no new deps). Server-safe (RSC): no "use client", no state — a pure styling
 * wrapper around the native `<input>`. The class string is EXACTLY the search form's hand-rolled
 * input (`search/page.tsx`), so swapping the inline markup for `<Input>` is a no-visual-change move.
 *
 * a11y: visible `--ring` focus (`focus-visible:ring-2 focus-visible:ring-ring`),
 * label association via a forwarded `id` (callers bind a `<label htmlFor>` / `aria-label`), ≥44px
 * effective height (h-10). All native props + `ref` are forwarded.
 */
import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

export const inputClasses = (className?: string): string =>
  [
    'flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm',
    'placeholder:text-muted-foreground',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'disabled:cursor-not-allowed disabled:opacity-50',
    className,
  ]
    .filter(Boolean)
    .join(' ');

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** A token-styled text input. Forwards `ref` + all native props (incl. `id`, `name`, `aria-*`). */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = 'text', ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={inputClasses(className)} {...rest} />;
});
