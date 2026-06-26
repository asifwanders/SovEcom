import React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

/**
 * Mirrors apps/admin Input. `error` flips the border/ring to destructive; the
 * inline message itself is rendered by FormField so the field stays composable.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, 'aria-invalid': ariaInvalid, ...props }, ref) => {
    return (
      <input
        ref={ref}
        aria-invalid={ariaInvalid ?? (error ? true : undefined)}
        className={cn(
          'flex h-10 w-full rounded-md border bg-transparent px-3 py-2 text-sm',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          error
            ? 'border-destructive focus-visible:ring-destructive'
            : 'border-input focus-visible:ring-ring',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
