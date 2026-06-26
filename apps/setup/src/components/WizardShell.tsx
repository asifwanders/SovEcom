import React, { useEffect, useRef } from 'react';
import { StepRail, StepTopBar } from './StepRail';
import type { StepDef } from '@/wizard/steps';

export interface WizardShellProps {
  steps: readonly StepDef[];
  currentIndex: number;
  current: StepDef;
  children: React.ReactNode;
}

/**
 * The responsive wizard frame: the left step-rail on ≥768px (a slim
 * top progress bar on <768px) + a scrollable main panel that holds the step heading,
 * subtitle, content, and sticky footer.
 *
 * On every advance/back, focus moves to the step <h1> so keyboard and screen-reader
 * users land on the new step's title rather than being stranded on the old controls.
 */
export function WizardShell({ steps, currentIndex, current, children }: WizardShellProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Move focus to the heading whenever the step changes.
    headingRef.current?.focus();
  }, [currentIndex]);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <StepRail steps={steps} currentIndex={currentIndex} />

      <div className="flex min-w-0 flex-1 flex-col">
        <StepTopBar steps={steps} currentIndex={currentIndex} />

        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 py-8 md:px-10 md:py-12">
          <header className="mb-6">
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-[23px] font-bold leading-tight tracking-[-0.02em] outline-none"
            >
              {current.title}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{current.subtitle}</p>
          </header>

          {/* Each step renders its own content + StepFooter. The footer is sticky to the
              bottom of this scroll container. */}
          <div className="flex flex-1 flex-col">{children}</div>
        </main>
      </div>
    </div>
  );
}
