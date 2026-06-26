import { WizardShell } from './WizardShell';
import { StepRenderer } from '@/steps/StepRenderer';
import { useWizard } from '@/wizard/WizardContext';

/**
 * The running wizard: the responsive shell (rail/top-bar + main + footer) wrapping the
 * current step. Lives inside <WizardProvider>, so it reads the machine from context.
 */
export function Wizard() {
  const { machine } = useWizard();
  return (
    <WizardShell
      steps={machine.steps}
      currentIndex={machine.currentIndex}
      current={machine.current}
    >
      <StepRenderer />
    </WizardShell>
  );
}
