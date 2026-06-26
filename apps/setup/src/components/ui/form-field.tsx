import React, { useId } from 'react';
import { cn } from '@/lib/utils';
import { Label } from './label';
import { FieldError } from './field-error';

export interface FormFieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  className?: string;
  /**
   * Render-prop receiving the wiring a labelled, described, validity-flagged
   * control needs: `id` (matches the <label htmlFor>), `aria-describedby`
   * (points at the hint and/or error), and `aria-invalid`.
   */
  children: (controlProps: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
  }) => React.ReactNode;
}

/**
 * Composable labelled form row: a <label> always tied to its control, an optional
 * hint, and an inline error. Keeps every input keyboard- and screen-reader-friendly
 * without each step re-wiring the aria plumbing.
 */
export function FormField({
  label,
  htmlFor,
  required,
  error,
  hint,
  className,
  children,
}: FormFieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      <FieldError id={errorId} message={error} />
    </div>
  );
}
