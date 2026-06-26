import { useEffect, useState } from 'react';
import { Check, Palette, Loader2, Sparkles } from 'lucide-react';
import { Alert } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError, type SetupTheme } from '@/lib/api';

/**
 * Storefront theme step. GET /setup/v1/themes lists the tenant's installed
 * themes (the seeded `default` + `boutique`); no real screenshots exist yet, so we show a
 * tasteful placeholder preview, honestly. The first theme is pre-selected. Continue → POST
 * /setup/v1/themes/activate { themeId } (the theme NAME), which flips its is_active.
 */

export function ThemeStep() {
  const { api, machine } = useWizard();

  const [themes, setThemes] = useState<SetupTheme[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .get<'/setup/v1/themes', { themes: SetupTheme[] }>('/setup/v1/themes')
      .then((res) => {
        if (cancelled) return;
        const list = res?.themes ?? [];
        setThemes(list);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setThemes([]);
        setLoadError(
          err instanceof SetupApiError
            ? err.message
            : 'Could not load themes. You can continue with the default and change it later.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!selectedId) {
      setFormError('Select a theme to continue.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/setup/v1/themes/activate', { themeId: selectedId });
      machine.setStepData('theme', { themeId: selectedId });
      machine.next();
    } catch (err) {
      setFormError(
        err instanceof SetupApiError
          ? err.message
          : 'Could not activate that theme. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col" noValidate>
      <div className="space-y-4">
        {themes === null ? (
          <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading themes…
          </div>
        ) : (
          <>
            {loadError && <Alert variant="warning">{loadError}</Alert>}

            <fieldset>
              <legend className="sr-only">Storefront theme</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {themes.map((theme) => (
                  <ThemeCard
                    key={theme.id}
                    theme={theme}
                    selected={selectedId === theme.id}
                    onSelect={() => setSelectedId(theme.id)}
                  />
                ))}
              </div>
            </fieldset>

            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              More themes are coming. For now you’ll start on the default — you can switch themes
              anytime from the admin once the gallery lands.
            </p>
          </>
        )}

        {formError && <Alert variant="destructive">{formError}</Alert>}
      </div>

      <StepFooter
        onBack={machine.canGoBack ? machine.back : undefined}
        continueType="submit"
        isLoading={submitting}
        continueDisabled={themes === null || !selectedId}
      />
    </form>
  );
}

interface ThemeCardProps {
  theme: SetupTheme;
  selected: boolean;
  onSelect: () => void;
}

/** A selectable theme card with a placeholder preview block (no real screenshot yet). */
function ThemeCard({ theme, selected, onSelect }: ThemeCardProps) {
  return (
    <label
      className={
        'group flex cursor-pointer flex-col overflow-hidden rounded-lg border transition-colors ' +
        'focus-within:ring-2 focus-within:ring-ring ' +
        (selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-muted/50')
      }
    >
      <input type="radio" name="theme" className="sr-only" checked={selected} onChange={onSelect} />
      {/* Placeholder preview — a tasteful gradient block, NOT a fake screenshot. */}
      <div
        aria-hidden="true"
        className="relative flex h-32 items-center justify-center bg-gradient-to-br from-primary/15 via-muted to-muted"
      >
        <Palette className="h-8 w-8 text-primary/60" aria-hidden="true" />
        {selected && (
          <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 p-3">
        <div className="space-y-0.5">
          <span className="block text-sm font-medium">{theme.name}</span>
          <span className="block text-xs text-muted-foreground">Preview coming soon</span>
        </div>
        {selected && <span className="text-xs font-medium text-primary">Selected</span>}
      </div>
    </label>
  );
}
