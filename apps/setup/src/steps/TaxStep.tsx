import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertTriangle, BadgeCheck, HelpCircle, Info, Receipt, ShieldCheck } from 'lucide-react';
import { Alert, Card, CardContent, FormField, Input, Select, Switch } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError } from '@/lib/api';
import {
  COUNTRIES,
  CURRENCIES,
  defaultCurrencyFor,
  findCountry,
  isEuCountry,
} from '@/lib/countries';

/**
 * Step 6 — Tax. The wizard's showcase: the
 * operator picks their **business country** and the step smart-defaults the tax regime —
 * an EU country flips on **EU VAT** (+ tax-inclusive pricing) and reveals the VAT-number
 * and OSS controls; a non-EU country defaults to **no tax**. Surfaced as a friendly inline
 * guidance banner.
 *
 * Choosing `none` for an EU country shows the plain-language **EU guardrail** warning
 * client-side (the server enforces the IDENTICAL rule and 422s — handled inline too).
 *
 * There is NO separate VIES endpoint: VIES runs INSIDE POST /setup/v1/tax/configure. So
 * "Validate" === Continue: on submit we POST the regime and reflect any `vatStatus` the
 * response carries (valid / invalid / unavailable — VIES fails open, never blocking setup).
 */

const VAT_RE = /^[A-Za-z]{2}[0-9A-Za-z+*.]{2,30}$/;

const schema = z
  .object({
    businessCountry: z.string().min(1, 'Choose the country your business is based in.'),
    defaultCurrency: z.string().min(1, 'Choose your store’s default currency.'),
    taxMode: z.enum(['eu_vat', 'none']),
    vatNumber: z.string().optional(),
    ossPosture: z.enum(['below_threshold', 'above_or_opted_in']),
    pricesIncludeTax: z.boolean(),
  })
  .superRefine((val, ctx) => {
    if (val.taxMode === 'eu_vat') {
      const vat = (val.vatNumber ?? '').trim();
      if (vat.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vatNumber'],
          message: 'Enter your EU VAT number — it’s required to charge VAT.',
        });
      } else if (!VAT_RE.test(vat)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vatNumber'],
          message: 'That doesn’t look like a VAT number (e.g. FR12345678901).',
        });
      }
    }
  });
type FormValues = z.infer<typeof schema>;

/** The VIES tri-state the configure response may carry; drives the inline VAT verdict. */
type VatStatus = 'valid' | 'invalid' | 'unavailable';

export function TaxStep() {
  const { api, machine } = useWizard();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      businessCountry: '',
      defaultCurrency: 'EUR',
      taxMode: 'none',
      vatNumber: '',
      ossPosture: 'below_threshold',
      pricesIncludeTax: false,
    },
  });

  const businessCountry = watch('businessCountry');
  const taxMode = watch('taxMode');
  const pricesIncludeTax = watch('pricesIncludeTax');
  const ossPosture = watch('ossPosture');

  const [formError, setFormError] = useState<string | null>(null);
  const [vatStatus, setVatStatus] = useState<VatStatus | null>(null);

  const countryIsEu = isEuCountry(businessCountry);
  const country = findCountry(businessCountry);
  // The guardrail the server enforces, mirrored client-side for instant feedback.
  const guardrailTripped = countryIsEu && taxMode === 'none';

  /**
   * Smart default: on country change, default the tax mode from EU membership
   * — EU → eu_vat (+ tax-inclusive pricing, the EU norm); non-EU → none. Also pre-fill the
   * country's currency. The operator can still override the mode afterwards.
   */
  const onCountryChange = (code: string) => {
    setValue('businessCountry', code, { shouldValidate: false });
    setValue('defaultCurrency', defaultCurrencyFor(code), { shouldValidate: false });
    const eu = isEuCountry(code);
    setValue('taxMode', eu ? 'eu_vat' : 'none', { shouldValidate: false });
    setValue('pricesIncludeTax', eu, { shouldValidate: false });
    setVatStatus(null);
    setFormError(null);
  };

  const setTaxMode = (mode: FormValues['taxMode']) => {
    setValue('taxMode', mode, { shouldValidate: false });
    setVatStatus(null);
    setFormError(null);
  };

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setVatStatus(null);

    const body: {
      businessCountry: string;
      defaultCurrency: string;
      taxMode: 'eu_vat' | 'none';
      vatNumber?: string;
      ossPosture?: 'below_threshold' | 'above_or_opted_in';
      pricesIncludeTax: boolean;
    } = {
      businessCountry: values.businessCountry,
      defaultCurrency: values.defaultCurrency,
      taxMode: values.taxMode,
      pricesIncludeTax: values.pricesIncludeTax,
    };
    if (values.taxMode === 'eu_vat') {
      body.vatNumber = (values.vatNumber ?? '').trim();
      body.ossPosture = values.ossPosture;
    }

    try {
      const res = await api.post<'/setup/v1/tax/configure', { ok: true; vatStatus?: VatStatus }>(
        '/setup/v1/tax/configure',
        body,
      );
      // Reflect the VIES verdict the configure response carries (fail-open: a verdict of
      // `unavailable` is informational, never a blocker — we still advance).
      if (res?.vatStatus) setVatStatus(res.vatStatus);
      machine.setStepData('tax', {
        businessCountry: values.businessCountry,
        defaultCurrency: values.defaultCurrency,
        taxMode: values.taxMode,
      });
      machine.next();
    } catch (err) {
      if (err instanceof SetupApiError) {
        // The 422 EU guardrail (and any field 422s) → inline, never an alert.
        setFormError(err.message);
        if (err.fieldErrors.vatNumber) {
          // surface a VAT-specific 422 near the field by mapping it onto the form error too.
          setFormError(err.fieldErrors.vatNumber);
        }
      } else {
        setFormError('Could not save your tax settings. Please try again.');
      }
    }
  });

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-5">
        {/* ── Business country ───────────────────────────────────────────────── */}
        <FormField
          label="Business country"
          required
          error={errors.businessCountry?.message}
          hint="Where your business is registered. We’ll set sensible tax defaults from this."
        >
          {(field) => (
            <Select
              {...field}
              {...register('businessCountry')}
              value={businessCountry}
              error={Boolean(errors.businessCountry)}
              onChange={(e) => onCountryChange(e.target.value)}
            >
              <option value="" disabled>
                Select a country…
              </option>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.flag} {c.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        {/* ── Smart-default guidance banner ───────────────────────── */}
        {country && countryIsEu && taxMode === 'eu_vat' && (
          <GuidanceBanner>
            <strong>{country.name} is in the EU</strong> — we’ve enabled EU VAT and tax-inclusive
            pricing for you. Add your VAT number below and we’ll verify it.
          </GuidanceBanner>
        )}
        {country && !countryIsEu && taxMode === 'none' && (
          <GuidanceBanner>
            <strong>{country.name} is outside the EU</strong> — no VAT is applied by default. You
            can configure tax rules later from the admin.
          </GuidanceBanner>
        )}

        {/* ── Default currency ───────────────────────────────────────────────── */}
        <FormField
          label="Default currency"
          required
          error={errors.defaultCurrency?.message}
          hint="Prices are stored in this currency. You can add more later."
        >
          {(field) => (
            <Select
              {...field}
              error={Boolean(errors.defaultCurrency)}
              {...register('defaultCurrency')}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        {/* ── Tax mode (overridable) ─────────────────────────────────────────── */}
        <fieldset className="space-y-2" disabled={!businessCountry}>
          <legend className="mb-1 text-sm font-medium">Tax mode</legend>
          <p className="text-sm text-muted-foreground">
            How SovEcom charges tax. We’ve picked the right default for your country — you can
            override it.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <ModeCard
              selected={taxMode === 'eu_vat'}
              icon={ShieldCheck}
              title="EU VAT"
              description="Charge and report VAT under EU rules (with OSS)."
              disabled={!businessCountry}
              onSelect={() => setTaxMode('eu_vat')}
            />
            <ModeCard
              selected={taxMode === 'none'}
              icon={Receipt}
              title="No tax"
              description="Don’t apply tax automatically. Configure it later."
              disabled={!businessCountry}
              onSelect={() => setTaxMode('none')}
            />
          </div>
        </fieldset>

        {/* ── EU guardrail warning (client-side mirror of the server 422) ────── */}
        {guardrailTripped && (
          <Alert variant="warning">
            <span className="font-medium">An EU business must charge VAT.</span>{' '}
            {country?.name ?? 'This country'} is in the EU, so disabling tax isn’t allowed — an
            EU&nbsp;VAT-registered merchant is legally required to charge VAT. Switch back to{' '}
            <strong>EU VAT</strong> to continue.
          </Alert>
        )}

        {/* ── eu_vat-only: VAT number + OSS + inclusive pricing ──────────────── */}
        {taxMode === 'eu_vat' && (
          <Card>
            <CardContent className="space-y-5 pt-6">
              <FormField
                label="EU VAT number"
                required
                error={errors.vatNumber?.message}
                hint="Including the country prefix, e.g. FR12345678901. We’ll check it against VIES when you continue."
              >
                {(field) => (
                  <Input
                    {...field}
                    {...register('vatNumber')}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="FR12345678901"
                    error={Boolean(errors.vatNumber)}
                    className="font-mono uppercase"
                    onChange={(e) => {
                      register('vatNumber').onChange(e);
                      setVatStatus(null);
                    }}
                  />
                )}
              </FormField>

              {vatStatus && <ViesBadge status={vatStatus} />}

              <FormField
                label="OSS posture"
                error={errors.ossPosture?.message}
                hint="One-Stop-Shop: are your cross-border EU B2C sales over the €10,000 threshold (or have you opted in)?"
              >
                {(field) => (
                  <Select
                    {...field}
                    value={ossPosture}
                    error={Boolean(errors.ossPosture)}
                    {...register('ossPosture')}
                  >
                    <option value="below_threshold">
                      Below the €10,000 threshold — charge home-country VAT
                    </option>
                    <option value="above_or_opted_in">
                      Above the threshold or opted in — charge destination VAT via OSS
                    </option>
                  </Select>
                )}
              </FormField>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
                <div className="space-y-0.5">
                  <span className="block text-sm font-medium">Prices include tax</span>
                  <span className="block text-sm text-muted-foreground">
                    Show VAT-inclusive prices (the EU norm for consumer storefronts).
                  </span>
                </div>
                <Switch
                  checked={pricesIncludeTax}
                  onCheckedChange={(v) =>
                    setValue('pricesIncludeTax', v, { shouldValidate: false })
                  }
                  aria-label="Prices include tax"
                />
              </div>
            </CardContent>
          </Card>
        )}

        {formError && <Alert variant="destructive">{formError}</Alert>}
      </div>

      <StepFooter
        onBack={machine.canGoBack ? machine.back : undefined}
        continueType="submit"
        continueLabel={taxMode === 'eu_vat' ? 'Validate & continue' : 'Continue'}
        isLoading={isSubmitting}
        continueDisabled={!businessCountry || guardrailTripped}
      />
    </form>
  );
}

/** The teal smart-default guidance banner. */
function GuidanceBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm text-foreground"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

interface ModeCardProps {
  selected: boolean;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  description: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** A tax-mode option rendered as a selectable card backed by a real radio (a11y). */
function ModeCard({ selected, icon: Icon, title, description, disabled, onSelect }: ModeCardProps) {
  return (
    <label
      className={
        'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ' +
        'focus-within:ring-2 focus-within:ring-ring ' +
        (disabled ? 'cursor-not-allowed opacity-60 ' : '') +
        (selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')
      }
    >
      <input
        type="radio"
        name="taxMode"
        className="sr-only"
        checked={selected}
        disabled={disabled}
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
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden={true} />
      </span>
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

/** Inline VIES verdict after configure. Valid = teal; invalid = destructive; outage = muted. */
function ViesBadge({ status }: { status: VatStatus }) {
  if (status === 'valid') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm font-medium text-success">
        <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
        VAT number verified with VIES.
      </p>
    );
  }
  if (status === 'invalid') {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        VIES couldn’t confirm this VAT number. Double-check it — you can still continue and fix it
        later in the admin.
      </p>
    );
  }
  return (
    <p role="status" className="flex items-start gap-2 text-sm text-muted-foreground">
      <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      VIES is temporarily unavailable, so we couldn’t verify your VAT number right now — we’ll
      re-check it later. Your setup isn’t blocked.
    </p>
  );
}
