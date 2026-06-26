import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Eye, EyeOff, Info, Mail, ShieldCheck, UserRound } from 'lucide-react';
import { Alert, Button, Card, CardContent, FormField, Input } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { stepIndexById } from '@/wizard/steps';
import { SetupApiError } from '@/lib/api';

/**
 * Step 10 — Admin account. THE security-adjacent step: a
 * two-phase email-OTP owner-credential flow.
 *
 * Request phase: {email, name} → POST /setup/v1/admin-account/start sends a 6-digit
 *     OTP. A 422 means email isn't configured yet → a clear "set up Email first" message
 *     with a Back-to-Email affordance. A 429 → a generic "too many attempts" wait message.
 *     Success advances to the verify phase.
 *
 * Verify phase: a 6-digit numeric OTP (auto-limited), a password + confirm (min 12,
 *     strength hint, show/hide), and a debounced "Resend code". {email, otp, password} →
 *     POST /setup/v1/admin-account/verify SETS the owner password. A wrong/expired OTP →
 *     uniform "invalid or expired code" (NEVER leaking whether the password was weak); a
 *     breached/weak password (422) → on the password field; a 429 → the wait message.
 *     Success advances to Done.
 *
 * Error states are deliberately non-leaky: the verify step shows the SAME message for a
 * wrong code regardless of password validity (the server enforces this too — no oracle).
 */

/** The Email step's index in the machine — for the "Back to Email" affordance on a 422.
 *  Resolved from the step ids (reorder-safe) rather than hardcoded. */
const EMAIL_STEP_INDEX = stepIndexById('email');
/** Min password length — mirrors the API DTO (AdminAccountVerifySchema, min 12). */
const MIN_PASSWORD = 12;
/** Resend debounce so a double-click / impatient operator can't spam the OTP send. */
const RESEND_COOLDOWN_MS = 2000;

const emailSchema = z.string().trim().email('Enter a valid email address.').max(320);

const startSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(255),
  email: emailSchema,
});
type StartValues = z.infer<typeof startSchema>;

const verifySchema = z
  .object({
    otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code we emailed you.'),
    password: z
      .string()
      .min(MIN_PASSWORD, `Your password must be 12 characters or more.`)
      .max(1024),
    confirmPassword: z.string(),
  })
  .superRefine((val, ctx) => {
    if (val.password !== val.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Those passwords don’t match.',
      });
    }
  });
type VerifyValues = z.infer<typeof verifySchema>;

type Phase = 'request' | 'verify';

export function AdminAccountStep() {
  const { api, machine } = useWizard();
  const [phase, setPhase] = useState<Phase>('request');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  return phase === 'request' ? (
    <RequestPhase
      onSent={(values) => {
        setEmail(values.email);
        setName(values.name);
        setPhase('verify');
      }}
      goToEmail={() => machine.goTo(EMAIL_STEP_INDEX)}
      onBack={machine.canGoBack ? machine.back : undefined}
      api={api}
    />
  ) : (
    <VerifyPhase
      email={email}
      name={name}
      api={api}
      onVerified={() => {
        machine.setStepData('admin', { email });
        machine.next();
      }}
      onBackToRequest={() => setPhase('request')}
    />
  );
}

// ─── Request the verification code ──────────────────────────────────────────────────

interface RequestPhaseProps {
  onSent: (values: StartValues) => void;
  goToEmail: () => void;
  onBack?: () => void;
  api: ReturnType<typeof useWizard>['api'];
}

function RequestPhase({ onSent, goToEmail, onBack, api }: RequestPhaseProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<StartValues>({
    resolver: zodResolver(startSchema),
    defaultValues: { name: '', email: '' },
  });

  const [formError, setFormError] = useState<string | null>(null);
  /** When true, render the "set up Email first" guidance + Back-to-Email button. */
  const [smtpMissing, setSmtpMissing] = useState(false);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setSmtpMissing(false);
    try {
      await api.post('/setup/v1/admin-account/start', {
        email: values.email.trim().toLowerCase(),
        name: values.name.trim(),
      });
      onSent({ email: values.email.trim().toLowerCase(), name: values.name.trim() });
    } catch (err) {
      handleAdminError(err, {
        onSmtpMissing: () => setSmtpMissing(true),
        onMessage: setFormError,
        fallback: 'Could not send the verification code. Please try again.',
      });
    }
  });

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-5">
        <Alert variant="default">
          <span className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            We’ll email you a one-time code to confirm this address, then you’ll set your password.
            This becomes the account you sign in with.
          </span>
        </Alert>

        <Card>
          <CardContent className="space-y-4 pt-6">
            <FormField label="Your name" required error={errors.name?.message}>
              {(field) => (
                <Input
                  {...field}
                  {...register('name')}
                  type="text"
                  autoComplete="name"
                  placeholder="Ada Lovelace"
                  error={Boolean(errors.name)}
                />
              )}
            </FormField>

            <FormField
              label="Email address"
              required
              error={errors.email?.message}
              hint="Where your verification code is sent — and your sign-in email."
            >
              {(field) => (
                <Input
                  {...field}
                  {...register('email')}
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  error={Boolean(errors.email)}
                />
              )}
            </FormField>
          </CardContent>
        </Card>

        {smtpMissing && (
          <Alert variant="warning">
            <div className="space-y-3">
              <p>
                <span className="font-medium">Set up email first.</span> We can’t send your
                verification code until email delivery is configured. Go back to the Email step,
                finish it, then return here.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={goToEmail}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to Email
              </Button>
            </div>
          </Alert>
        )}

        {formError && <Alert variant="destructive">{formError}</Alert>}
      </div>

      <StepFooter
        onBack={onBack}
        continueType="submit"
        continueLabel="Send verification code"
        hideContinueArrow
        isLoading={isSubmitting}
      />
    </form>
  );
}

// ─── Verify the code + set the password ───────────────────────────────────────────

interface VerifyPhaseProps {
  email: string;
  name: string;
  api: ReturnType<typeof useWizard>['api'];
  onVerified: () => void;
  onBackToRequest: () => void;
}

function VerifyPhase({ email, name, api, onVerified, onBackToRequest }: VerifyPhaseProps) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<VerifyValues>({
    resolver: zodResolver(verifySchema),
    defaultValues: { otp: '', password: '', confirmPassword: '' },
  });

  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const resendLockRef = useRef(false);

  const password = watch('password');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/setup/v1/admin-account/verify', {
        email,
        otp: values.otp,
        password: values.password,
      });
      onVerified();
    } catch (err) {
      if (err instanceof SetupApiError) {
        if (err.status === 429) {
          setFormError('Too many attempts. Please wait a moment and try again.');
          return;
        }
        if (err.status === 422) {
          // A weak/breached password — surface it ON the password field, not as a code
          // error (the OTP is still valid; the operator just needs a stronger password).
          setError('password', {
            message: 'That password is too weak — choose a stronger one.',
          });
          return;
        }
        // Everything else (a wrong/expired/used OTP → 401) is a UNIFORM, non-leaky
        // message. We never reveal whether the code or the password was the problem.
        setFormError('That code is invalid or expired. Check it, or resend a new one.');
        return;
      }
      setFormError('Could not create your account. Please try again.');
    }
  });

  const onResend = async () => {
    if (resendLockRef.current) return;
    resendLockRef.current = true;
    setResending(true);
    setResent(false);
    setFormError(null);
    try {
      await api.post('/setup/v1/admin-account/start', { email, name });
      setResent(true);
    } catch (err) {
      handleAdminError(err, {
        onSmtpMissing: () =>
          setFormError(
            'Email delivery is no longer configured. Go back and finish the Email step.',
          ),
        onMessage: setFormError,
        fallback: 'Could not resend the code. Please try again.',
      });
    } finally {
      setResending(false);
      // Debounce: re-enable after a short cooldown so a frantic operator can't spam sends.
      window.setTimeout(() => {
        resendLockRef.current = false;
      }, RESEND_COOLDOWN_MS);
    }
  };

  const strength = passwordStrength(password);

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-5">
        <Alert variant="default">
          <span className="flex items-start gap-2">
            <Mail className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              We sent a 6-digit code to <strong className="break-all">{email}</strong>. Enter it
              below and choose your password. The code expires in 10 minutes.
            </span>
          </span>
        </Alert>

        <Card>
          <CardContent className="space-y-5 pt-6">
            <FormField
              label="Verification code"
              required
              error={errors.otp?.message}
              hint="The 6-digit code from your email."
            >
              {(field) => (
                <Input
                  {...field}
                  {...register('otp')}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  error={Boolean(errors.otp)}
                  className="text-center font-mono text-2xl tracking-[0.4em]"
                  onChange={(e) => {
                    // Numeric-only, capped at 6 — keeps the input honest as you type.
                    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setValue('otp', digits, { shouldValidate: false });
                  }}
                />
              )}
            </FormField>

            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Didn’t get it?</span>
              <button
                type="button"
                onClick={onResend}
                disabled={resending}
                className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {resending ? 'Resending…' : 'Resend code'}
              </button>
              {resent && (
                <span role="status" className="text-success">
                  Sent — check your inbox.
                </span>
              )}
            </div>

            <hr className="border-border" />

            <FormField
              label="Password"
              required
              error={errors.password?.message}
              hint="At least 12 characters. A long passphrase beats a short complex one."
            >
              {(field) => (
                <div className="relative">
                  <Input
                    {...field}
                    {...register('password')}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="••••••••••••"
                    error={Boolean(errors.password)}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              )}
            </FormField>

            {password.length > 0 && <StrengthMeter strength={strength} />}

            <FormField label="Confirm password" required error={errors.confirmPassword?.message}>
              {(field) => (
                <Input
                  {...field}
                  {...register('confirmPassword')}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="••••••••••••"
                  error={Boolean(errors.confirmPassword)}
                />
              )}
            </FormField>
          </CardContent>
        </Card>

        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
          Wrong email?{' '}
          <button
            type="button"
            onClick={onBackToRequest}
            className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Change it
          </button>
        </p>

        {formError && <Alert variant="destructive">{formError}</Alert>}
      </div>

      <StepFooter
        onBack={onBackToRequest}
        continueType="submit"
        continueLabel="Create account"
        hideContinueArrow
        isLoading={isSubmitting}
      />
    </form>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────────

/**
 * Map a start/resend failure to the right inline state. A 422 here is always the
 * "configure SMTP first" precondition (the only 422 the start endpoint returns); a 429 is
 * the rate limit; everything else gets the supplied fallback.
 */
function handleAdminError(
  err: unknown,
  handlers: {
    onSmtpMissing: () => void;
    onMessage: (msg: string) => void;
    fallback: string;
  },
) {
  if (err instanceof SetupApiError) {
    if (err.status === 422) {
      handlers.onSmtpMissing();
      return;
    }
    if (err.status === 429) {
      handlers.onMessage('Too many attempts. Please wait a moment and try again.');
      return;
    }
    handlers.onMessage(err.message || handlers.fallback);
    return;
  }
  handlers.onMessage(handlers.fallback);
}

type Strength = { label: string; score: 0 | 1 | 2 | 3 };

/** A lightweight, non-authoritative strength hint (the server is the real arbiter). */
function passwordStrength(password: string): Strength {
  if (password.length < MIN_PASSWORD) return { label: 'Too short', score: 0 };
  let score = 1;
  if (password.length >= 16) score += 1;
  if (/[^A-Za-z0-9]/.test(password) || /\d/.test(password)) score += 1;
  const clamped = Math.min(score, 3) as 0 | 1 | 2 | 3;
  const label = clamped >= 3 ? 'Strong' : clamped === 2 ? 'Good' : 'Fair';
  return { label, score: clamped };
}

function StrengthMeter({ strength }: { strength: Strength }) {
  const colors = ['bg-destructive', 'bg-warning', 'bg-warning', 'bg-success'];
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={
              'h-1.5 flex-1 rounded-full ' +
              (i < strength.score ? colors[strength.score] : 'bg-muted')
            }
          />
        ))}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <UserRound className="h-3 w-3 shrink-0" aria-hidden="true" />
        Password strength: <span className="font-medium">{strength.label}</span>
      </p>
    </div>
  );
}
