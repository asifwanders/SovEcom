/**
 * Message-catalog parity guard — ensures no untranslated strings.
 *
 * EN and FR must expose the exact same set of keys (recursively): a key present in one but missing
 * in the other means a string ships untranslated (renders the fallback/key) for a visitor in that
 * locale. This test is the structural guard that ensures it fails on any added/removed/renamed key
 * that is not mirrored in both catalogs.
 *
 * NOTE: this guard lives under `src/` because the Vitest config collects only
 * `src/**` (see vitest.config.ts `include`). An earlier copy at `messages/messages.spec.ts` was never
 * collected by that include, so it ran zero assertions; this is the single live parity spec.
 */
import { describe, it, expect } from 'vitest';
import en from '../messages/en.json';
import fr from '../messages/fr.json';

/** Recursively collect dotted key paths from a nested message object. */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? keyPaths(v as Record<string, unknown>, path)
      : [path];
  });
}

describe('storefront message catalogs', () => {
  it('EN and FR expose the identical set of keys (no untranslated strings)', () => {
    const enKeys = keyPaths(en).sort();
    const frKeys = keyPaths(fr).sort();
    expect(frKeys).toEqual(enKeys);
  });

  it('includes the Chunk-C cart + product add-to-cart keys in both locales', () => {
    const enKeys = new Set(keyPaths(en));
    const frKeys = new Set(keyPaths(fr));
    for (const key of [
      'cart.openCart',
      'product.addToCart',
      'product.adding',
      'product.added',
      'product.addError',
      'product.chooseOptions',
      'product.selectOptionCta',
    ]) {
      expect(enKeys.has(key), `EN missing ${key}`).toBe(true);
      expect(frKeys.has(key), `FR missing ${key}`).toBe(true);
    }
  });

  it('includes the Chunk-D cart drawer/page/discount/shipping keys in both locales', () => {
    const enKeys = new Set(keyPaths(en));
    const frKeys = new Set(keyPaths(fr));
    for (const key of [
      'cart.unitTimesQty',
      'cart.increase',
      'cart.decrease',
      'cart.removeItem',
      'cart.totals.subtotal',
      'cart.totals.grandTotal',
      'cart.discount.label',
      'cart.discount.invalid',
      'cart.shipping.heading',
      'cart.shipping.none',
      'cart.drawer.title',
      'cart.drawer.viewCart',
      'cart.drawer.checkout',
      'cart.page.title',
      'cart.page.summary',
    ]) {
      expect(enKeys.has(key), `EN missing ${key}`).toBe(true);
      expect(frKeys.has(key), `FR missing ${key}`).toBe(true);
    }
  });

  it('includes the Chunk-E checkout step/email/address/shipping/vat/review keys in both locales', () => {
    const enKeys = new Set(keyPaths(en));
    const frKeys = new Set(keyPaths(fr));
    for (const key of [
      'checkout.title',
      'checkout.continue',
      'checkout.back',
      'checkout.steps.email',
      'checkout.steps.address',
      'checkout.steps.shipping',
      'checkout.steps.review',
      'checkout.email.label',
      'checkout.email.loginLink',
      'checkout.address.shippingLegend',
      'checkout.address.billingSame',
      'checkout.address.country',
      'checkout.address.errors.name',
      'checkout.address.errors.country',
      'checkout.shipping.ratesLabel',
      'checkout.shipping.none',
      'checkout.vat.label',
      'checkout.vat.reverseCharge',
      'checkout.review.proceedToPayment',
      'checkout.review.shippingTo',
      'checkout.review.method',
    ]) {
      expect(enKeys.has(key), `EN missing ${key}`).toBe(true);
      expect(frKeys.has(key), `FR missing ${key}`).toBe(true);
    }
  });

  it('includes the Chunk-C invoice-download keys in both locales', () => {
    const enKeys = new Set(keyPaths(en));
    const frKeys = new Set(keyPaths(fr));
    for (const key of [
      'account.orders.downloadInvoice',
      'account.orders.downloadingInvoice',
      'account.orders.invoiceUnavailable',
      'account.orders.invoiceDownloadError',
    ]) {
      expect(enKeys.has(key), `EN missing ${key}`).toBe(true);
      expect(frKeys.has(key), `FR missing ${key}`).toBe(true);
    }
  });

  it('includes the Chunk-F returns keys in both locales', () => {
    const enKeys = new Set(keyPaths(en));
    const frKeys = new Set(keyPaths(fr));
    for (const key of [
      'account.orders.requestReturn',
      'account.returns.title',
      'account.returns.typeLabel',
      'account.returns.typeReturn',
      'account.returns.typeWithdrawal',
      'account.returns.selectItemsLegend',
      'account.returns.quantityLabel',
      'account.returns.reasonLabel',
      'account.returns.withdrawalInfo',
      'account.returns.learnMore',
      'account.returns.submit',
      'account.returns.submitting',
      'account.returns.successHeading',
      'account.returns.withinWindowYes',
      'account.returns.withinWindowNo',
      'account.returns.notEligible',
      'account.returns.existingReturnsHeading',
      'account.returns.status_requested',
      'account.returns.status_approved',
      'account.returns.status_rejected',
      'account.returns.status_refunded',
      'account.returns.errorOverQuantity',
      'account.returns.saveError',
      'account.returns.backToOrder',
    ]) {
      expect(enKeys.has(key), `EN missing ${key}`).toBe(true);
      expect(frKeys.has(key), `FR missing ${key}`).toBe(true);
    }
  });

  it('includes the Chunk-G RGPD export/erase keys in both locales', () => {
    const enKeys = new Set(keyPaths(en));
    const frKeys = new Set(keyPaths(fr));
    for (const key of [
      'account.rgpd.heading',
      'account.rgpd.stepUpFailed',
      'account.rgpd.export.heading',
      'account.rgpd.export.description',
      'account.rgpd.export.passwordLabel',
      'account.rgpd.export.button',
      'account.rgpd.export.exporting',
      'account.rgpd.export.success',
      'account.rgpd.export.error',
      'account.rgpd.erase.heading',
      'account.rgpd.erase.description',
      'account.rgpd.erase.legalRetentionNote',
      'account.rgpd.erase.confirmEmailLabel',
      'account.rgpd.erase.confirmEmailMismatch',
      'account.rgpd.erase.passwordLabel',
      'account.rgpd.erase.button',
      'account.rgpd.erase.deleteButton',
      'account.rgpd.erase.deleting',
      'account.rgpd.erase.success',
      'account.rgpd.erase.error',
    ]) {
      expect(enKeys.has(key), `EN missing ${key}`).toBe(true);
      expect(frKeys.has(key), `FR missing ${key}`).toBe(true);
    }
  });

  it('every leaf value is a non-empty string in both locales', () => {
    for (const [name, cat] of [
      ['en', en],
      ['fr', fr],
    ] as const) {
      for (const path of keyPaths(cat as Record<string, unknown>)) {
        const value = path
          .split('.')
          .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], cat);
        expect(typeof value, `${name}.${path}`).toBe('string');
        expect((value as string).length, `${name}.${path}`).toBeGreaterThan(0);
      }
    }
  });
});
