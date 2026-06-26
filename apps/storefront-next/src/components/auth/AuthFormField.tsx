'use client';

/**
 * Accessible auth form field (auth/PII surface).
 *
 * A label + `<Input>` + inline error, wired for WCAG-AA (the strict axe E2E gate, 3.7 posture):
 *   - the `<label>` is tied to the input via `htmlFor`/`id`;
 *   - when invalid, `aria-invalid="true"` and the error text is associated via `aria-describedby`
 *     so a screen reader announces it on focus;
 *   - the error region is `role="alert"` for live announcement on validation;
 *   - native required/autocomplete/type are forwarded so password managers + the browser behave.
 *
 * SECURITY: this is a presentational wrapper only — it never persists the value anywhere; the parent
 * form keeps the value in React state and the password field uses `type="password"` (no echo, no log).
 */
import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { Input } from '@/components/ui/Input';

export interface AuthFormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Stable id for label/input/error association. */
  id: string;
  /** Visible label text. */
  label: string;
  /** Inline validation/error text, or null/undefined when valid. */
  error?: string | null;
}

export const AuthFormField = forwardRef<HTMLInputElement, AuthFormFieldProps>(
  function AuthFormField({ id, label, error, ...rest }, ref) {
    const errorId = `${id}-error`;
    const hasError = Boolean(error);
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {/* `rest` is spread FIRST so the error-association aria-* the component computes below can never
          be silently clobbered by a caller-supplied `aria-invalid`/`aria-describedby` — the error
          binding is a11y-load-bearing and must win. */}
        <Input
          id={id}
          ref={ref}
          {...rest}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? errorId : undefined}
        />
        {hasError ? (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
