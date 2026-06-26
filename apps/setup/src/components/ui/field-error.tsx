import { cn } from '@/lib/utils';

export interface FieldErrorProps {
  id?: string;
  message?: string;
  className?: string;
}

/**
 * Inline per-field error text. Renders nothing when there is no message, so
 * callers can pass it unconditionally. `role="alert"` announces the error the
 * moment it appears; wire its `id` to the input's `aria-describedby`.
 */
export function FieldError({ id, message, className }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className={cn('text-sm font-medium text-destructive', className)}>
      {message}
    </p>
  );
}
