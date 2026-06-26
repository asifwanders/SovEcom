/**
 * the broker read-port DTOs, EXTRACTED here as the single
 * source of truth. These were defined in `apps/api/src/modules/runtime/broker-ports.ts`; the
 * dependency direction is now reversed (apps/api imports them from this package), so the
 * published SDK contract can never drift from what the core broker returns.
 *
 * The DTO TYPES are the privacy boundary: e.g. {@link ModuleCustomerDto} has no email/phone/
 * address/VAT fields, so `read:customers` is field-limited by construction.
 */

/** Cursor/limit list query a module may pass (the broker validates + bounds it). */
export interface ListQuery {
  readonly limit: number;
  readonly cursor?: string;
}

export interface ListResult<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/**
 * READ-ONLY product→category metadata on {@link ModuleProductDto} (follow-up B1). A product's
 * PRIMARY category (the lowest-`position`, id-tiebroken row of its `product_categories` links),
 * projected to the same `{ id, slug, name }` shape as {@link ModuleCategoryDto}. It rides the
 * EXISTING `read:products` grant (no new permission — it is catalog metadata, never PII) and is
 * `undefined` when the product has no category. Lets a module filter/exclude by category without a
 * separate product→category port.
 */
export interface ModuleProductCategory {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface ModuleProductDto {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  /** The product's primary category (read-only; omitted/undefined when it has none). */
  readonly category?: ModuleProductCategory;
}

export interface ModuleCategoryDto {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface ModuleOrderDto {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly createdAt: string;
}

/**
 * FIELD-LIMITED customer projection. Deliberately carries NO email, phone,
 * address, or VAT — `read:customers` must not hand modules raw PII. Widening requires a future
 * explicit PII sub-permission with its own DTO/port.
 */
export interface ModuleCustomerDto {
  readonly id: string;
  readonly displayName: string;
  readonly locale: string | null;
  readonly createdAt: string;
}
