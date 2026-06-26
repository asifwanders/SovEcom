/**
 * Select primitive — bespoke token wrapper over `globals.css` CSS-vars,
 * NOT shadcn/Radix/cva (no new deps). Server-safe (RSC): a pure styling wrapper around the native
 * `<select>` (the native control is keyboard- and SR-accessible for free). The class string matches
 * the sort `<select>` the category page + LanguageSwitcher hand-roll, so the swap is a no-visual-change refactor.
 *
 * a11y: visible `--ring` focus, label association via forwarded `id` (callers bind a
 * `<label htmlFor>` / `aria-label`). All native props + `ref` are forwarded; `children` are the
 * `<option>`s.
 */
import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';

export const selectClasses = (className?: string): string =>
  [
    'h-9 rounded-md border border-input bg-transparent px-2 text-sm',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'disabled:cursor-not-allowed disabled:opacity-50',
    className,
  ]
    .filter(Boolean)
    .join(' ');

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/** A token-styled native `<select>`. Forwards `ref` + all native props; pass `<option>`s as children. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={selectClasses(className)} {...rest}>
      {children}
    </select>
  );
});
