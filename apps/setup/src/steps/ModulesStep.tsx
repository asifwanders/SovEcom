import { useEffect, useState } from 'react';
import { Check, Loader2, Package, PackageOpen, Puzzle } from 'lucide-react';
import { Alert } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError, type SetupModule } from '@/lib/api';

/**
 * Step 9 — Modules. Lists the platform's BUILT-IN modules from
 * GET /setup/v1/modules as selectable cards (display name + description + the slots it renders into
 * + the permissions it requests, with an "Installed" badge for any the tenant already has). The
 * operator multi-selects which to install + enable now; Continue → POST /setup/v1/modules/install
 * { moduleIds } (which installs + enables each via the hardened module runtime, server-side). The
 * step is OPTIONAL: Skip installs nothing and advances. Already-installed modules are a no-op on
 * the server (idempotent), so re-selecting one is safe.
 *
 * An already-installed built-in is shown checked + disabled (its state is fixed); only NOT-yet-
 * installed built-ins are toggleable, so Continue only ever sends new selections.
 */
export function ModulesStep() {
  const { api, machine } = useWizard();

  const [modules, setModules] = useState<SetupModule[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .get<'/setup/v1/modules', { modules: SetupModule[] }>('/setup/v1/modules')
      .then((res) => {
        if (cancelled) return;
        setModules(res?.modules ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setModules([]);
        setLoadError(
          err instanceof SetupApiError
            ? err.message
            : 'Could not load modules. You can add them later from the admin.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  /**
   * POST the selected ids (already-installed ones are a server no-op). On a clean install advance;
   * if the server reports ANY `failed` ids (S1) surface them inline and do NOT advance — the
   * operator must SEE which modules didn't install rather than the wizard claiming false success.
   * They can then deselect the failures and continue, or Skip (which installs nothing → no failures).
   */
  const persistAndAdvance = async (moduleIds: string[]) => {
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api.post<
        '/setup/v1/modules/install',
        { installed: string[]; failed: string[] }
      >('/setup/v1/modules/install', { moduleIds });
      const failed = res?.failed ?? [];
      if (failed.length > 0) {
        const names = failed.map((id) => modules?.find((m) => m.id === id)?.displayName ?? id);
        setFormError(
          `Some modules couldn’t be installed: ${names.join(', ')}. ` +
            'You can deselect them and continue, or install them later from the admin.',
        );
        return; // stay on the step so the operator sees the failure.
      }
      machine.setStepData('modules', { moduleIds });
      machine.next();
    } catch (err) {
      setFormError(
        err instanceof SetupApiError
          ? err.message
          : 'Could not install the selected modules. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await persistAndAdvance(selected);
  };

  const hasModules = modules !== null && modules.length > 0;

  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-4">
        {modules === null ? (
          <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading modules…
          </div>
        ) : (
          <>
            {loadError && <Alert variant="warning">{loadError}</Alert>}

            {!hasModules ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-12 text-center">
                <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <PackageOpen className="h-6 w-6" aria-hidden="true" />
                </span>
                <p className="text-sm font-medium">No modules to install yet</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Nothing to do here for now — you can install modules later from the admin.
                </p>
              </div>
            ) : (
              <>
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Puzzle className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  Pick the add-ons you want now. Each runs sandboxed and can be removed later from
                  the admin. You can also skip this and install them whenever you’re ready.
                </p>
                <fieldset className="space-y-3">
                  <legend className="sr-only">Built-in modules</legend>
                  {modules.map((m) => (
                    <ModuleCard
                      key={m.id}
                      module={m}
                      checked={m.installed || selected.includes(m.id)}
                      onToggle={(checked) => toggle(m.id, checked)}
                    />
                  ))}
                </fieldset>
              </>
            )}
          </>
        )}

        {formError && <Alert variant="destructive">{formError}</Alert>}
      </div>

      <StepFooter
        onBack={machine.canGoBack ? machine.back : undefined}
        onSkip={() => persistAndAdvance([])}
        continueType="submit"
        isLoading={submitting}
        continueDisabled={modules === null}
      />
    </form>
  );
}

interface ModuleCardProps {
  module: SetupModule;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}

/** A selectable built-in-module card: name + description + slots/permissions + an Installed badge. */
function ModuleCard({ module: m, checked, onToggle }: ModuleCardProps) {
  const disabled = m.installed; // already installed → fixed state, not toggleable.
  return (
    <label
      className={
        'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ' +
        'focus-within:ring-2 focus-within:ring-ring ' +
        (disabled ? 'cursor-default ' : '') +
        (checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-input text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Package className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{m.displayName || m.name}</span>
          {m.installed && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <Check className="h-3 w-3" aria-hidden="true" />
              Installed
            </span>
          )}
        </span>
        {m.description && (
          <span className="block text-sm text-muted-foreground">{m.description}</span>
        )}
        {(m.slots?.length > 0 || m.permissions?.length > 0) && (
          <span className="block space-y-0.5 pt-1 text-xs text-muted-foreground">
            {m.slots?.length > 0 && (
              <span className="block">
                <span className="font-medium text-foreground/70">Adds to:</span>{' '}
                {m.slots.map((s) => s.slot).join(', ')}
              </span>
            )}
            {m.permissions?.length > 0 && (
              <span className="block">
                <span className="font-medium text-foreground/70">Permissions:</span>{' '}
                {m.permissions.join(', ')}
              </span>
            )}
          </span>
        )}
      </span>
    </label>
  );
}
