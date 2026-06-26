import { useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Mail, Send, Info } from 'lucide-react';
import { Alert, Button, Card, CardContent, FormField, Input, Switch } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError, type ProbeResult } from '@/lib/api';
import { TestResultBanner } from './_shared';

/**
 * Step 4 — Email. A choice between Brevo (a single API key, mapped to its
 * SMTP relay) and a custom SMTP server. A "Send test email" probe (POST
 * /setup/v1/smtp/test → {ok|error}) confirms delivery before the Admin step (which sends
 * an OTP). Continue persists via POST /setup/v1/smtp/configure (host/port/secure/from
 * + optional auth).
 */

const BREVO_HOST = 'smtp-relay.brevo.com';
const BREVO_PORT = 587;

const emailSchema = z.string().trim().email('Enter a valid email address.').max(320);

const schema = z
  .object({
    provider: z.enum(['brevo', 'smtp']),
    // Brevo
    brevoKey: z.string().optional(),
    // Custom SMTP. `port` is a string from the <input type=number> (RHF gives strings);
    // it is parsed + range-checked in the refine and coerced in `toCreds`.
    host: z.string().optional(),
    port: z.string().optional(),
    secure: z.boolean(),
    user: z.string().optional(),
    pass: z.string().optional(),
    from: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const fromRes = emailSchema.safeParse(val.from ?? '');
    if (!fromRes.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'Enter the “from” address your store sends from.',
      });
    }
    if (val.provider === 'brevo') {
      if (!val.brevoKey || val.brevoKey.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['brevoKey'],
          message: 'Enter your Brevo API key.',
        });
      }
    } else {
      if (!val.host || val.host.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['host'],
          message: 'Enter your SMTP host.',
        });
      }
      const port = Number(val.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['port'],
          message: 'Enter a port between 1 and 65535.',
        });
      }
    }
  });
type FormValues = z.infer<typeof schema>;

/** Map the form values to the persisted SMTP credential blob the API expects. */
function toCreds(v: FormValues) {
  if (v.provider === 'brevo') {
    return {
      host: BREVO_HOST,
      port: BREVO_PORT,
      secure: false,
      user: (v.user ?? '').trim() || undefined,
      pass: (v.brevoKey ?? '').trim(),
      from: (v.from ?? '').trim(),
    };
  }
  return {
    host: (v.host ?? '').trim(),
    port: Number(v.port),
    secure: v.secure,
    user: (v.user ?? '').trim() || undefined,
    pass: (v.pass ?? '').trim() || undefined,
    from: (v.from ?? '').trim(),
  };
}

export function EmailStep() {
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
      provider: 'brevo',
      brevoKey: '',
      host: '',
      port: '587',
      secure: false,
      user: '',
      pass: '',
      from: '',
    },
  });

  const provider = watch('provider');
  const secure = watch('secure');

  const [testTo, setTestTo] = useState('');
  const [testToError, setTestToError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProbeResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const onTest = async () => {
    setFormError(null);
    setTestResult(null);
    setTestToError(null);

    const toRes = emailSchema.safeParse(testTo);
    if (!toRes.success) {
      setTestToError('Enter the address to send the test to.');
      return;
    }
    // The credentials must be filled enough to attempt a send.
    const values = getValues();
    const credsValid = await schema.safeParseAsync(values);
    if (!credsValid.success) {
      setTestResult({
        ok: false,
        error: 'Fill in your email settings above before sending a test.',
      });
      return;
    }

    setTesting(true);
    try {
      const result = await api.post<'/setup/v1/smtp/test', ProbeResult>('/setup/v1/smtp/test', {
        ...toCreds(values),
        to: toRes.data,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        error:
          err instanceof SetupApiError
            ? err.message
            : 'Could not send the test email. Check your settings and try again.',
      });
    } finally {
      setTesting(false);
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/setup/v1/smtp/configure', toCreds(values));
      machine.setStepData('email', { provider: values.provider });
      machine.next();
    } catch (err) {
      setFormError(
        err instanceof SetupApiError
          ? err.message
          : 'Could not save your email settings. Please try again.',
      );
    }
  });

  const testBanner =
    testResult === null
      ? null
      : testResult.ok
        ? ({ ok: true } as const)
        : ({ ok: false, message: testResult.error ?? 'Send failed.' } as const);

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-4">
        <Alert variant="default">
          <span className="flex items-center gap-2">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
            Email needs to work before the next steps — your admin account is verified by a one-time
            code sent here.
          </span>
        </Alert>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Email provider</legend>
          <ProviderTab
            selected={provider === 'brevo'}
            label="Brevo"
            description="One API key. Easiest."
            onSelect={() => setValue('provider', 'brevo')}
            inputProps={register('provider')}
            value="brevo"
            checked={provider === 'brevo'}
          />
          <ProviderTab
            selected={provider === 'smtp'}
            label="Custom SMTP"
            description="Your own mail server."
            onSelect={() => setValue('provider', 'smtp')}
            inputProps={register('provider')}
            value="smtp"
            checked={provider === 'smtp'}
          />
        </fieldset>

        <Card>
          <CardContent className="space-y-4 pt-6">
            {provider === 'brevo' ? (
              <FormField
                label="Brevo API key"
                required
                error={errors.brevoKey?.message}
                hint="Find this in Brevo → SMTP & API. Stored encrypted at rest."
              >
                {(field) => (
                  <Input
                    {...field}
                    {...register('brevoKey')}
                    type="password"
                    autoComplete="off"
                    placeholder="xkeysib-…"
                    error={Boolean(errors.brevoKey)}
                  />
                )}
              </FormField>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <FormField
                    label="Host"
                    required
                    error={errors.host?.message}
                    className="sm:col-span-2"
                  >
                    {(field) => (
                      <Input
                        {...field}
                        {...register('host')}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="smtp.example.com"
                        error={Boolean(errors.host)}
                      />
                    )}
                  </FormField>
                  <FormField label="Port" required error={errors.port?.message}>
                    {(field) => (
                      <Input
                        {...field}
                        {...register('port')}
                        type="number"
                        inputMode="numeric"
                        placeholder="587"
                        error={Boolean(errors.port)}
                      />
                    )}
                  </FormField>
                </div>

                <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                  <div className="space-y-0.5">
                    <span className="text-sm font-medium">Use TLS (secure)</span>
                    <p className="text-sm text-muted-foreground">
                      On for port 465; off (STARTTLS) for 587.
                    </p>
                  </div>
                  <Switch
                    checked={secure}
                    onCheckedChange={(v) => setValue('secure', v)}
                    aria-label="Use a secure TLS connection"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="Username" error={errors.user?.message}>
                    {(field) => (
                      <Input
                        {...field}
                        {...register('user')}
                        type="text"
                        autoComplete="off"
                        placeholder="optional"
                        error={Boolean(errors.user)}
                      />
                    )}
                  </FormField>
                  <FormField label="Password" error={errors.pass?.message}>
                    {(field) => (
                      <Input
                        {...field}
                        {...register('pass')}
                        type="password"
                        autoComplete="off"
                        placeholder="optional"
                        error={Boolean(errors.pass)}
                      />
                    )}
                  </FormField>
                </div>
              </>
            )}

            <FormField
              label="From address"
              required
              error={errors.from?.message}
              hint="The address customers see emails from."
            >
              {(field) => (
                <Input
                  {...field}
                  {...register('from')}
                  type="email"
                  autoComplete="off"
                  placeholder="store@example.com"
                  error={Boolean(errors.from)}
                />
              )}
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Send className="h-4 w-4 text-primary" aria-hidden="true" />
              Send a test email
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="flex-1">
                <label htmlFor="email-test-to" className="sr-only">
                  Test recipient address
                </label>
                <Input
                  id="email-test-to"
                  type="email"
                  autoComplete="off"
                  value={testTo}
                  onChange={(e) => {
                    setTestTo(e.target.value);
                    setTestToError(null);
                    setTestResult(null);
                  }}
                  placeholder="you@example.com"
                  error={Boolean(testToError)}
                  aria-invalid={testToError ? true : undefined}
                  aria-describedby={testToError ? 'email-test-to-error' : undefined}
                />
                {testToError && (
                  <p
                    id="email-test-to-error"
                    role="alert"
                    className="mt-1.5 text-sm font-medium text-destructive"
                  >
                    {testToError}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={onTest}
                isLoading={testing}
                className="shrink-0"
              >
                <Mail className="h-4 w-4" aria-hidden="true" />
                Send test
              </Button>
            </div>
            <TestResultBanner
              result={testBanner}
              successMessage="Sent — check your inbox (or Mailhog in dev)"
            />
          </CardContent>
        </Card>

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

interface ProviderTabProps {
  selected: boolean;
  label: string;
  description: string;
  onSelect: () => void;
  value: string;
  checked: boolean;
  inputProps: UseFormRegisterReturn;
}

function ProviderTab({
  selected,
  label,
  description,
  onSelect,
  value,
  checked,
  inputProps,
}: ProviderTabProps) {
  return (
    <label
      className={
        'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ' +
        'focus-within:ring-2 focus-within:ring-ring ' +
        (selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')
      }
    >
      <input
        type="radio"
        className="sr-only"
        value={value}
        checked={checked}
        {...inputProps}
        onChange={onSelect}
      />
      <span
        aria-hidden="true"
        className={
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ' +
          (selected ? 'border-primary' : 'border-input')
        }
      >
        {selected && <span className="h-2.5 w-2.5 rounded-full bg-primary" />}
      </span>
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}
