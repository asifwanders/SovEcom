import { CircleCheck, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StepDef } from '@/wizard/steps';

export interface StepRailProps {
  steps: readonly StepDef[];
  currentIndex: number;
}

/**
 * The SovEcom brand mark (the white Headless-Node glyph from public/favicon.svg) on a
 * transparent ground — the teal tile is supplied by the wrapping `bg-primary` chip, so the
 * mark inherits the brand colour. Inlined (no extra asset request) and sized by the caller.
 */
function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <g stroke="currentColor" strokeWidth="5" strokeLinecap="round">
        <path d="M46 18 L32 32" />
        <path d="M32 32 L18 46" />
        <path d="M18 18 L32 32" strokeOpacity="0.55" />
        <path d="M46 46 L32 32" strokeOpacity="0.55" />
      </g>
      <circle cx="46" cy="18" r="5.5" fill="currentColor" />
      <circle cx="18" cy="46" r="5.5" fill="currentColor" />
      <circle cx="18" cy="18" r="4" fill="currentColor" fillOpacity="0.7" />
      <circle cx="46" cy="46" r="4" fill="currentColor" fillOpacity="0.7" />
      <circle cx="32" cy="32" r="9" fill="currentColor" />
    </svg>
  );
}

/**
 * The persistent left step-rail (≥768px) — SovEcom wordmark, the steps as a
 * vertical list (done = teal check, current = highlighted pill, upcoming = muted),
 * and a "Step N of N" counter + teal progress bar at the bottom.
 *
 * It's a real <nav> with an ordered list and `aria-current="step"` on the active
 * item so assistive tech announces progress.
 */
export function StepRail({ steps, currentIndex }: StepRailProps) {
  const total = steps.length;
  const humanStep = currentIndex + 1;
  const pct = Math.round((humanStep / total) * 100);

  return (
    <nav
      aria-label="Setup progress"
      className="hidden md:flex md:w-52 md:shrink-0 md:flex-col md:border-r md:border-border md:bg-card"
    >
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 px-5 py-6">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <BrandMark className="h-5 w-5" />
        </span>
        <span className="text-base font-bold tracking-tight">SovEcom</span>
      </div>

      {/* Steps */}
      <ol className="flex-1 space-y-0.5 px-3" role="list">
        {steps.map((step, index) => {
          const isDone = index < currentIndex;
          const isCurrent = index === currentIndex;
          return (
            <li key={step.id}>
              <div
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                  isCurrent &&
                    'border border-[#9FE1CB] bg-[#E1F5EE] font-medium text-[#04342C] dark:border-primary/40 dark:bg-primary/15 dark:text-foreground',
                  !isCurrent && isDone && 'text-foreground',
                  !isCurrent && !isDone && 'text-muted-foreground',
                )}
              >
                {isDone ? (
                  <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                ) : (
                  <Circle
                    className={cn(
                      'h-4 w-4 shrink-0',
                      isCurrent ? 'text-primary' : 'text-muted-foreground/60',
                    )}
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">{step.label}</span>
                {isDone && <span className="sr-only"> (completed)</span>}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Footer: counter + progress bar */}
      <div className="space-y-2 px-5 py-6">
        <p className="text-xs font-medium text-muted-foreground">
          Step {humanStep} of {total}
        </p>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={humanStep}
          aria-valuemin={1}
          aria-valuemax={total}
          aria-label={`Step ${humanStep} of ${total}`}
        >
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </nav>
  );
}

/**
 * Mobile counterpart: a slim top bar with the wordmark, a "Step N of N" label, and
 * the same teal progress bar. The rail collapses to this on <768px.
 */
export function StepTopBar({ steps, currentIndex }: StepRailProps) {
  const total = steps.length;
  const humanStep = currentIndex + 1;
  const pct = Math.round((humanStep / total) * 100);
  const current = steps[currentIndex];

  return (
    <nav
      aria-label="Setup progress"
      className="flex flex-col gap-2 border-b border-border bg-card px-4 py-3 md:hidden"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-primary text-primary-foreground">
            <BrandMark className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-bold tracking-tight">SovEcom</span>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          Step {humanStep} of {total}
          {current ? <span className="sr-only">: {current.label}</span> : null}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={humanStep}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-label={`Step ${humanStep} of ${total}`}
      >
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </nav>
  );
}
