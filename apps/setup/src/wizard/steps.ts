/**
 * The ordered list of the 11 setup steps. The step machine is driven entirely by
 * this array — the rail, the "Step N of 11" counter, and nav all derive from it (no hardcoded
 * count or indices). `optional` steps render a Skip control; Welcome/Done suppress Back.
 *
 * The Modules step lists the platform's BUILT-IN modules (from GET /setup/v1/modules) so the
 * operator can install + enable them during onboarding. It is OPTIONAL — Skip installs nothing.
 */
export type StepId =
  | 'welcome'
  | 'brand'
  | 'database'
  | 'email'
  | 'payments'
  | 'tax'
  | 'compliance'
  | 'theme'
  | 'modules'
  | 'admin'
  | 'done';

export interface StepDef {
  id: StepId;
  /** Short label for the rail. */
  label: string;
  /** Step heading shown in the main panel (focus target on advance). */
  title: string;
  /** One-line subtitle under the heading. */
  subtitle: string;
  /** Optional steps get a Skip control and are not gated by required fields. */
  optional?: boolean;
}

export const STEPS: readonly StepDef[] = [
  {
    id: 'welcome',
    label: 'Welcome',
    title: 'Welcome to SovEcom',
    subtitle: 'Let’s get your store set up. This takes about ten minutes.',
  },
  {
    id: 'brand',
    label: 'Brand',
    title: 'Your brand',
    subtitle: 'Add your logo and choose your store colours.',
  },
  {
    id: 'database',
    label: 'Database',
    title: 'Database',
    subtitle: 'Where SovEcom stores your data.',
  },
  {
    id: 'email',
    label: 'Email',
    title: 'Email delivery',
    subtitle: 'How transactional emails reach your customers.',
  },
  {
    id: 'payments',
    label: 'Payments',
    title: 'Payments',
    subtitle: 'Choose how you’ll accept money.',
  },
  {
    id: 'tax',
    label: 'Tax',
    title: 'Tax',
    subtitle: 'We’ll set sensible defaults from your country.',
  },
  {
    id: 'compliance',
    label: 'Compliance',
    title: 'Privacy & compliance',
    subtitle: 'Cookie consent and analytics — privacy-first by default.',
  },
  {
    id: 'theme',
    label: 'Theme',
    title: 'Storefront theme',
    subtitle: 'Pick a starting look. You can change it later.',
  },
  {
    id: 'modules',
    label: 'Modules',
    title: 'Modules',
    subtitle: 'Optional add-ons. Install what you need now — or skip and add them later.',
    optional: true,
  },
  {
    id: 'admin',
    label: 'Admin account',
    title: 'Your admin account',
    subtitle: 'Create the account you’ll sign in with.',
  },
  {
    id: 'done',
    label: 'Done',
    title: 'You’re all set',
    subtitle: 'Review and finish — then head to your admin.',
  },
] as const;

export const TOTAL_STEPS = STEPS.length;

/**
 * Resolve a step's index from its id at runtime, so call sites stay reorder-safe (no
 * hardcoded indices that silently rot if STEPS is reordered). Every id in {@link StepId}
 * exists in {@link STEPS}, so this never returns -1 for a valid id.
 */
export function stepIndexById(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}
