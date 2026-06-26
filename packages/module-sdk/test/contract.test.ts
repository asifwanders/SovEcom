/**
 * `@sovecom/module-sdk` — contract surface tests for follow-up B1:
 *   - `ModuleProductDto.category` (read-only `{ id, slug, name }`, optional);
 *   - `sdk.commerce.hasPurchased(customerId, productId) → Promise<boolean>`.
 *
 * These are PURE TYPES with no runtime, so the assertions are compile-time `satisfies`/assignability
 * checks plus a runtime shape check against a hand-built object that conforms to the interface. If a
 * field or method signature drifts, this file fails `tsc`/vitest typecheck.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ModuleProductDto,
  ModuleProductCategory,
  CommerceClient,
  ModuleSdk,
  ProductPriceChangedPayload,
  ProductStockChangedPayload,
  EmailClient,
  ModuleCustomerEmailMessage,
  ModuleEmailSendResult,
} from '../src/index.js';

describe('ModuleProductDto.category (B1)', () => {
  it('a product MAY carry a primary category of { id, slug, name }', () => {
    const withCategory: ModuleProductDto = {
      id: 'p1',
      slug: 'pen',
      title: 'Pen',
      status: 'published',
      category: { id: 'cat-1', slug: 'stationery', name: 'Stationery' },
    };
    expect(withCategory.category).toEqual({
      id: 'cat-1',
      slug: 'stationery',
      name: 'Stationery',
    });
    expectTypeOf(withCategory.category).toEqualTypeOf<ModuleProductCategory | undefined>();
  });

  it('category is OPTIONAL — a product with none simply omits it (undefined)', () => {
    const noCategory: ModuleProductDto = { id: 'p2', slug: 'mug', title: 'Mug', status: 'draft' };
    expect(noCategory.category).toBeUndefined();
  });

  it('the category projection carries id/slug/name and nothing PII-shaped', () => {
    const cat: ModuleProductCategory = { id: 'k', slug: 's', name: 'n' };
    expect(Object.keys(cat).sort()).toEqual(['id', 'name', 'slug']);
  });
});

describe('sdk.commerce.hasPurchased contract (B1)', () => {
  it('CommerceClient.hasPurchased takes (customerId, productId) and resolves a boolean', () => {
    const commerce: CommerceClient = {
      hasPurchased: (customerId: string, productId: string) =>
        Promise.resolve(customerId.length > 0 && productId.length > 0),
    };
    expectTypeOf(commerce.hasPurchased).toEqualTypeOf<
      (customerId: string, productId: string) => Promise<boolean>
    >();
  });

  it('resolves to a bare boolean — never order data', async () => {
    const commerce: CommerceClient = { hasPurchased: () => Promise.resolve(true) };
    const verdict = await commerce.hasPurchased('cust-1', 'prod-1');
    expect(typeof verdict).toBe('boolean');
  });

  it('ModuleSdk exposes the commerce client', () => {
    expectTypeOf<ModuleSdk['commerce']>().toEqualTypeOf<CommerceClient>();
  });
});

describe('observational commerce event payloads (B2)', () => {
  it('product.price_changed carries eventId + old/new minor units + currency (public catalog data)', () => {
    const payload: ProductPriceChangedPayload = {
      eventId: 'evt-1',
      productId: 'p1',
      variantId: 'v1',
      oldPriceMinor: 1999,
      newPriceMinor: 1499,
      currency: 'EUR',
    };
    expect(Object.keys(payload).sort()).toEqual([
      'currency',
      'eventId',
      'newPriceMinor',
      'oldPriceMinor',
      'productId',
      'variantId',
    ]);
    expectTypeOf(payload.eventId).toEqualTypeOf<string>();
    expectTypeOf(payload.oldPriceMinor).toEqualTypeOf<number>();
    expectTypeOf(payload.newPriceMinor).toEqualTypeOf<number>();
  });

  it('product.stock_changed carries eventId + a back-in-stock BOOLEAN ONLY — never a level/quantity', () => {
    const available: ProductStockChangedPayload = {
      eventId: 'evt-2',
      productId: 'p1',
      variantId: 'v1',
      available: true,
    };
    // The contract has exactly these four keys; no stock level / quantity is exposed.
    expect(Object.keys(available).sort()).toEqual([
      'available',
      'eventId',
      'productId',
      'variantId',
    ]);
    expectTypeOf(available.eventId).toEqualTypeOf<string>();
    expectTypeOf(available.available).toEqualTypeOf<boolean>();
    // @ts-expect-error — the payload type has NO stockQuantity / quantity field (competitive leak).
    const _leak: number = available.stockQuantity;
    void _leak;
  });
});

describe('sdk.email.sendToCustomer contract (B3)', () => {
  it('EmailClient.sendToCustomer takes a ModuleCustomerEmailMessage and resolves a send result', () => {
    const email: EmailClient = {
      send: () => Promise.resolve({ queued: true }),
      sendToCustomer: (msg: ModuleCustomerEmailMessage) =>
        Promise.resolve({ queued: msg.customerId.length > 0 }),
    };
    expectTypeOf(email.sendToCustomer).toEqualTypeOf<
      (message: ModuleCustomerEmailMessage) => Promise<ModuleEmailSendResult>
    >();
  });

  it('ModuleCustomerEmailMessage carries customerId/subject/text/html and NO `to` field', () => {
    const msg: ModuleCustomerEmailMessage = {
      customerId: 'cust-1',
      subject: 'Price drop on your wishlist',
      text: 'An item dropped in price.',
      html: '<p>An item dropped in price.</p>',
    };
    // The contract has exactly these keys — there is NO `to` address (the module supplies none).
    expect(Object.keys(msg).sort()).toEqual(['customerId', 'html', 'subject', 'text']);
    // @ts-expect-error — there is deliberately NO `to` field on the customer-email message.
    const _addr: string = msg.to;
    void _addr;
  });

  it('html is OPTIONAL — a plaintext-only message simply omits it', () => {
    const msg: ModuleCustomerEmailMessage = {
      customerId: 'cust-2',
      subject: 'Hi',
      text: 'Body',
    };
    expect(msg.html).toBeUndefined();
  });

  it('the send RESULT is queued:boolean — suppression (queued:false) is expressible', () => {
    const sent: ModuleEmailSendResult = { queued: true };
    const suppressed: ModuleEmailSendResult = { queued: false };
    expect(sent.queued).toBe(true);
    expect(suppressed.queued).toBe(false);
    expectTypeOf<ModuleEmailSendResult['queued']>().toEqualTypeOf<boolean>();
  });

  it('ModuleSdk exposes an email client with BOTH send and sendToCustomer', () => {
    expectTypeOf<ModuleSdk['email']>().toEqualTypeOf<EmailClient>();
    expectTypeOf<ModuleSdk['email']['sendToCustomer']>().toEqualTypeOf<
      (message: ModuleCustomerEmailMessage) => Promise<ModuleEmailSendResult>
    >();
  });
});
