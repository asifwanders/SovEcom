/**
 * pure helpers for the checkout flow. No React, no I/O — unit-testable in isolation.
 * MONEY/PII-ADJACENT but does NO money math (totals are server-authoritative) and NEVER persists PII
 * (addresses live only on the server cart). It encodes:
 *   - the step order + the prerequisite GUARD (you cannot reach review without email+address+shipping);
 *   - the address-form field validation (mirrors the API `AddressSchema` required set);
 *   - the reverse-charge DISPLAY decision (derived from the customer's B2B/VIES flags + the server's
 *     `taxTotal` — the server is authoritative; this only decides whether to SHOW the reverse-charge note).
 */
import type { CartAddressInput, CartView } from './cart-types';
import type { AuthCustomer } from './auth-context';

/** EU-first country shortlist. Exported so both checkout and address-book share one source of truth. */
export const COUNTRIES = ['FR', 'DE', 'ES', 'IT', 'BE', 'NL', 'LU', 'IE', 'PT', 'AT'] as const;

/**
 * The ordered checkout steps. `payment` is the terminal step, reachable only once review's
 * prerequisites are met (email + real address + chosen rate). The order is created at the payment
 * step, not before.
 */
export const CHECKOUT_STEPS = ['email', 'address', 'shipping', 'review', 'payment'] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

/** Index of a step in the canonical order (for progress + back-nav). */
export function stepIndex(step: CheckoutStep): number {
  return CHECKOUT_STEPS.indexOf(step);
}

/**
 * The address fields the form collects. Required: name/line1/city/postalCode/country (mirrors the API
 * `AddressSchema`). `region`/`company`/`line2`/`phone` are optional.
 */
export interface AddressFormValues {
  name: string;
  company: string;
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
  region: string;
  country: string;
  phone: string;
}

export const EMPTY_ADDRESS: AddressFormValues = {
  name: '',
  company: '',
  line1: '',
  line2: '',
  city: '',
  postalCode: '',
  region: '',
  country: '',
  phone: '',
};

/** The required address fields, in focus order (first-invalid focus, WCAG 3.3.1). */
export const REQUIRED_ADDRESS_FIELDS = [
  'name',
  'line1',
  'city',
  'postalCode',
  'country',
] as const satisfies readonly (keyof AddressFormValues)[];

export type AddressFieldErrors = Partial<Record<keyof AddressFormValues, true>>;

/**
 * Validate an address form. Returns `{}` when valid. A field is invalid only when REQUIRED and blank, or
 * when `country` is not a 2-letter code (the API upper-cases + ISO-validates; we catch the obvious shape
 * client-side for a fast error). Never throws; the server remains authoritative.
 */
export function validateAddress(values: AddressFormValues): AddressFieldErrors {
  const errors: AddressFieldErrors = {};
  for (const field of REQUIRED_ADDRESS_FIELDS) {
    if (values[field].trim() === '') errors[field] = true;
  }
  // Country must be exactly two letters (the API regex is /^[A-Za-z]{2}$/). Only flag when non-empty and
  // malformed (blank is already covered by the required check above).
  if (values.country.trim() !== '' && !/^[A-Za-z]{2}$/.test(values.country.trim())) {
    errors.country = true;
  }
  return errors;
}

/** True when an address form has no validation errors. */
export function isAddressValid(values: AddressFormValues): boolean {
  return Object.keys(validateAddress(values)).length === 0;
}

/**
 * Convert a validated form into the API `CartAddressInput`. Optional fields are sent only when non-empty
 * (the API treats them as optional/nullable); we send `undefined` (omit) rather than `''` to satisfy the
 * `.min(1)` constraints on the optional fields. `country` is upper-cased to match the API normalisation.
 */
export function toAddressInput(values: AddressFormValues): CartAddressInput {
  const opt = (v: string): string | undefined => {
    const t = v.trim();
    return t === '' ? undefined : t;
  };
  return {
    name: values.name.trim(),
    line1: values.line1.trim(),
    city: values.city.trim(),
    postalCode: values.postalCode.trim(),
    country: values.country.trim().toUpperCase(),
    company: opt(values.company),
    line2: opt(values.line2),
    region: opt(values.region),
    phone: opt(values.phone),
  };
}

/** Map a saved customer `AddressView`-shaped object to the editable form values (prefill). */
export function addressViewToForm(a: {
  name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string;
  region: string | null;
  country: string;
  phone: string | null;
}): AddressFormValues {
  return {
    name: a.name ?? '',
    company: a.company ?? '',
    line1: a.line1 ?? '',
    line2: a.line2 ?? '',
    city: a.city ?? '',
    postalCode: a.postalCode ?? '',
    region: a.region ?? '',
    country: a.country ?? '',
    phone: a.phone ?? '',
  };
}

/** True when the cart carries a shipping address whose stored values look like the estimator placeholder. */
export function isPlaceholderAddress(addr: unknown): boolean {
  if (addr === null || typeof addr !== 'object') return false;
  const a = addr as { name?: unknown; line1?: unknown; city?: unknown };
  return a.name === '—' || a.line1 === '—' || a.city === '—';
}

/**
 * Whether a step is REACHABLE given the cart state — the guard the controller enforces so a customer
 * can't deep-link/skip into a later step without its prerequisites:
 *   - email:    always.
 *   - address:  requires an email on the cart (guest email OR an associated customer's account email).
 *   - shipping: requires a REAL (non-placeholder) shipping address on the cart.
 *   - review:   requires email + real shipping address + a chosen shipping rate.
 * `hasEmail` is passed explicitly because a logged-in customer's email may be on their account rather
 * than `cart.guestEmail` — the controller computes it from auth + cart.
 */
export function canReachStep(
  step: CheckoutStep,
  cart: CartView | null,
  hasEmail: boolean,
): boolean {
  if (step === 'email') return true;
  if (!cart) return false;
  const hasRealAddress =
    cart.shippingAddress !== null && !isPlaceholderAddress(cart.shippingAddress);
  if (step === 'address') return hasEmail;
  if (step === 'shipping') return hasEmail && hasRealAddress;
  // review + payment share the same prerequisite set (email + real address + a chosen rate). The
  // PAYMENT step additionally must never be reachable with a placeholder address — `hasRealAddress`
  // already excludes the estimator "—" placeholder, so a placeholder can never reach payment.
  return hasEmail && hasRealAddress && cart.shippingRateId !== null;
}

/** The furthest step the customer is allowed to be on for the current cart (clamps a stale/forward step). */
export function furthestReachableStep(cart: CartView | null, hasEmail: boolean): CheckoutStep {
  let furthest: CheckoutStep = 'email';
  for (const step of CHECKOUT_STEPS) {
    if (canReachStep(step, cart, hasEmail)) furthest = step;
    else break;
  }
  return furthest;
}

/**
 * Whether the storefront should DISPLAY the B2B reverse-charge note. The server is authoritative for both
 * the money AND the decision: it sets `cart.totals.reverseCharge` IFF the tax engine actually applied
 * reverse charge (a resolved tax line carried `reverseCharge` — a VIES-validated B2B cross-border-EU
 * sale). We read THAT flag — NEVER an inference from `taxTotal === 0`, which false-positives on the `none`
 * regime, no-destination carts, zero-rated jurisdictions, and non-EU exports. The
 * customer's VIES-validated B2B status is still required as a UI guard so the note only shows in a B2B
 * context. NO client tax computation.
 */
export function shouldShowReverseCharge(
  customer: Pick<AuthCustomer, 'isB2b' | 'vatValidated'> | null,
  cart: CartView | null,
): boolean {
  if (!customer || !customer.isB2b || !customer.vatValidated) return false;
  if (!cart || cart.items.length === 0) return false;
  return cart.totals.reverseCharge === true;
}
