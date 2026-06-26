import { useState } from 'react';
import { Cookie, Lock, BarChart3, ShieldAlert } from 'lucide-react';
import { Alert, Card, CardContent, FormField, Input, Switch } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError } from '@/lib/api';

/**
 * Step 7 — Privacy & compliance. Privacy-first by default: cookie consent is
 * **locked on** (RGPD non-negotiable — the server hard-pins it regardless), Plausible
 * (privacy-friendly, no PII) is the default-on analytics, and Google Analytics + Meta Pixel
 * are opt-in toggles that surface an **RGPD warning** the moment they're enabled (they ship
 * data to non-EU processors).
 *
 * Continue → POST /setup/v1/compliance/configure { cookieConsent:true, analytics:{ … } }.
 * An id is only sent for GA/Meta when the toggle is on AND an id is supplied.
 */

export function ComplianceStep() {
  const { api, machine } = useWizard();

  const [plausible, setPlausible] = useState(true);
  const [plausibleDomain, setPlausibleDomain] = useState('');
  const [gaEnabled, setGaEnabled] = useState(false);
  const [gaId, setGaId] = useState('');
  const [metaEnabled, setMetaEnabled] = useState(false);
  const [metaId, setMetaId] = useState('');

  const [gaError, setGaError] = useState<string | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setGaError(null);
    setMetaError(null);

    // Validate the ids only when their toggle is on.
    let valid = true;
    if (gaEnabled && gaId.trim().length === 0) {
      setGaError('Enter your Google Analytics measurement ID (e.g. G-XXXXXXX).');
      valid = false;
    }
    if (metaEnabled && metaId.trim().length === 0) {
      setMetaError('Enter your Meta Pixel ID.');
      valid = false;
    }
    if (!valid) return;

    const analytics: {
      plausible: boolean;
      plausibleDomain?: string;
      ga?: { id: string };
      meta?: { pixelId: string };
    } = { plausible };
    // Plausible needs a domain to actually run; it's optional here (configure it later in admin).
    if (plausible && plausibleDomain.trim().length > 0) {
      analytics.plausibleDomain = plausibleDomain.trim();
    }
    if (gaEnabled) analytics.ga = { id: gaId.trim() };
    if (metaEnabled) analytics.meta = { pixelId: metaId.trim() };

    setSubmitting(true);
    try {
      await api.post('/setup/v1/compliance/configure', {
        cookieConsent: true,
        analytics,
      });
      machine.setStepData('compliance', {
        plausible,
        ga: gaEnabled,
        meta: metaEnabled,
      });
      machine.next();
    } catch (err) {
      setFormError(
        err instanceof SetupApiError
          ? err.message
          : 'Could not save your compliance settings. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-5">
        {/* ── Cookie consent — locked on ─────────────────────────────────────── */}
        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Cookie className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="space-y-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    Cookie consent banner
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      <Lock className="h-3 w-3" aria-hidden="true" />
                      Required
                    </span>
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Always on — RGPD requires consent before any non-essential cookies. This can’t
                    be turned off.
                  </span>
                </div>
              </div>
              <Switch
                checked
                disabled
                onCheckedChange={() => {}}
                aria-label="Cookie consent (required, always on)"
              />
            </div>
          </CardContent>
        </Card>

        {/* ── Analytics ──────────────────────────────────────────────────────── */}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Analytics</legend>
          <p className="text-sm text-muted-foreground">
            Plausible is privacy-friendly and on by default. Google Analytics and Meta Pixel are off
            — turn them on only if you accept their RGPD implications.
          </p>

          {/* Plausible — default on, privacy-friendly */}
          <AnalyticsRow
            icon={BarChart3}
            title="Plausible Analytics"
            description="Cookieless, no personal data, EU-hosted. The privacy-friendly default."
            checked={plausible}
            onCheckedChange={setPlausible}
            switchLabel="Plausible Analytics"
          >
            {plausible && (
              <div className="mt-3">
                <FormField label="Site domain (optional)">
                  {(field) => (
                    <Input
                      {...field}
                      value={plausibleDomain}
                      onChange={(e) => setPlausibleDomain(e.target.value)}
                      type="text"
                      autoComplete="off"
                      placeholder="shop.example.com"
                      className="font-mono"
                    />
                  )}
                </FormField>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The domain registered in your Plausible account. Leave blank to set it up later in
                  admin — Plausible only starts collecting once a domain is set.
                </p>
              </div>
            )}
          </AnalyticsRow>

          {/* Google Analytics — opt-in + RGPD warning */}
          <AnalyticsRow
            icon={BarChart3}
            title="Google Analytics"
            description="Tracks visitors via Google. Off unless you provide a measurement ID."
            checked={gaEnabled}
            onCheckedChange={(v) => {
              setGaEnabled(v);
              if (!v) setGaError(null);
            }}
            switchLabel="Google Analytics"
          >
            {gaEnabled && (
              <div className="mt-3 space-y-3">
                <RgpdWarning>
                  Google Analytics sends visitor data to Google (a non-EU processor). You’re
                  responsible for a lawful basis, a data-processing agreement, and disclosing it in
                  your privacy policy.
                </RgpdWarning>
                <FormField label="Measurement ID" required error={gaError ?? undefined}>
                  {(field) => (
                    <Input
                      {...field}
                      value={gaId}
                      onChange={(e) => {
                        setGaId(e.target.value);
                        setGaError(null);
                      }}
                      type="text"
                      autoComplete="off"
                      placeholder="G-XXXXXXXXXX"
                      error={Boolean(gaError)}
                      className="font-mono"
                    />
                  )}
                </FormField>
              </div>
            )}
          </AnalyticsRow>

          {/* Meta Pixel — opt-in + RGPD warning */}
          <AnalyticsRow
            icon={BarChart3}
            title="Meta Pixel"
            description="Tracks visitors for Meta (Facebook/Instagram) ads. Off by default."
            checked={metaEnabled}
            onCheckedChange={(v) => {
              setMetaEnabled(v);
              if (!v) setMetaError(null);
            }}
            switchLabel="Meta Pixel"
          >
            {metaEnabled && (
              <div className="mt-3 space-y-3">
                <RgpdWarning>
                  The Meta Pixel sends visitor data to Meta (a non-EU processor) for ad targeting.
                  You’re responsible for a lawful basis, a DPA, and disclosing it in your privacy
                  policy.
                </RgpdWarning>
                <FormField label="Pixel ID" required error={metaError ?? undefined}>
                  {(field) => (
                    <Input
                      {...field}
                      value={metaId}
                      onChange={(e) => {
                        setMetaId(e.target.value);
                        setMetaError(null);
                      }}
                      type="text"
                      autoComplete="off"
                      placeholder="1234567890"
                      error={Boolean(metaError)}
                      className="font-mono"
                    />
                  )}
                </FormField>
              </div>
            )}
          </AnalyticsRow>
        </fieldset>

        {formError && <Alert variant="destructive">{formError}</Alert>}
      </div>

      <StepFooter
        onBack={machine.canGoBack ? machine.back : undefined}
        continueType="submit"
        isLoading={submitting}
      />
    </form>
  );
}

interface AnalyticsRowProps {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  switchLabel: string;
  children?: React.ReactNode;
}

/** One analytics provider: a labelled toggle row with optional revealed id/warning. */
function AnalyticsRow({
  icon: Icon,
  title,
  description,
  checked,
  onCheckedChange,
  switchLabel,
  children,
}: AnalyticsRowProps) {
  return (
    <div
      className={
        'rounded-lg border p-4 transition-colors ' +
        (checked ? 'border-primary/40 bg-primary/5' : 'border-border')
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" aria-hidden={true} />
          </span>
          <div className="space-y-0.5">
            <span className="block text-sm font-medium">{title}</span>
            <span className="block text-sm text-muted-foreground">{description}</span>
          </div>
        </div>
        <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={switchLabel} />
      </div>
      {children}
    </div>
  );
}

/** An inline RGPD warning shown when a non-privacy-friendly tracker is enabled. */
function RgpdWarning({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm text-warning"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-medium">RGPD warning. </span>
        {children}
      </p>
    </div>
  );
}
