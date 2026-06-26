/**
 * checkout pure-helper contract. Validation, address conversion, step-reachability guards,
 * and the reverse-charge display decision (server-authoritative — these helpers never compute money/tax).
 */
import { describe, it, expect } from 'vitest';
import type { CartView } from './cart-types';
import {
  CHECKOUT_STEPS,
  EMPTY_ADDRESS,
  addressViewToForm,
  canReachStep,
  furthestReachableStep,
  isAddressValid,
  isPlaceholderAddress,
  shouldShowReverseCharge,
  stepIndex,
  toAddressInput,
  validateAddress,
  type AddressFormValues,
} from './checkout-form';

const realAddress: AddressFormValues = {
  name: 'Marie Curie',
  company: '',
  line1: '12 Rue de la Paix',
  line2: '',
  city: 'Paris',
  postalCode: '75002',
  region: '',
  country: 'FR',
  phone: '',
};

function cart(over: Partial<CartView> = {}): CartView {
  return {
    id: 'cart-1',
    customerId: null,
    currency: 'EUR',
    status: 'active',
    guestEmail: null,
    items: [
      {
        id: 'li-1',
        variantId: 'v1',
        quantity: 1,
        unitPriceAmount: 1999,
        currency: 'EUR',
        productTitle: 'Tee',
        variantTitle: null,
        options: {},
        sku: 'TEE',
        productSlug: 'tee',
      },
    ],
    shippingAddress: null,
    billingAddress: null,
    shippingRateId: null,
    discountCode: null,
    totals: {
      subtotal: 1999,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 400,
      grandTotal: 2399,
      currency: 'EUR',
      reverseCharge: false,
    },
    ...over,
  };
}

describe('validateAddress', () => {
  it('passes a complete address', () => {
    expect(validateAddress(realAddress)).toEqual({});
    expect(isAddressValid(realAddress)).toBe(true);
  });

  it('flags each missing required field', () => {
    const errors = validateAddress(EMPTY_ADDRESS);
    expect(errors).toEqual({
      name: true,
      line1: true,
      city: true,
      postalCode: true,
      country: true,
    });
    expect(isAddressValid(EMPTY_ADDRESS)).toBe(false);
  });

  it('does NOT require company/line2/region/phone', () => {
    const errors = validateAddress(realAddress);
    expect(errors.company).toBeUndefined();
    expect(errors.line2).toBeUndefined();
    expect(errors.region).toBeUndefined();
    expect(errors.phone).toBeUndefined();
  });

  it('rejects a malformed (non-2-letter) country', () => {
    expect(validateAddress({ ...realAddress, country: 'FRANCE' }).country).toBe(true);
    expect(validateAddress({ ...realAddress, country: 'F' }).country).toBe(true);
  });
});

describe('toAddressInput', () => {
  it('trims required fields, upper-cases country, and OMITS blank optionals', () => {
    const input = toAddressInput({ ...realAddress, country: 'fr', city: '  Paris ' });
    expect(input).toEqual({
      name: 'Marie Curie',
      line1: '12 Rue de la Paix',
      city: 'Paris',
      postalCode: '75002',
      country: 'FR',
      company: undefined,
      line2: undefined,
      region: undefined,
      phone: undefined,
    });
  });

  it('includes optionals when present', () => {
    const input = toAddressInput({ ...realAddress, company: 'ACME', phone: '+33100000000' });
    expect(input.company).toBe('ACME');
    expect(input.phone).toBe('+33100000000');
  });
});

describe('addressViewToForm', () => {
  it('maps a saved AddressView (nulls → empty strings) into editable form values', () => {
    const form = addressViewToForm({
      name: 'Marie',
      company: null,
      line1: '12 Rue',
      line2: null,
      city: 'Paris',
      postalCode: '75002',
      region: null,
      country: 'FR',
      phone: null,
    });
    expect(form.name).toBe('Marie');
    expect(form.company).toBe('');
    expect(form.country).toBe('FR');
  });
});

describe('isPlaceholderAddress', () => {
  it('detects the estimator "—" placeholder', () => {
    expect(isPlaceholderAddress({ name: '—', line1: '—', city: '—', postalCode: '75001' })).toBe(
      true,
    );
  });
  it('treats a real address as non-placeholder', () => {
    expect(isPlaceholderAddress({ name: 'Marie', line1: '12 Rue', city: 'Paris' })).toBe(false);
  });
  it('treats null as non-placeholder', () => {
    expect(isPlaceholderAddress(null)).toBe(false);
  });
});

describe('step reachability guards', () => {
  it('email is always reachable; later steps need their prerequisites', () => {
    expect(canReachStep('email', null, false)).toBe(true);
    expect(canReachStep('address', cart(), false)).toBe(false); // no email yet
    expect(canReachStep('address', cart(), true)).toBe(true);
  });

  it('shipping requires a REAL (non-placeholder) shipping address', () => {
    const placeholder = cart({
      guestEmail: 'a@b.com',
      shippingAddress: { name: '—', line1: '—', city: '—', postalCode: '75001', country: 'FR' },
    });
    expect(canReachStep('shipping', placeholder, true)).toBe(false);
    const real = cart({
      shippingAddress: { name: 'Marie', line1: '12 Rue', city: 'Paris', postalCode: '75002', country: 'FR' }, // prettier-ignore
    });
    expect(canReachStep('shipping', real, true)).toBe(true);
  });

  it('review requires email + real address + a chosen shipping rate', () => {
    const ready = cart({
      shippingAddress: { name: 'Marie', line1: '12 Rue', city: 'Paris', postalCode: '75002', country: 'FR' }, // prettier-ignore
      shippingRateId: 'rate-1',
    });
    expect(canReachStep('review', ready, true)).toBe(true);
    // Missing a chosen rate → not reachable.
    expect(canReachStep('review', { ...ready, shippingRateId: null }, true)).toBe(false);
  });

  it('furthestReachableStep clamps to the prerequisites satisfied so far', () => {
    expect(furthestReachableStep(null, false)).toBe('email');
    expect(furthestReachableStep(cart(), true)).toBe('address'); // email done, no address yet
    const real = cart({
      shippingAddress: { name: 'Marie', line1: '12 Rue', city: 'Paris', postalCode: '75002', country: 'FR' }, // prettier-ignore
    });
    expect(furthestReachableStep(real, true)).toBe('shipping');
    // With email + a real address + a chosen rate, review AND payment are both reachable (they share
    // prerequisites), so the FURTHEST reachable step is now `payment` (the terminal step).
    expect(furthestReachableStep({ ...real, shippingRateId: 'rate-1' }, true)).toBe('payment');
  });

  it('CHECKOUT_STEPS / stepIndex give a stable order', () => {
    expect(CHECKOUT_STEPS).toEqual(['email', 'address', 'shipping', 'review', 'payment']);
    expect(stepIndex('email')).toBe(0);
    expect(stepIndex('review')).toBe(3);
    expect(stepIndex('payment')).toBe(4);
  });
});

describe('shouldShowReverseCharge (display only — server is authoritative)', () => {
  it('shows ONLY when the SERVER flagged reverseCharge for a VIES-validated B2B customer on a non-empty cart', () => {
    expect(
      shouldShowReverseCharge(
        { isB2b: true, vatValidated: true },
        cart({ totals: { ...cart().totals, taxTotal: 0, grandTotal: 1999, reverseCharge: true } }),
      ),
    ).toBe(true);
  });

  it('does NOT show for a non-B2B customer even if the server flagged reverseCharge', () => {
    expect(
      shouldShowReverseCharge(
        { isB2b: false, vatValidated: false },
        cart({ totals: { ...cart().totals, taxTotal: 0, reverseCharge: true } }),
      ),
    ).toBe(false);
  });

  it('does NOT show for a B2B customer whose VAT is not yet VIES-validated', () => {
    expect(
      shouldShowReverseCharge(
        { isB2b: true, vatValidated: false },
        cart({ totals: { ...cart().totals, taxTotal: 0, reverseCharge: true } }),
      ),
    ).toBe(false);
  });

  it('does NOT show when the server is still charging tax (reverseCharge false) — never taxTotal math', () => {
    expect(shouldShowReverseCharge({ isB2b: true, vatValidated: true }, cart())).toBe(false);
  });

  // ── The former FALSE-POSITIVE cases the MEDIUM fix targets (taxTotal===0 but NOT reverse charge) ──
  it('does NOT show on the `none` regime / no-destination / zero-rated / non-EU export (taxTotal 0, flag false)', () => {
    // Each of these legitimately yields taxTotal 0 WITHOUT reverse charge. The old `taxTotal === 0`
    // inference wrongly showed the note; reading the server flag fixes it.
    expect(
      shouldShowReverseCharge(
        { isB2b: true, vatValidated: true },
        cart({ totals: { ...cart().totals, taxTotal: 0, grandTotal: 1999, reverseCharge: false } }),
      ),
    ).toBe(false);
  });

  it('does NOT show for a guest (null customer) or an empty cart', () => {
    expect(shouldShowReverseCharge(null, cart())).toBe(false);
    expect(
      shouldShowReverseCharge({ isB2b: true, vatValidated: true }, cart({ items: [], totals: { ...cart().totals, taxTotal: 0, reverseCharge: true } })), // prettier-ignore
    ).toBe(false);
  });
});
