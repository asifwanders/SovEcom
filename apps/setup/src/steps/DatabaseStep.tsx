import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Database, Cloud } from 'lucide-react';
import { Alert, Button, Card, CardContent, FormField, Input } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError, type ProbeResult } from '@/lib/api';
import { TestResultBanner } from './_shared';

/**
 * Step 3 — Database. A choice between the bundled Postgres (recommended,
 * no input) and an external database URL (Neon/Supabase/RDS). External offers a
 * "Test connection" probe (POST /setup/v1/database/test → {ok|error}); the URL is
 * required only for external. Continue posts the deployment choice to
 * /setup/v1/database/configure {mode, url?}.
 */

const urlSchema = z
  .string()
  .trim()
  .min(1, 'Enter your database connection URL.')
  .max(2048, 'That URL is too long.')
  .refine((v) => /^postgres(ql)?:\/\//i.test(v), {
    message: 'Must be a postgres:// or postgresql:// URL.',
  });

const schema = z
  .object({
    mode: z.enum(['bare_metal', 'external']),
    url: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'external') {
      const res = urlSchema.safeParse(val.url ?? '');
      if (!res.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: res.error.issues[0]?.message ?? 'Enter a valid database URL.',
        });
      }
    }
  });
type FormValues = z.infer<typeof schema>;

export function DatabaseStep() {
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
    defaultValues: { mode: 'bare_metal', url: '' },
  });

  const mode = watch('mode');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProbeResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const onTest = async () => {
    setFormError(null);
    setTestResult(null);
    const url = (getValues('url') ?? '').trim();
    const parsed = urlSchema.safeParse(url);
    if (!parsed.success) {
      setTestResult({ ok: false, error: parsed.error.issues[0]?.message });
      return;
    }
    setTesting(true);
    try {
      const result = await api.post<'/setup/v1/database/test', ProbeResult>(
        '/setup/v1/database/test',
        { url },
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        error:
          err instanceof SetupApiError
            ? err.message
            : 'Could not reach that database. Check the URL and try again.',
      });
    } finally {
      setTesting(false);
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const body =
      values.mode === 'external'
        ? { mode: 'external' as const, url: (values.url ?? '').trim() }
        : { mode: 'bare_metal' as const };
    try {
      await api.post('/setup/v1/database/configure', body);
      machine.setStepData('database', { mode: values.mode });
      machine.next();
    } catch (err) {
      setFormError(
        err instanceof SetupApiError
          ? err.message
          : 'Could not save your database choice. Please try again.',
      );
    }
  });

  const testBanner =
    testResult === null
      ? null
      : testResult.ok
        ? ({ ok: true } as const)
        : ({ ok: false, message: testResult.error ?? 'Connection failed.' } as const);

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-4">
        <fieldset className="space-y-3">
          <legend className="sr-only">Database deployment</legend>

          <OptionCard
            selected={mode === 'bare_metal'}
            icon={Database}
            title="Bundled Postgres"
            badge="Recommended"
            description="Use the Postgres that ships with SovEcom. Nothing to configure."
          >
            <input
              type="radio"
              value="bare_metal"
              className="sr-only"
              {...register('mode')}
              onChange={() => {
                setValue('mode', 'bare_metal', { shouldValidate: false });
                setTestResult(null);
              }}
              checked={mode === 'bare_metal'}
            />
          </OptionCard>

          <OptionCard
            selected={mode === 'external'}
            icon={Cloud}
            title="External database"
            description="Connect a managed Postgres (Neon, Supabase, RDS…)."
          >
            <input
              type="radio"
              value="external"
              className="sr-only"
              {...register('mode')}
              onChange={() => {
                setValue('mode', 'external', { shouldValidate: false });
                setTestResult(null);
              }}
              checked={mode === 'external'}
            />
          </OptionCard>
        </fieldset>

        {mode === 'external' && (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <FormField
                label="Connection URL"
                required
                error={errors.url?.message}
                hint="We never store your password in plain text."
              >
                {(field) => (
                  <Input
                    {...field}
                    {...register('url')}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="postgresql://user:pass@host:5432/dbname"
                    error={Boolean(errors.url)}
                    className="font-mono"
                    onChange={(e) => {
                      register('url').onChange(e);
                      setTestResult(null);
                    }}
                  />
                )}
              </FormField>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onTest}
                  isLoading={testing}
                >
                  Test connection
                </Button>
                <TestResultBanner result={testBanner} successMessage="Connected" />
              </div>
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

interface OptionCardProps {
  selected: boolean;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
}

/** A radio rendered as a selectable card (the hidden <input> is the children). */
function OptionCard({
  selected,
  icon: Icon,
  title,
  description,
  badge,
  children,
}: OptionCardProps) {
  return (
    <label
      className={
        'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ' +
        'focus-within:ring-2 focus-within:ring-ring ' +
        (selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')
      }
    >
      {children}
      <span
        aria-hidden="true"
        className={
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ' +
          (selected ? 'border-primary' : 'border-input')
        }
      >
        {selected && <span className="h-2.5 w-2.5 rounded-full bg-primary" />}
      </span>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden={true} />
      </span>
      <span className="space-y-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {badge}
            </span>
          )}
        </span>
        <span className="block text-sm text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}
