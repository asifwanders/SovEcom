/**
 * VariantsService.
 *
 * Manages variant CRUD on a product. Enforces publish guard on price changes.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditService } from '../../audit/audit.service';
import { ProductsRepository } from '../products/products.repository';
import { VariantsRepository } from './variants.repository';
import { ProductUpdatedEvent } from '../events/product-updated.event';
import { ProductPriceChangedEvent } from '../events/product-price-changed.event';
import { ProductStockChangedEvent } from '../events/product-stock-changed.event';
import { variantAvailable } from '../../inventory/availability';
import { assertPublishGuard } from '../products/products.service';
import type { CreateVariantDto } from './dto/create-variant.dto';
import type { UpdateVariantDto } from './dto/update-variant.dto';
import type { ProductVariant } from '../../database/schema/product_variants';

@Injectable()
export class VariantsService {
  private readonly logger = new Logger(VariantsService.name);

  constructor(
    private readonly products: ProductsRepository,
    private readonly variants: VariantsRepository,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    productId: string,
    dto: CreateVariantDto,
    ip?: string,
    userAgent?: string,
  ): Promise<ProductVariant> {
    const product = await this.products.findById(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    // Single-currency-per-product: a new variant must match the currency of
    // the product's EXISTING variants. A mixed-currency product breaks line-item
    // summing, so reject it here with a clear 4xx.
    const newCurrency = dto.currency.toUpperCase();
    const existingCurrency = product.variants[0]?.currency;
    if (existingCurrency != null && existingCurrency !== newCurrency) {
      throw new UnprocessableEntityException(
        `Variant currency ${newCurrency} does not match the product's currency ${existingCurrency} — all variants of a product must share one currency`,
      );
    }

    let sku = dto.sku ?? `${productId.slice(-8)}-${uuidv7().slice(-6)}`;
    if (await this.variants.skuExists(tenantId, sku)) {
      sku = `${sku}-${uuidv7().slice(-6)}`;
    }

    // If product is published and new variant is 0-price non-free, reject.
    if (product.status === 'published') {
      const newVariantInput = { priceAmount: dto.priceAmount, options: dto.options ?? {} };
      assertPublishGuard([newVariantInput]);
    }

    const variant = await this.variants.insert({
      id: uuidv7(),
      tenantId,
      productId,
      sku,
      title: dto.title ?? null,
      options: dto.options ?? {},
      priceAmount: dto.priceAmount,
      currency: dto.currency.toUpperCase(),
      compareAtAmount: dto.compareAtAmount ?? null,
      stockQuantity: dto.stockQuantity ?? 0,
      allowBackorder: dto.allowBackorder ?? false,
      weightGrams: dto.weightGrams ?? null,
      lengthMm: dto.lengthMm ?? null,
      widthMm: dto.widthMm ?? null,
      heightMm: dto.heightMm ?? null,
      position: dto.position ?? 0,
    });

    this.events.emit(
      ProductUpdatedEvent.EVENT,
      new ProductUpdatedEvent(tenantId, productId, { variantAdded: variant.id }),
    );

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'variant.created',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { variantId: variant.id, sku },
    });

    return variant;
  }

  async update(
    tenantId: string,
    actorId: string,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
    ip?: string,
    userAgent?: string,
  ): Promise<ProductVariant> {
    const product = await this.products.findById(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    const existing = await this.variants.findById(tenantId, variantId);
    if (!existing || existing.productId !== productId) {
      throw new NotFoundException(`Variant ${variantId} not found on product ${productId}`);
    }

    // The "free" escape lives in options.free, and options can be patched alone.
    // So run the publish guard whenever EITHER price OR options changes,
    // using the effective (post-patch) values. Otherwise a PATCH {options:{}}
    // on a free 0-price variant would silently leave a published product with
    // a 0-price non-free variant.
    if (
      product.status === 'published' &&
      (dto.priceAmount !== undefined || dto.options !== undefined)
    ) {
      const effectivePrice = dto.priceAmount ?? existing.priceAmount;
      const effectiveOptions = dto.options ?? existing.options;
      const otherVariants = product.variants.filter((v) => v.id !== variantId);
      const updatedVariant = {
        priceAmount: effectivePrice,
        options: effectiveOptions,
      };
      assertPublishGuard([...otherVariants, updatedVariant]);
    }

    // Single-currency-per-product: changing this variant's currency must not
    // diverge from the product's other variants. Compare against any sibling
    // (they are already invariant-enforced to share one currency).
    if (dto.currency !== undefined) {
      const newCurrency = dto.currency.toUpperCase();
      const sibling = product.variants.find((v) => v.id !== variantId);
      if (sibling != null && sibling.currency !== newCurrency) {
        throw new UnprocessableEntityException(
          `Variant currency ${newCurrency} does not match the product's currency ${sibling.currency} — all variants of a product must share one currency`,
        );
      }
    }

    // Validate SKU uniqueness if changing.
    if (dto.sku && dto.sku !== existing.sku) {
      if (await this.variants.skuExists(tenantId, dto.sku, variantId)) {
        throw new UnprocessableEntityException(`SKU '${dto.sku}' already exists in this tenant`);
      }
    }

    const updated = await this.variants.update(tenantId, variantId, {
      ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.options !== undefined ? { options: dto.options } : {}),
      ...(dto.priceAmount !== undefined ? { priceAmount: dto.priceAmount } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency.toUpperCase() } : {}),
      ...(dto.compareAtAmount !== undefined ? { compareAtAmount: dto.compareAtAmount } : {}),
      ...(dto.stockQuantity !== undefined ? { stockQuantity: dto.stockQuantity } : {}),
      ...(dto.allowBackorder !== undefined ? { allowBackorder: dto.allowBackorder } : {}),
      ...(dto.weightGrams !== undefined ? { weightGrams: dto.weightGrams } : {}),
      ...(dto.lengthMm !== undefined ? { lengthMm: dto.lengthMm } : {}),
      ...(dto.widthMm !== undefined ? { widthMm: dto.widthMm } : {}),
      ...(dto.heightMm !== undefined ? { heightMm: dto.heightMm } : {}),
      ...(dto.position !== undefined ? { position: dto.position } : {}),
    });

    if (!updated) throw new NotFoundException(`Variant ${variantId} not found`);

    this.events.emit(
      ProductUpdatedEvent.EVENT,
      new ProductUpdatedEvent(tenantId, productId, { variantUpdated: variantId }),
    );

    // Follow-up B2 — observational commerce events. The variant update ALREADY committed; these
    // emits are best-effort side-effects, so a bus-dispatch error must NEVER turn a committed admin
    // edit into a 500 — swallow + log (matching OrderRestockListener). A subscribed module only
    // observes; it never enters this path.
    this.emitCommerceEventsForUpdate(tenantId, productId, variantId, dto, existing, updated);

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'variant.updated',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { variantId, ...dto },
    });

    return updated;
  }

  /**
   * Follow-up B2 — emit the observational commerce events for a COMMITTED variant update.
   * Post-write + best-effort: the whole block is try/caught so a bus-dispatch error can never turn
   * an already-committed admin edit into a 500. Modules only observe.
   *
   *  - `product.price_changed` ONLY on a REAL price change (old !== new) — carries old+new minor
   *    units (public catalog data); a no-op price PATCH emits nothing.
   *  - `product.stock_changed` ONLY when availability FLIPS across zero, for EITHER reason: a stock
   *    change crossing zero OR an `allowBackorder` toggle that flips a 0-stock variant between
   *    out-of-stock and buyable (NIT 1). Availability = `stock>0 || allowBackorder` (PHYSICAL
   *    stock), so a 5→3 change emits nothing. Boolean ONLY — the exact level is never exposed.
   */
  private emitCommerceEventsForUpdate(
    tenantId: string,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
    existing: ProductVariant,
    updated: ProductVariant,
  ): void {
    try {
      if (dto.priceAmount !== undefined && updated.priceAmount !== existing.priceAmount) {
        this.events.emit(
          ProductPriceChangedEvent.EVENT,
          new ProductPriceChangedEvent(
            tenantId,
            productId,
            variantId,
            existing.priceAmount,
            updated.priceAmount,
            updated.currency,
          ),
        );
      }

      // A stock OR backorder change can flip availability; compute the flip from BOTH dimensions
      // (availability = stock>0 OR backorder), so a backorder toggle on a 0-stock variant fires too.
      if (dto.stockQuantity !== undefined || dto.allowBackorder !== undefined) {
        const wasAvailable = variantAvailable(existing.stockQuantity, existing.allowBackorder);
        const nowAvailable = variantAvailable(updated.stockQuantity, updated.allowBackorder);
        if (wasAvailable !== nowAvailable) {
          this.events.emit(
            ProductStockChangedEvent.EVENT,
            new ProductStockChangedEvent(tenantId, productId, variantId, nowAvailable),
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `B2 commerce-event emit failed for variant ${variantId} (update already committed)`,
        err,
      );
    }
  }

  async delete(
    tenantId: string,
    actorId: string,
    productId: string,
    variantId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const product = await this.products.findById(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    const existing = await this.variants.findById(tenantId, variantId);
    if (!existing || existing.productId !== productId) {
      throw new NotFoundException(`Variant ${variantId} not found on product ${productId}`);
    }

    // F2: a PUBLISHED product must always have at least one variant — a 0-variant
    // published product has no price and is unbuyable. Block deleting the last
    // one; the admin must archive/unpublish the product first.
    if (product.status === 'published' && product.variants.length <= 1) {
      throw new UnprocessableEntityException(
        'Cannot delete the last variant of a published product — archive or unpublish it first.',
      );
    }

    const deleted = await this.variants.delete(tenantId, variantId);
    if (!deleted) throw new NotFoundException(`Variant ${variantId} not found`);

    this.events.emit(
      ProductUpdatedEvent.EVENT,
      new ProductUpdatedEvent(tenantId, productId, { variantDeleted: variantId }),
    );

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'variant.deleted',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { variantId },
    });
  }

  async reorder(
    tenantId: string,
    actorId: string,
    productId: string,
    order: string[],
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const product = await this.products.findById(tenantId, productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    // F4: every id in the payload must belong to THIS product. Without this an
    // attacker could reorder another product's variants via a wrong :id URL
    // (the bare (id, tenantId) update touched any variant in the tenant).
    const ownIds = new Set(product.variants.map((v) => v.id));
    for (const variantId of order) {
      if (!ownIds.has(variantId)) {
        throw new NotFoundException(`Variant ${variantId} not found on product ${productId}`);
      }
    }

    let pos = 0;
    for (const variantId of order) {
      await this.variants.updateScoped(tenantId, productId, variantId, { position: pos });
      pos++;
    }

    // F8: reorder is a mutation — audit it.
    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'variant.reordered',
      resourceType: 'product',
      resourceId: productId,
      ip,
      userAgent,
      changes: { order },
    });
  }
}
