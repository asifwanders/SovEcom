import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CreditCard, Landmark, Smartphone, Banknote, Lock } from 'lucide-react';
import { Alert, Card, CardContent, FormField, Input } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError } from '@/lib/api';

/**
 * Step 5 — Payments. A checklist of methods; checking "Stripe card" reveals
 * its key fields (secret / publishable / webhook secret — all password-type, encrypted at
 * rest). Continue posts the selected methods (+ optional Stripe blob) to
 * /setup/v1/payments/configure {methods, stripe?}. All optional — you can continue with
 * none selected and wire payments up later.
 */

const METHODS = [
  {
    id: 'stripe',
    label: 'Stripe (cards)',
    description: 'Visa, Mastercard, Amex…',
    icon: CreditCard,
  },
  { id: 'sepa', label: 'SEPA Direct Debit', description: 'EU bank transfers.', icon: Landmark },
  {
    id: 'wallets',
    label: 'Apple Pay / Google Pay',
    description: 'One-tap wallets (via Stripe).',
    icon: Smartphone,
  },
  {
    id: 'manual',
    label: 'Manual / offline',
    description: 'Bank transfer, cash on delivery.',
    icon: Banknote,
  },
] as const;

const schema = z
  .object({
    methods: z.array(z.string()),
    secretKey: z.string().optional(),
    publishableKey: z.string().optional(),
    webhookSecret: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.methods.includes('stripe')) {
      if (!val.secretKey || val.secretKey.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['secretKey'],
          message: 'Enter your Stripe secret key.',
        });
      }
      if (!val.publishableKey || val.publishableKey.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['publishableKey'],
          message: 'Enter your Stripe publishable key.',
        });
      }
    }
  });
type FormValues = z.infer<typeof schema>;

export function PaymentsStep() {
  const { api, machine } = useWizard();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      methods: [],
      secretKey: '',
      publishableKey: '',
      webhookSecret: '',
    },
  });

  const methods = watch('methods');
  const stripeEnabled = methods.includes('stripe');

  const [formError, setFormError] = useState<string | null>(null);

  const toggleMethod = (id: string, checked: boolean) => {
    const current = getValues('methods');
    const next = checked ? [...new Set([...current, id])] : current.filter((m) => m !== id);
    setValue('methods', next, { shouldValidate: false });
  };

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const body: {
      methods: string[];
      stripe?: { secretKey: string; publishableKey: string; webhookSecret?: string };
    } = { methods: values.methods };

    if (values.methods.includes('stripe')) {
      body.stripe = {
        secretKey: (values.secretKey ?? '').trim(),
        publishableKey: (values.publishableKey ?? '').trim(),
        webhookSecret: (values.webhookSecret ?? '').trim() || undefined,
      };
    }

    try {
      await api.post('/setup/v1/payments/configure', body);
      machine.setStepData('payments', { methods: values.methods });
      machine.next();
    } catch (err) {
      setFormError(
        err instanceof SetupApiError
          ? err.message
          : 'Could not save your payment settings. Please try again.',
      );
    }
  });

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Pick the ways you’ll accept money. You can add or change methods anytime from the admin —
          none are required to continue.
        </p>

        <fieldset className="space-y-3">
          <legend className="sr-only">Payment methods</legend>
          {METHODS.map(({ id, label, description, icon: Icon }) => {
            const checked = methods.includes(id);
            return (
              <label
                key={id}
                className={
                  'flex cursor-pointer items-center gap-3 rounded-lg border p-4 transition-colors ' +
                  'focus-within:ring-2 focus-within:ring-ring ' +
                  (checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')
                }
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => toggleMethod(id, e.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border-input text-primary focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-sm text-muted-foreground">{description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {stripeEnabled && (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Lock className="h-4 w-4 text-primary" aria-hidden="true" />
                Stripe keys
              </div>
              <p className="text-sm text-muted-foreground">
                Keys are encrypted at rest and never shown again. Find them in your Stripe dashboard
                → Developers → API keys.
              </p>

              <FormField label="Secret key" required error={errors.secretKey?.message}>
                {(field) => (
                  <Input
                    {...field}
                    {...register('secretKey')}
                    type="password"
                    autoComplete="off"
                    placeholder="sk_live_…"
                    error={Boolean(errors.secretKey)}
                  />
                )}
              </FormField>

              <FormField label="Publishable key" required error={errors.publishableKey?.message}>
                {(field) => (
                  <Input
                    {...field}
                    {...register('publishableKey')}
                    type="password"
                    autoComplete="off"
                    placeholder="pk_live_…"
                    error={Boolean(errors.publishableKey)}
                  />
                )}
              </FormField>

              <FormField
                label="Webhook signing secret"
                error={errors.webhookSecret?.message}
                hint="Optional now — needed for live order confirmations."
              >
                {(field) => (
                  <Input
                    {...field}
                    {...register('webhookSecret')}
                    type="password"
                    autoComplete="off"
                    placeholder="whsec_…"
                    error={Boolean(errors.webhookSecret)}
                  />
                )}
              </FormField>
            </CardContent>
          </Card>
        )}

        {formError && <Alert variant="destructive">{formError}</Alert>}
      </div>

      <StepFooter
        onBack={machine.canGoBack ? machine.back : undefined}
        continueType="submit"
        isLoading={isSubmitting}
      />
    </form>
  );
}
