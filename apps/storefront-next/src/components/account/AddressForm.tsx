'use client';

/**
 * address create/edit form.
 *
 * Reuses AddressFormValues, EMPTY_ADDRESS, validateAddress, addressViewToForm, COUNTRIES, and
 * REQUIRED_ADDRESS_FIELDS from checkout-form.ts. Adds two address-book-specific controls: a `type`
 * select (shipping | billing) and an `isDefault` checkbox. These are NOT part of AddressFormValues
 * and are managed as separate local state, then folded into the CreateAddressInput / UpdateAddressInput
 * DTO by the parent (AddressBook) before calling the mutation.
 *
 * On submit: validates the address fields client-side, calls onSubmit with the merged DTO, and shows
 * an inline error banner on rejection. The parent controls the pending/error state via props so the
 * same form handles both create and edit paths.
 *
 * a11y: all fields are labelled + error-associated (WCAG 3.3.1); error banner has role="alert" and is
 * focusable. RTL-safe logical CSS only.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  COUNTRIES,
  EMPTY_ADDRESS,
  REQUIRED_ADDRESS_FIELDS,
  addressViewToForm,
  validateAddress,
  type AddressFieldErrors,
  type AddressFormValues,
} from '@/lib/checkout-form';
import { AuthFormField } from '@/components/auth/AuthFormField';
import type { SavedAddress } from '@/lib/auth-context';

export interface AddressFormSubmitPayload {
  fields: AddressFormValues;
  type: 'shipping' | 'billing';
  isDefault: boolean;
}

export interface AddressFormProps {
  /** When provided, the form is in edit mode and will be pre-filled from this address. */
  initial?: SavedAddress;
  /** True while the parent is executing the create/update mutation. */
  pending: boolean;
  /** Non-null when the last submit attempt failed. */
  error: string | null;
  /** Called with the validated form payload when the user submits. */
  onSubmit: (payload: AddressFormSubmitPayload) => void;
  /** Called when the user clicks Cancel. */
  onCancel: () => void;
}

export function AddressForm({
  initial,
  pending,
  error,
  onSubmit,
  onCancel,
}: AddressFormProps): React.ReactElement {
  const t = useTranslations('account.addresses');
  const tCheckout = useTranslations('checkout.address');
  const tErrors = useTranslations('checkout.address.errors');

  const baseId = useId();

  const [fields, setFields] = useState<AddressFormValues>(() =>
    initial ? addressViewToForm(initial) : { ...EMPTY_ADDRESS },
  );
  const [type, setType] = useState<'shipping' | 'billing'>(initial?.type ?? 'shipping');
  const [isDefault, setIsDefault] = useState<boolean>(initial?.isDefault ?? false);
  const [fieldErrors, setFieldErrors] = useState<AddressFieldErrors>({});

  // Refs for first-invalid-focus (WCAG 3.3.1)
  const nameRef = useRef<HTMLInputElement>(null);
  const line1Ref = useRef<HTMLInputElement>(null);
  const cityRef = useRef<HTMLInputElement>(null);
  const postalCodeRef = useRef<HTMLInputElement>(null);

  const fieldRefs: Partial<
    Record<keyof AddressFormValues, React.RefObject<HTMLInputElement | null>>
  > = {
    name: nameRef,
    line1: line1Ref,
    city: cityRef,
    postalCode: postalCodeRef,
  };

  // Focus the error banner when it appears (a11y live region).
  const errorBannerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorBannerRef.current?.focus();
  }, [error]);

  function onChange(field: keyof AddressFormValues, value: string): void {
    setFields((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (pending) return;

    const errors = validateAddress(fields);
    setFieldErrors(errors);

    if (Object.keys(errors).length > 0) {
      const firstInvalid = REQUIRED_ADDRESS_FIELDS.find((f) => errors[f]);
      if (firstInvalid) {
        const ref = fieldRefs[firstInvalid as keyof typeof fieldRefs];
        ref?.current?.focus();
      }
      return;
    }

    onSubmit({ fields, type, isDefault });
  }

  const errorText = (name: keyof AddressFormValues): string | null => {
    if (!fieldErrors[name]) return null;
    // Only REQUIRED_ADDRESS_FIELDS + country carry error messages.
    if (name === 'name') return tErrors('name');
    if (name === 'line1') return tErrors('line1');
    if (name === 'city') return tErrors('city');
    if (name === 'postalCode') return tErrors('postalCode');
    if (name === 'country') return tErrors('country');
    return null;
  };

  const countryId = `${baseId}-country`;
  const typeId = `${baseId}-type`;
  const defaultId = `${baseId}-isDefault`;

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className="flex flex-col gap-5"
      aria-busy={pending || undefined}
    >
      {error ? (
        <div
          ref={errorBannerRef}
          tabIndex={-1}
          role="alert"
          data-testid="address-form-error"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {error}
        </div>
      ) : null}

      {/* Type select */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={typeId} className="text-sm font-medium text-foreground">
          {t('typeLabel')}
        </label>
        <select
          id={typeId}
          name="type"
          value={type}
          disabled={pending}
          onChange={(e) => setType(e.target.value as 'shipping' | 'billing')}
          className="flex h-10 rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="shipping">{t('shippingType')}</option>
          <option value="billing">{t('billingType')}</option>
        </select>
      </div>

      <AuthFormField
        id={`${baseId}-name`}
        ref={nameRef}
        label={t('name')}
        type="text"
        name="name"
        autoComplete="name"
        required
        value={fields.name}
        error={errorText('name')}
        disabled={pending}
        onChange={(e) => onChange('name', e.target.value)}
      />
      <AuthFormField
        id={`${baseId}-company`}
        label={t('company')}
        type="text"
        name="company"
        autoComplete="organization"
        value={fields.company}
        disabled={pending}
        onChange={(e) => onChange('company', e.target.value)}
      />
      <AuthFormField
        id={`${baseId}-line1`}
        ref={line1Ref}
        label={t('line1')}
        type="text"
        name="line1"
        autoComplete="address-line1"
        required
        value={fields.line1}
        error={errorText('line1')}
        disabled={pending}
        onChange={(e) => onChange('line1', e.target.value)}
      />
      <AuthFormField
        id={`${baseId}-line2`}
        label={t('line2')}
        type="text"
        name="line2"
        autoComplete="address-line2"
        value={fields.line2}
        disabled={pending}
        onChange={(e) => onChange('line2', e.target.value)}
      />
      <AuthFormField
        id={`${baseId}-city`}
        ref={cityRef}
        label={t('city')}
        type="text"
        name="city"
        autoComplete="address-level2"
        required
        value={fields.city}
        error={errorText('city')}
        disabled={pending}
        onChange={(e) => onChange('city', e.target.value)}
      />
      <AuthFormField
        id={`${baseId}-postalCode`}
        ref={postalCodeRef}
        label={t('postalCode')}
        type="text"
        name="postalCode"
        autoComplete="postal-code"
        required
        value={fields.postalCode}
        error={errorText('postalCode')}
        disabled={pending}
        onChange={(e) => onChange('postalCode', e.target.value)}
      />
      <AuthFormField
        id={`${baseId}-region`}
        label={t('region')}
        type="text"
        name="region"
        autoComplete="address-level1"
        value={fields.region}
        disabled={pending}
        onChange={(e) => onChange('region', e.target.value)}
      />

      {/* Country select */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={countryId} className="text-sm font-medium text-foreground">
          {t('country')}
        </label>
        <select
          id={countryId}
          name="country"
          autoComplete="country"
          value={fields.country}
          disabled={pending}
          aria-invalid={fieldErrors.country ? true : undefined}
          aria-describedby={fieldErrors.country ? `${countryId}-error` : undefined}
          onChange={(e) => onChange('country', e.target.value)}
          className="flex h-10 rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">{tCheckout('countryPlaceholder')}</option>
          {COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {fieldErrors.country ? (
          <p id={`${countryId}-error`} role="alert" className="text-sm text-destructive">
            {tErrors('country')}
          </p>
        ) : null}
      </div>

      <AuthFormField
        id={`${baseId}-phone`}
        label={t('phone')}
        type="tel"
        name="phone"
        autoComplete="tel"
        value={fields.phone}
        disabled={pending}
        onChange={(e) => onChange('phone', e.target.value)}
      />

      {/* isDefault checkbox */}
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          id={defaultId}
          type="checkbox"
          name="isDefault"
          checked={isDefault}
          disabled={pending}
          onChange={(e) => setIsDefault(e.target.checked)}
          className="h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {t('setDefault')}
      </label>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={pending}
          aria-disabled={pending}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {pending ? t('saving') : t('save')}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onCancel}
          className="inline-flex items-center justify-center rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}
