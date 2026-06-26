/**
 *hardening — single-currency-per-product.
 *
 * A product must never hold variants in different currencies (EUR + USD), which would
 * break once Phase-2 sums line items. Enforced at the DTO boundary (create-product
 * variants array) and in VariantsService.create/update for incremental variant edits.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { CreateProductSchema } from '../products/dto/create-product.dto';
import { VariantsService } from './variants.service';
import type { ProductsRepository } from '../products/products.repository';
import type { VariantsRepository } from './variants.repository';
import type { AuditService } from '../../audit/audit.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';

// ── DTO: variants array must share one currency ──────────────────────────────

describe('CreateProductSchema — single currency per product', () => {
  const baseVariant = {
    priceAmount: 1000,
    options: {},
    stockQuantity: 0,
    allowBackorder: false,
    position: 0,
  };

  it('rejects a product with mixed-currency variants', () => {
    const result = CreateProductSchema.safeParse({
      title: 'Tee',
      variants: [
        { ...baseVariant, currency: 'EUR' },
        { ...baseVariant, currency: 'USD' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a product whose variants share one currency', () => {
    const result = CreateProductSchema.safeParse({
      title: 'Tee',
      variants: [
        { ...baseVariant, currency: 'EUR' },
        { ...baseVariant, currency: 'eur' }, // lower-cased, normalised to EUR first
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a single-variant product (nothing to compare)', () => {
    const result = CreateProductSchema.safeParse({
      title: 'Tee',
      variants: [{ ...baseVariant, currency: 'EUR' }],
    });
    expect(result.success).toBe(true);
  });
});

// ── Service: incremental variant currency must match the product ─────────────

describe('VariantsService — single currency per product', () => {
  function makeService(productVariants: Array<{ id: string; currency: string }>) {
    const product = { id: 'p1', status: 'draft', variants: productVariants };
    const products = {
      findById: jest.fn().mockResolvedValue(product),
    } as unknown as ProductsRepository;
    const variants = {
      skuExists: jest.fn().mockResolvedValue(false),
      insert: jest.fn().mockResolvedValue({ id: 'v-new', currency: 'EUR' }),
      findById: jest.fn(),
      update: jest.fn(),
    } as unknown as VariantsRepository;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    return { service: new VariantsService(products, variants, audit, events), variants };
  }

  const createDto = { priceAmount: 1000, currency: 'USD', options: {} } as never;

  it('create: rejects a variant whose currency differs from the existing variants', async () => {
    const { service } = makeService([{ id: 'v1', currency: 'EUR' }]);
    await expect(service.create('t1', 'a1', 'p1', createDto)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('create: accepts a variant matching the existing currency', async () => {
    const { service } = makeService([{ id: 'v1', currency: 'USD' }]);
    await expect(service.create('t1', 'a1', 'p1', createDto)).resolves.toBeDefined();
  });

  it('create: accepts the first variant on a product with none yet', async () => {
    const { service } = makeService([]);
    await expect(service.create('t1', 'a1', 'p1', createDto)).resolves.toBeDefined();
  });

  it('update: rejects changing a variant currency to differ from its siblings', async () => {
    const { service, variants } = makeService([
      { id: 'v1', currency: 'EUR' },
      { id: 'v2', currency: 'EUR' },
    ]);
    (variants.findById as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      options: {},
    });
    await expect(
      service.update('t1', 'a1', 'p1', 'v1', { currency: 'USD' } as never),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('update: accepts changing a variant currency when it matches siblings', async () => {
    const { service, variants } = makeService([
      { id: 'v1', currency: 'EUR' },
      { id: 'v2', currency: 'EUR' },
    ]);
    (variants.findById as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      options: {},
    });
    (variants.update as jest.Mock).mockResolvedValue({ id: 'v1', currency: 'EUR' });
    await expect(
      service.update('t1', 'a1', 'p1', 'v1', { currency: 'EUR' } as never),
    ).resolves.toBeDefined();
  });
});

// ── Follow-up B2: VariantsService emits product.price_changed only on a REAL price change ──────

describe('VariantsService — product.price_changed emission', () => {
  function setup(existingPrice: number) {
    const existing = {
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: existingPrice,
      options: {},
    };
    const product = { id: 'p1', status: 'draft', variants: [existing] };
    const products = {
      findById: jest.fn().mockResolvedValue(product),
    } as unknown as ProductsRepository;
    const variants = {
      findById: jest.fn().mockResolvedValue(existing),
      skuExists: jest.fn().mockResolvedValue(false),
      update: jest.fn(),
    } as unknown as VariantsRepository;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const emit = jest.fn();
    const events = { emit } as unknown as EventEmitter2;
    return { service: new VariantsService(products, variants, audit, events), variants, emit };
  }

  /** Pull the product.price_changed payload from the emit mock, if any was emitted. */
  function priceChangedCalls(emit: jest.Mock): unknown[] {
    return emit.mock.calls.filter((c) => c[0] === 'product.price_changed').map((c) => c[1]);
  }

  it('emits product.price_changed with old/new minor units when the price actually changes', async () => {
    const { service, variants, emit } = setup(1000);
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 800,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { priceAmount: 800 } as never);
    const calls = priceChangedCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tenantId: 't1',
      productId: 'p1',
      variantId: 'v1',
      oldPriceMinor: 1000,
      newPriceMinor: 800,
      currency: 'EUR',
    });
  });

  it('does NOT emit when priceAmount is supplied but identical (a no-op price update)', async () => {
    const { service, variants, emit } = setup(1000);
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { priceAmount: 1000 } as never);
    expect(priceChangedCalls(emit)).toHaveLength(0);
  });

  it('does NOT emit when the update touches only non-price fields', async () => {
    const { service, variants, emit } = setup(1000);
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { title: 'New title' } as never);
    expect(priceChangedCalls(emit)).toHaveLength(0);
  });
});

// ── Follow-up B2: VariantsService emits product.stock_changed only on an AVAILABILITY flip ─────

describe('VariantsService — product.stock_changed emission (admin path)', () => {
  function setup(existing: { stockQuantity: number; allowBackorder?: boolean }) {
    const existingRow = {
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      options: {},
      stockQuantity: existing.stockQuantity,
      allowBackorder: existing.allowBackorder ?? false,
    };
    const product = { id: 'p1', status: 'draft', variants: [existingRow] };
    const products = {
      findById: jest.fn().mockResolvedValue(product),
    } as unknown as ProductsRepository;
    const variants = {
      findById: jest.fn().mockResolvedValue(existingRow),
      skuExists: jest.fn().mockResolvedValue(false),
      update: jest.fn(),
    } as unknown as VariantsRepository;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const emit = jest.fn();
    const events = { emit } as unknown as EventEmitter2;
    return { service: new VariantsService(products, variants, audit, events), variants, emit };
  }

  function stockChangedCalls(emit: jest.Mock): Array<{ available: boolean }> {
    return emit.mock.calls
      .filter((c) => c[0] === 'product.stock_changed')
      .map((c) => c[1] as { available: boolean });
  }

  it('emits available:true when stock goes 0 → positive (restock flip)', async () => {
    const { service, variants, emit } = setup({ stockQuantity: 0 });
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      stockQuantity: 5,
      allowBackorder: false,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { stockQuantity: 5 } as never);
    const calls = stockChangedCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenantId: 't1', variantId: 'v1', available: true });
    // The payload must NOT carry a stock level / quantity.
    expect(calls[0]).not.toHaveProperty('stockQuantity');
    expect(calls[0]).not.toHaveProperty('quantity');
  });

  it('emits available:false when stock goes positive → 0 (depletion flip)', async () => {
    const { service, variants, emit } = setup({ stockQuantity: 3 });
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      stockQuantity: 0,
      allowBackorder: false,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { stockQuantity: 0 } as never);
    const calls = stockChangedCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ available: false });
  });

  it('does NOT emit when stock changes without crossing zero (5 → 3)', async () => {
    const { service, variants, emit } = setup({ stockQuantity: 5 });
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      stockQuantity: 3,
      allowBackorder: false,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { stockQuantity: 3 } as never);
    expect(stockChangedCalls(emit)).toHaveLength(0);
  });

  it('does NOT emit for a backorder variant (always available — no flip across zero)', async () => {
    const { service, variants, emit } = setup({ stockQuantity: 0, allowBackorder: true });
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      stockQuantity: 5,
      allowBackorder: true,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { stockQuantity: 5 } as never);
    expect(stockChangedCalls(emit)).toHaveLength(0);
  });

  it('does NOT emit when stockQuantity is not part of the update', async () => {
    const { service, variants, emit } = setup({ stockQuantity: 0 });
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1200,
      stockQuantity: 0,
      allowBackorder: false,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { priceAmount: 1200 } as never);
    expect(stockChangedCalls(emit)).toHaveLength(0);
  });

  it('NIT 1: an allowBackorder false→true PATCH on a 0-stock variant emits available:true', async () => {
    // OOS (stock 0, no backorder) → buyable (backorder on) flips availability with NO stock change.
    const { service, variants, emit } = setup({ stockQuantity: 0, allowBackorder: false });
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      stockQuantity: 0,
      allowBackorder: true,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { allowBackorder: true } as never);
    const calls = stockChangedCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ variantId: 'v1', available: true });
  });

  it('NIT 1: an allowBackorder true→false PATCH on a 0-stock variant emits available:false', async () => {
    const { service, variants, emit } = setup({ stockQuantity: 0, allowBackorder: true });
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      stockQuantity: 0,
      allowBackorder: false,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { allowBackorder: false } as never);
    const calls = stockChangedCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ available: false });
  });

  it('NIT 1: a backorder toggle on a POSITIVE-stock variant does NOT flip (stays available)', async () => {
    const { service, variants, emit } = setup({ stockQuantity: 5, allowBackorder: false });
    (variants.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      productId: 'p1',
      currency: 'EUR',
      priceAmount: 1000,
      stockQuantity: 5,
      allowBackorder: true,
    });
    await service.update('t1', 'a1', 'p1', 'v1', { allowBackorder: true } as never);
    expect(stockChangedCalls(emit)).toHaveLength(0);
  });
});
