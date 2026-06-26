import { useWizard } from '@/wizard/WizardContext';
import { WelcomeStep } from './WelcomeStep';
import { BrandStep } from './BrandStep';
import { DatabaseStep } from './DatabaseStep';
import { EmailStep } from './EmailStep';
import { PaymentsStep } from './PaymentsStep';
import { TaxStep } from './TaxStep';
import { ComplianceStep } from './ComplianceStep';
import { ThemeStep } from './ThemeStep';
import { ModulesStep } from './ModulesStep';
import { AdminAccountStep } from './AdminAccountStep';
import { DoneStep } from './DoneStep';
import { PlaceholderStep } from './PlaceholderStep';

/**
 * Routes the machine's current step to its component. Welcome + Done were wired in
 * CHUNK 1; CHUNK 2 wired the four configuration steps (Brand, Database, Email,
 * Payments); CHUNK 3 wires Tax, Compliance, Theme, and Modules; CHUNK 4 wires Admin (the
 * two-phase email-OTP step) and finishes the Done completion wiring. Keyed by step id so each step remounts
 * cleanly on change (fresh form state, and the focus-to-heading effect fires).
 */
export function StepRenderer() {
  const { machine } = useWizard();
  const step = machine.current;

  switch (step.id) {
    case 'welcome':
      return <WelcomeStep key={step.id} />;
    case 'brand':
      return <BrandStep key={step.id} />;
    case 'database':
      return <DatabaseStep key={step.id} />;
    case 'email':
      return <EmailStep key={step.id} />;
    case 'payments':
      return <PaymentsStep key={step.id} />;
    case 'tax':
      return <TaxStep key={step.id} />;
    case 'compliance':
      return <ComplianceStep key={step.id} />;
    case 'theme':
      return <ThemeStep key={step.id} />;
    case 'modules':
      return <ModulesStep key={step.id} />;
    case 'admin':
      return <AdminAccountStep key={step.id} />;
    case 'done':
      return <DoneStep key={step.id} />;
    default:
      return <PlaceholderStep key={step.id} step={step} />;
  }
}
