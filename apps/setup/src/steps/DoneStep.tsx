import { useState } from 'react';
import { PartyPopper, Check, ArrowLeft } from 'lucide-react';
import { Alert, Button, Card, CardContent } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { stepIndexById, type StepId } from '@/wizard/steps';
import { SetupApiError } from '@/lib/api';
import { findCountry } from '@/lib/countries';

/**
 * Step 11 — Done. A concise summary built from the data the wizard
 * collected across the previous steps (brand, database, tax regime, admin email) + a
 * primary "Finish setup" that calls POST /setup/v1/complete (consume token + flip
 * installed). On success — or a post-install 404, which the client also maps to installed
 * — we clear the token (sessionStorage) and progress (localStorage), then redirect to
 * /admin. No Back / Skip in the footer.
 *
 * A 422 means a precondition is still missing (admin/tax). We translate the server's
 * `missing[]` codes into plain language and offer a way back to the relevant step rather
 * than dead-ending the operator.
 */

/**
 * Map a `missing` precondition code → a friendly label + the step it lives on (by id, so
 * the "Fix this" jump stays reorder-safe — the index is resolved from STEPS at render).
 */
const MISSING_LABELS: Record<string, { label: string; stepId: StepId }> = {
  admin_account: { label: 'Create your admin account', stepId: 'admin' },
  tax_configuration: { label: 'Choose your tax settings', stepId: 'tax' },
  valid_setup_token: {
    label: 'Your setup token expired — re-enter it on Welcome',
    stepId: 'welcome',
  },
};

interface SummaryRow {
  label: string;
  value: string;
}

/** Build the human summary from the per-step data the machine accumulated. */
function buildSummary(data: Record<string, unknown>): SummaryRow[] {
  const rows: SummaryRow[] = [];

  const brand = data.brand as { primary?: string } | undefined;
  if (brand?.primary) {
    rows.push({ label: 'Brand colour', value: brand.primary.toUpperCase() });
  }

  const database = data.database as { mode?: string } | undefined;
  if (database?.mode) {
    rows.push({
      label: 'Database',
      value: database.mode === 'external' ? 'External Postgres' : 'Bundled Postgres',
    });
  }

  const tax = data.tax as
    | { businessCountry?: string; defaultCurrency?: string; taxMode?: string }
    | undefined;
  if (tax?.businessCountry) {
    const country = findCountry(tax.businessCountry);
    const regime = tax.taxMode === 'eu_vat' ? 'EU VAT' : 'No automatic tax';
    rows.push({
      label: 'Tax',
      value: `${regime}${country ? ` · ${country.name}` : ''}`,
    });
  }
  if (tax?.defaultCurrency) {
    rows.push({ label: 'Currency', value: tax.defaultCurrency });
  }

  const admin = data.admin as { email?: string } | undefined;
  if (admin?.email) {
    rows.push({ label: 'Admin sign-in', value: admin.email });
  }

  return rows;
}

export function DoneStep() {
  const { api, machine, finishAndClear } = useWizard();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);

  const summary = buildSummary(machine.data);

  const onFinish = async () => {
    setLoading(true);
    setError(null);
    setMissing(null);
    try {
      await api.complete();
      finishAndClear();
      window.location.assign('/admin');
    } catch (err) {
      if (err instanceof SetupApiError) {
        const body = err.body as { missing?: unknown } | null;
        if (Array.isArray(body?.missing)) {
          setMissing(body!.missing.filter((m): m is string => typeof m === 'string'));
          setError('A few things still need finishing before we can complete setup:');
        } else {
          setError(err.message);
        }
      } else {
        setError('Could not complete setup. Please try again.');
      }
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="space-y-6">
        <div className="flex items-center gap-3 rounded-lg border border-success/20 bg-success/10 p-4 text-success">
          <PartyPopper className="h-6 w-6 shrink-0" aria-hidden="true" />
          <p className="text-sm font-medium">
            Everything’s configured. Finish setup to open your admin.
          </p>
        </div>

        <Card>
          <CardContent className="pt-6">
            <h2 className="mb-3 text-sm font-semibold">Review your setup</h2>
            {summary.length > 0 ? (
              <dl className="space-y-2.5">
                {summary.map((row) => (
                  <div key={row.label} className="flex items-start justify-between gap-4 text-sm">
                    <dt className="flex items-center gap-2 text-muted-foreground">
                      <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                      {row.label}
                    </dt>
                    <dd className="break-all text-right font-medium">{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Your store is configured and ready to finish.
              </p>
            )}
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <p className="font-medium">{error}</p>
            {missing && missing.length > 0 && (
              <ul className="mt-3 space-y-2">
                {missing.map((code) => {
                  const entry = MISSING_LABELS[code];
                  return (
                    <li key={code} className="flex items-center justify-between gap-3">
                      <span>{entry?.label ?? code}</span>
                      {entry && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => machine.goTo(stepIndexById(entry.stepId))}
                        >
                          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                          Fix this
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Alert>
        )}
      </div>

      <StepFooter
        onContinue={onFinish}
        continueLabel="Finish setup"
        hideContinueArrow
        isLoading={loading}
      />
    </div>
  );
}
