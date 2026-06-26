import React from 'react';
import { cn } from '@/lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

/** Mirrors apps/admin Select — a native <select> on the shared tokens. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, error, children, 'aria-invalid': ariaInvalid, ...props }, ref) => {
    return (
      <select
        ref={ref}
        aria-invalid={ariaInvalid ?? (error ? true : undefined)}
        className={cn(
          'flex h-10 w-full rounded-md border bg-transparent px-3 py-2 text-sm',
          'focus-visible:outline-none focus-visible:ring-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          error
            ? 'border-destructive focus-visible:ring-destructive'
            : 'border-input focus-visible:ring-ring',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = 'Select';
