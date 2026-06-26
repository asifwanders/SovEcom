import { useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { Alert, Card, CardContent, Label, Switch } from '@/components/ui';
import { StepFooter } from '@/components/StepFooter';
import { useWizard } from '@/wizard/WizardContext';
import { SetupApiError } from '@/lib/api';
import { ColorField, isValidHex } from './_shared';

/**
 * Step 2 — Brand. Optional logo upload (client-validated type + size with
 * a preview thumbnail), primary/secondary colour pickers, and a gradient-vs-flat toggle.
 * Continue posts MULTIPART to /setup/v1/brand (the logo is a binary part); the scalar
 * fields are coerced server-side. Everything is optional — Continue works with just the
 * default colours and no logo.
 */

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const ACCEPTED_LABEL = 'PNG, JPEG, WebP, or SVG';
const MAX_BYTES = 5 * 1024 * 1024;

const DEFAULT_PRIMARY = '#00B9A0';
const DEFAULT_SECONDARY = '#0F172A';

export function BrandStep() {
  const { api, machine } = useWizard();

  const [primary, setPrimary] = useState(DEFAULT_PRIMARY);
  const [secondary, setSecondary] = useState(DEFAULT_SECONDARY);
  const [gradient, setGradient] = useState(false);

  const [logo, setLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  const [primaryError, setPrimaryError] = useState<string | null>(null);
  const [secondaryError, setSecondaryError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLogoError(null);
    const file = e.target.files?.[0] ?? null;
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setLogoError(`That file type isn’t supported. Use a ${ACCEPTED_LABEL} image.`);
      e.target.value = '';
      return;
    }
    if (file.size > MAX_BYTES) {
      setLogoError('That logo is larger than 5 MB. Please choose a smaller file.');
      e.target.value = '';
      return;
    }

    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogo(file);
    setLogoPreview(URL.createObjectURL(file));
  };

  const clearLogo = () => {
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogo(null);
    setLogoPreview(null);
    setLogoError(null);
  };

  const onContinue = async () => {
    setFormError(null);
    const pOk = isValidHex(primary);
    const sOk = isValidHex(secondary);
    setPrimaryError(pOk ? null : 'Enter a hex colour like #00B9A0.');
    setSecondaryError(sOk ? null : 'Enter a hex colour like #0F172A.');
    if (!pOk || !sOk) return;

    const form = new FormData();
    form.append('primary', primary.trim());
    form.append('secondary', secondary.trim());
    form.append('gradient', String(gradient));
    if (logo) form.append('logo', logo);

    setSubmitting(true);
    try {
      await api.postMultipart('/setup/v1/brand', form);
      machine.setStepData('brand', { primary, secondary, gradient, hasLogo: Boolean(logo) });
      if (logoPreview) URL.revokeObjectURL(logoPreview);
      machine.next();
    } catch (err) {
      setFormError(
        err instanceof SetupApiError
          ? err.message
          : 'Could not save your branding. Please try again.',
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <Label htmlFor="brand-logo">Logo (optional)</Label>
            <p className="text-sm text-muted-foreground">
              {ACCEPTED_LABEL}, up to 5 MB. Shown in your storefront and admin.
            </p>

            <div className="flex items-center gap-4">
              {logoPreview ? (
                <div className="relative">
                  <img
                    src={logoPreview}
                    alt="Logo preview"
                    className="h-16 w-16 rounded-md border border-border object-contain p-1"
                  />
                  <button
                    type="button"
                    onClick={clearLogo}
                    aria-label="Remove logo"
                    className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <span className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground">
                  <ImagePlus className="h-5 w-5" aria-hidden="true" />
                </span>
              )}

              <div className="space-y-1.5">
                <input
                  id="brand-logo"
                  type="file"
                  accept={ACCEPTED_TYPES.join(',')}
                  onChange={onFileChange}
                  aria-invalid={logoError ? true : undefined}
                  aria-describedby={logoError ? 'brand-logo-error' : undefined}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-muted focus-visible:outline-none"
                />
              </div>
            </div>
            {logoError && (
              <p
                id="brand-logo-error"
                role="alert"
                className="text-sm font-medium text-destructive"
              >
                {logoError}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-5 pt-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField
                label="Primary colour"
                value={primary}
                onChange={(v) => {
                  setPrimary(v);
                  setPrimaryError(null);
                }}
                error={primaryError ?? undefined}
                disabled={submitting}
              />
              <ColorField
                label="Secondary colour"
                value={secondary}
                onChange={(v) => {
                  setSecondary(v);
                  setSecondaryError(null);
                }}
                error={secondaryError ?? undefined}
                disabled={submitting}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="brand-gradient">Gradient accent</Label>
                <p className="text-sm text-muted-foreground">
                  Blend your two colours instead of a flat fill.
                </p>
              </div>
              <Switch
                id="brand-gradient"
                checked={gradient}
                onCheckedChange={setGradient}
                disabled={submitting}
                aria-label="Use a gradient accent"
              />
            </div>
          </CardContent>
        </Card>

        {formError && <Alert variant="destructive">{formError}</Alert>}
      </div>

      <StepFooter
        onBack={machine.canGoBack ? machine.back : undefined}
        onContinue={onContinue}
        isLoading={submitting}
      />
    </div>
  );
}
