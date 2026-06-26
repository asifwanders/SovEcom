import { Hammer } from 'lucide-react';
import { Card, CardContent } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import type { StepDef } from '@/wizard/steps';

export interface PlaceholderStepProps {
  step: StepDef;
}

/**
 * Honest placeholder for the 9 middle steps (Brand…Admin). CHUNK 1 ships the shell +
 * navigation end-to-end; chunks 2-4 replace these with the real forms. The full
 * Back / Skip / Continue footer is live so the step machine and rail can be exercised
 * (and tested) across the whole flow today.
 */
export function PlaceholderStep({ step }: PlaceholderStepProps) {
  const { machine } = useWizard();

  return (
    <div className="flex flex-1 flex-col">
      <Card>
        <CardContent className="flex items-start gap-3 pt-6">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Hammer className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium">The “{step.label}” step is coming next.</p>
            <p className="text-sm text-muted-foreground">
              This part of the wizard is being built. You can move forward and back to preview the
              flow.
            </p>
          </div>
        </CardContent>
      </Card>

      <StepFooter
        onBack={machine.canGoBack ? machine.back : undefined}
        onSkip={step.optional ? machine.skip : undefined}
        onContinue={() => machine.next()}
      />
    </div>
  );
}
