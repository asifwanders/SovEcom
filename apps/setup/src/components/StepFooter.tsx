import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from './ui/button';

export interface StepFooterProps {
  /** Show the Back button (hidden on Welcome/Done). */
  onBack?: () => void;
  /** Show the Skip button (optional steps only). */
  onSkip?: () => void;
  /** Primary action. Omit `onContinue` and pass `continueType="submit"` to submit a form. */
  onContinue?: () => void;
  continueType?: 'button' | 'submit';
  continueLabel?: string;
  /** Hide the trailing arrow (e.g. the Done step's "Finish setup"). */
  hideContinueArrow?: boolean;
  isLoading?: boolean;
  continueDisabled?: boolean;
}

/**
 * The sticky step footer: Back (ghost) · spacer · Skip (ghost, optional
 * steps) · Continue (teal primary). Layout is consistent across all 11 steps.
 */
export function StepFooter({
  onBack,
  onSkip,
  onContinue,
  continueType = 'button',
  continueLabel = 'Continue',
  hideContinueArrow,
  isLoading,
  continueDisabled,
}: StepFooterProps) {
  return (
    <div className="sticky bottom-0 mt-8 flex items-center gap-3 border-t border-border bg-background/95 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {onBack && (
        <Button type="button" variant="ghost" onClick={onBack} disabled={isLoading}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
      )}
      <div className="flex-1" />
      {onSkip && (
        <Button type="button" variant="ghost" onClick={onSkip} disabled={isLoading}>
          Skip
        </Button>
      )}
      <Button
        type={continueType}
        onClick={continueType === 'submit' ? undefined : onContinue}
        isLoading={isLoading}
        disabled={continueDisabled}
      >
        {continueLabel}
        {!hideContinueArrow && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
      </Button>
    </div>
  );
}
