import { useId } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input, Label } from '@/components/ui';

/**
 * Shared building blocks for the four configuration steps (Brand / Database / Email /
 * Payments). Kept tiny + composable: a labelled colour picker pairing a native swatch
 * with a hex text input, and an inline "test result" banner for test-connection /
 * send-test-email verdicts. Both are a11y-wired (labels, role=status/alert).
 */

export interface ColorFieldProps {
  label: string;
  /** Current hex value, e.g. `#00B9A0`. */
  value: string;
  onChange: (hex: string) => void;
  /** Inline validation error (invalid hex), shown under the field. */
  error?: string;
  disabled?: boolean;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A native colour swatch + a hex text input, kept in sync. Both edit the same value. */
export function ColorField({ label, value, onChange, error, disabled }: ColorFieldProps) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  // The native <input type=color> only accepts 6-digit hex; fall back so it never throws.
  const swatchValue = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour swatch`}
          value={swatchValue}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'h-10 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
        <Input
          id={id}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          error={Boolean(error)}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#00B9A0"
          className="font-mono"
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}

export interface TestResultBannerProps {
  /** `null` = nothing tested yet (renders nothing). */
  result: { ok: true } | { ok: false; message: string } | null;
  /** Message shown on success (e.g. "Connected" / "Sent — check your inbox"). */
  successMessage: string;
}

/**
 * Inline verdict for an async "test" action (test-connection / send-test-email). Success
 * is a teal status line; failure is a destructive alert. Never an alert() dialog.
 */
export function TestResultBanner({ result, successMessage }: TestResultBannerProps) {
  if (!result) return null;
  if (result.ok) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm font-medium text-success">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        {successMessage}
      </p>
    );
  }
  return (
    <p role="alert" className="flex items-start gap-2 text-sm font-medium text-destructive">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {result.message}
    </p>
  );
}
