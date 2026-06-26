'use client';

/**
 * customer profile edit form. Previously also hosted email/password/RGPD
 * sections; those have moved to /account/security and /account/privacy respectively.
 *
 * Editable fields: name (required in UI, nullable server-side), phone (optional/nullable),
 * vatNumber (B2B only, optional/nullable), acceptsMarketing (boolean).
 *
 * Email is displayed READ-ONLY with a locale-aware link to /account/security for credential changes.
 *
 * Auth: inside AccountGate so customer is always non-null here. On 401 we call refresh() once
 * and retry — mirroring the OrderDetail/AddressBook pattern.
 *
 * VAT: field is shown only when customer.isB2b. When a vatNumber is on file the VIES-validated
 * state is displayed. Changing vatNumber here re-runs VIES server-side (updateProfile delegates
 * to the same PATCH /store/v1/customers/me endpoint as updateVatNumber). NO client tax math.
 *
 * a11y: labelled fields, error association via AuthFormField, aria-busy while saving, role=status
 * for success, role=alert for form-level error.
 */
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { AuthFormField } from '@/components/auth/AuthFormField';
import { Button } from '@/components/ui/Button';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function ProfileEditForm(): React.ReactElement {
  const t = useTranslations('account.profile');
  const { customer, updateProfile, refresh } = useAuth();

  // Prefill from the in-memory customer snapshot.
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [vatNumber, setVatNumber] = useState(customer?.vatNumber ?? '');
  const [acceptsMarketing, setAcceptsMarketing] = useState(customer?.acceptsMarketing ?? false);

  const [nameError, setNameError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const nameRef = useRef<HTMLInputElement>(null);

  const isB2b = customer?.isB2b ?? false;
  const vatValidated = customer?.vatValidated ?? false;

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (saveState === 'saving') return;

    // Client-side validation: name is required in the UI.
    const trimmedName = name.trim();
    if (trimmedName === '') {
      setNameError(t('errorRequiredName'));
      nameRef.current?.focus();
      return;
    }
    setNameError(null);

    const trimmedPhone = phone.trim();
    const trimmedVat = vatNumber.trim();

    const fields: {
      name: string | null;
      phone: string | null;
      vatNumber?: string | null;
      acceptsMarketing: boolean;
    } = {
      name: trimmedName,
      // Send null to clear an optional field, or the trimmed value if provided.
      phone: trimmedPhone === '' ? null : trimmedPhone,
      acceptsMarketing,
    };

    if (isB2b) {
      fields.vatNumber = trimmedVat === '' ? null : trimmedVat;
    }

    setSaveState('saving');

    const doSave = async (isRetry = false): Promise<void> => {
      try {
        await updateProfile(fields);
        setSaveState('saved');
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 401 && !isRetry) {
          try {
            await refresh();
            return doSave(true);
          } catch {
            setSaveState('error');
            return;
          }
        }
        setSaveState('error');
      }
    };

    await doSave();
  }

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>

      {/* Email — read-only, never an input. Link to /account/security for credential changes. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">{t('emailLabel')}</span>
        <p className="text-sm text-foreground">{customer?.email}</p>
        <p className="text-xs text-muted-foreground">
          {t('emailReadonlyNote')}{' '}
          <Link
            href="/account/security"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t('manageCredentialsLink')}
          </Link>
        </p>
      </div>

      <form
        noValidate
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-4"
        aria-busy={saveState === 'saving'}
      >
        <AuthFormField
          id="profile-name"
          ref={nameRef}
          label={t('nameLabel')}
          name="name"
          autoComplete="name"
          value={name}
          error={nameError}
          disabled={saveState === 'saving'}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
        />

        <AuthFormField
          id="profile-phone"
          label={t('phoneLabel')}
          name="phone"
          type="tel"
          autoComplete="tel"
          value={phone}
          disabled={saveState === 'saving'}
          onChange={(e) => setPhone(e.target.value)}
        />

        {isB2b ? (
          <div className="flex flex-col gap-1.5">
            <AuthFormField
              id="profile-vat"
              label={t('vatLabel')}
              name="vatNumber"
              autoComplete="off"
              value={vatNumber}
              disabled={saveState === 'saving'}
              onChange={(e) => setVatNumber(e.target.value)}
            />
            {/* VAT validation state display — mirroring CheckoutVat display logic.
                Intentionally keyed off the SAVED `customer.vatNumber`/`vatValidated`, NOT the local
                input draft: this status describes what VIES validated (the persisted number), not an
                unsaved edit. It self-corrects after save via loadProfile(). Do not "fix" to local state. */}
            {(customer?.vatNumber ?? '').length > 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="vat-validated-status">
                {vatValidated ? t('vatValidated') : t('vatNotValidated')}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* acceptsMarketing checkbox */}
        <div className="flex flex-row items-center gap-2">
          <input
            id="profile-marketing"
            type="checkbox"
            name="acceptsMarketing"
            checked={acceptsMarketing}
            disabled={saveState === 'saving'}
            onChange={(e) => setAcceptsMarketing(e.target.checked)}
            className="h-4 w-4 rounded border-input accent-primary"
          />
          <label htmlFor="profile-marketing" className="text-sm text-foreground">
            {t('marketingLabel')}
          </label>
        </div>

        {/* Form-level error banner */}
        {saveState === 'error' ? (
          <p
            role="alert"
            className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t('saveError')}
          </p>
        ) : null}

        {/* Success status */}
        {saveState === 'saved' ? (
          <p
            role="status"
            className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-foreground"
          >
            {t('saved')}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={saveState === 'saving'}
          aria-busy={saveState === 'saving'}
        >
          {saveState === 'saving' ? t('saving') : t('save')}
        </Button>
      </form>
    </section>
  );
}
