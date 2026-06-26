'use client';

/**
 * Checkout step 2: address.
 * PII surface — the address lives ONLY on the server cart; it is NEVER logged or persisted to
 * web storage.
 *
 * BINDING: this step UNCONDITIONALLY posts the REAL full shipping address via
 * `useCart().setShippingAddress(...)`, OVERWRITING any estimator placeholder (`name/line1/city = "—"`).
 * After this step the cart's shipping address is the real one, so a placeholder can never survive
 * to checkout/order creation.
 *
 * Authenticated customers: we fetch
 * their saved addresses (`useAuth().fetchAddresses`) and PREFILL with the default (or first) one — still
 * fully editable. Here we only READ to prefill + POST the chosen one.
 *
 * Billing: a "same as shipping" toggle (default ON) — when off, a second address block is shown and its
 * REAL values are posted via `setBillingAddress`. When on, the server defaults billing to shipping.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { useCart } from '@/lib/cart-context';
import {
  COUNTRIES,
  EMPTY_ADDRESS,
  REQUIRED_ADDRESS_FIELDS,
  addressViewToForm,
  toAddressInput,
  validateAddress,
  type AddressFieldErrors,
  type AddressFormValues,
} from '@/lib/checkout-form';
import { AuthFormField } from '@/components/auth/AuthFormField';
import { Button } from '@/components/ui/Button';

/** A single editable address block (shipping or billing). a11y: each field labelled + error-associated. */
function AddressFields({
  idPrefix,
  legend,
  values,
  errors,
  disabled,
  refs,
  onChange,
}: {
  idPrefix: string;
  legend: string;
  values: AddressFormValues;
  errors: AddressFieldErrors;
  disabled: boolean;
  refs?: Partial<Record<keyof AddressFormValues, React.RefObject<HTMLInputElement | null>>>;
  onChange: (field: keyof AddressFormValues, value: string) => void;
}): React.ReactElement {
  const t = useTranslations('checkout');
  const tErr = useTranslations('checkout.address.errors');
  const countryId = `${idPrefix}-country`;

  // Only the required fields + country can carry a validation error (see `validateAddress`), so only
  // THOSE keys have an `errors.*` message — the optional fields (company/line2/region/phone) never do.
  // This map is the single place that knows the error-bearing keys, keeping the catalog free of dead keys.
  const ERROR_KEYS = ['name', 'line1', 'city', 'postalCode', 'country'] as const;
  type ErrorKey = (typeof ERROR_KEYS)[number];
  const isErrorKey = (k: keyof AddressFormValues): k is ErrorKey =>
    (ERROR_KEYS as readonly string[]).includes(k);
  const errorText = (name: keyof AddressFormValues): string | null =>
    errors[name] && isErrorKey(name) ? tErr(name) : null;

  const field = (
    name: keyof AddressFormValues,
    label: string,
    extra?: { type?: string; autoComplete?: string; required?: boolean },
  ): React.ReactElement => (
    <AuthFormField
      id={`${idPrefix}-${name}`}
      ref={refs?.[name] as React.Ref<HTMLInputElement>}
      label={label}
      type={extra?.type ?? 'text'}
      name={name}
      autoComplete={extra?.autoComplete}
      required={extra?.required}
      value={values[name]}
      error={errorText(name)}
      disabled={disabled}
      onChange={(e) => onChange(name, e.target.value)}
    />
  );

  return (
    <fieldset className="flex flex-col gap-4 border-0 p-0">
      <legend className="text-sm font-semibold text-foreground">{legend}</legend>
      {field('name', t('address.name'), { autoComplete: 'name', required: true })}
      {field('company', t('address.company'), { autoComplete: 'organization' })}
      {field('line1', t('address.line1'), { autoComplete: 'address-line1', required: true })}
      {field('line2', t('address.line2'), { autoComplete: 'address-line2' })}
      {field('city', t('address.city'), { autoComplete: 'address-level2', required: true })}
      {field('postalCode', t('address.postalCode'), {
        autoComplete: 'postal-code',
        required: true,
      })}
      {field('region', t('address.region'), { autoComplete: 'address-level1' })}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={countryId} className="text-sm font-medium text-foreground">
          {t('address.country')}
        </label>
        <select
          id={countryId}
          name="country"
          autoComplete="country"
          value={values.country}
          disabled={disabled}
          aria-invalid={errors.country ? true : undefined}
          aria-describedby={errors.country ? `${countryId}-error` : undefined}
          onChange={(e) => onChange('country', e.target.value)}
          className="flex h-10 rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">{t('address.countryPlaceholder')}</option>
          {COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {errors.country ? (
          <p id={`${countryId}-error`} role="alert" className="text-sm text-destructive">
            {tErr('country')}
          </p>
        ) : null}
      </div>
      {field('phone', t('address.phone'), { type: 'tel', autoComplete: 'tel' })}
    </fieldset>
  );
}

export function CheckoutAddress({ onDone }: { onDone: () => void }): React.ReactElement {
  const t = useTranslations('checkout');
  const { isAuthenticated, fetchAddresses } = useAuth();
  const { setShippingAddress, setBillingAddress } = useCart();

  const baseId = useId();
  const [shipping, setShipping] = useState<AddressFormValues>(EMPTY_ADDRESS);
  const [billing, setBilling] = useState<AddressFormValues>(EMPTY_ADDRESS);
  const [billingSame, setBillingSame] = useState(true);
  const [shipErrors, setShipErrors] = useState<AddressFieldErrors>({});
  const [billErrors, setBillErrors] = useState<AddressFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Refs for first-invalid focus on the SHIPPING block (the primary required block).
  const shipRefs = {
    name: useRef<HTMLInputElement>(null),
    line1: useRef<HTMLInputElement>(null),
    city: useRef<HTMLInputElement>(null),
    postalCode: useRef<HTMLInputElement>(null),
  };

  // Authenticated: prefill from the saved DEFAULT address (or the first one). A failed fetch
  // silently leaves the blank form (the customer can type their own).
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        const saved = await fetchAddresses();
        if (cancelled || saved.length === 0) return;
        const ship = saved.find((a) => a.type === 'shipping' && a.isDefault) ?? saved.find((a) => a.type === 'shipping') ?? saved.find((a) => a.isDefault) ?? saved[0]; // prettier-ignore
        if (ship) setShipping(addressViewToForm(ship));
      } catch {
        // No saved addresses available — leave the blank form.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, fetchAddresses]);

  function onShipChange(field: keyof AddressFormValues, value: string): void {
    setShipping((s) => ({ ...s, [field]: value }));
  }
  function onBillChange(field: keyof AddressFormValues, value: string): void {
    setBilling((b) => ({ ...b, [field]: value }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setFormError(null);

    const sErr = validateAddress(shipping);
    const bErr = billingSame ? {} : validateAddress(billing);
    setShipErrors(sErr);
    setBillErrors(bErr);
    if (Object.keys(sErr).length > 0) {
      const first = REQUIRED_ADDRESS_FIELDS.find((f) => sErr[f]);
      const ref =
        first && first in shipRefs
          ? (shipRefs as Record<string, React.RefObject<HTMLInputElement | null>>)[first]
          : undefined;
      ref?.current?.focus();
      return;
    }
    if (Object.keys(bErr).length > 0) return;

    setPending(true);
    try {
      // BINDING: post the REAL shipping address — this overwrites any placeholder on the cart.
      await setShippingAddress(toAddressInput(shipping));
      if (!billingSame) {
        await setBillingAddress(toAddressInput(billing));
      }
      onDone();
    } catch {
      setFormError(t('address.error'));
      setPending(false);
    }
  }

  const formErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-6" aria-busy={pending}>
      {formError ? (
        <div
          ref={formErrorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {formError}
        </div>
      ) : null}

      <AddressFields
        idPrefix={`${baseId}-ship`}
        legend={t('address.shippingLegend')}
        values={shipping}
        errors={shipErrors}
        disabled={pending}
        refs={shipRefs}
        onChange={onShipChange}
      />

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={billingSame}
          disabled={pending}
          onChange={(e) => setBillingSame(e.target.checked)}
          className="h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {t('address.billingSame')}
      </label>

      {!billingSame ? (
        <AddressFields
          idPrefix={`${baseId}-bill`}
          legend={t('address.billingLegend')}
          values={billing}
          errors={billErrors}
          disabled={pending}
          onChange={onBillChange}
        />
      ) : null}

      <Button type="submit" variant="primary" size="md" disabled={pending} aria-disabled={pending}>
        {pending ? t('continuing') : t('continue')}
      </Button>
    </form>
  );
}
