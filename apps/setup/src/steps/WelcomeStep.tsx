import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { KeyRound, Database, CreditCard, ShieldCheck } from 'lucide-react';
import { Alert, Card, CardContent, FormField, Input } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError } from '@/lib/api';

const schema = z.object({
  token: z.string().trim().min(1, 'Enter your setup token to continue.'),
});
type FormValues = z.infer<typeof schema>;

const HIGHLIGHTS = [
  { icon: ShieldCheck, text: 'Privacy-first by default — no tracking, EU-ready' },
  { icon: Database, text: 'Connect your database and email' },
  { icon: CreditCard, text: 'Set up payments, tax, and your storefront' },
];

/**
 * Step 1 — Welcome. Explains what's about to happen and gates entry on
 * the setup token: on Continue we POST /setup/v1/verify-token (validate-only). An
 * invalid/expired token shows an inline error and does NOT advance; a valid token is
 * stored in sessionStorage (a short-lived secret) and the wizard advances. No Back.
 */
export function WelcomeStep() {
  const { api, machine, setToken } = useWizard();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { token: '' },
  });

  const onSubmit = handleSubmit(async ({ token }) => {
    setFormError(null);
    try {
      const result = await api.verifyToken(token);
      if (!result.valid) {
        setError('token', {
          message: 'That setup token is invalid or has expired. Copy a fresh one from the logs.',
        });
        return;
      }
      setToken(token);
      machine.next();
    } catch (err) {
      const message =
        err instanceof SetupApiError
          ? err.message
          : 'Could not verify the token. Please try again.';
      setFormError(message);
    }
  });

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-6">
        <p className="text-sm leading-relaxed text-muted-foreground">
          This short wizard configures your store end-to-end. Have your database and email details
          handy — you can change everything later from the admin.
        </p>

        <ul className="space-y-2.5" role="list">
          {HIGHLIGHTS.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3 text-sm">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              {text}
            </li>
          ))}
        </ul>

        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-primary" aria-hidden="true" />
              Enter your setup token
            </div>
            <p className="text-sm text-muted-foreground">
              For security, setup is locked to whoever has the token printed in the container logs.
              Look for a line like{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">Setup token: …</code> and paste
              it below.
            </p>

            <FormField label="Setup token" required error={errors.token?.message}>
              {(field) => (
                <Input
                  {...field}
                  {...register('token')}
                  type="text"
                  autoComplete="off"
                  autoFocus
                  spellCheck={false}
                  placeholder="paste your setup token"
                  error={Boolean(errors.token)}
                />
              )}
            </FormField>

            {formError && <Alert variant="destructive">{formError}</Alert>}
          </CardContent>
        </Card>
      </div>

      <StepFooter
        continueType="submit"
        continueLabel="Verify & continue"
        isLoading={isSubmitting}
      />
    </form>
  );
}
