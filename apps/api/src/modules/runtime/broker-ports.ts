/**
 * broker read PORTS.
 *
 * the DTO TYPES the ports return were EXTRACTED into
 * `@sovecom/module-sdk` (the single source of truth — the dependency direction is now reversed).
 * They are re-exported here so the in-tree port/adapter importers keep their `./broker-ports`
 * import path. The PORTS themselves are a core-side abstraction (they carry `tenantId`, supplied
 * by the broker, never by the module) and stay here — they are not part of the public SDK.
 *
 * The broker NEVER hands a module a Drizzle/pg handle. It depends on these narrow, read-only
 * ports, each tenant-scoped. Production adapters bridge these ports to the real
 * catalog/orders/customers services; unit tests use fakes.
 *
 * The DTO TYPES are the privacy boundary: e.g. {@link ModuleCustomerDto} has no email/phone/
 * address/VAT fields, so `read:customers` is field-limited by construction.
 */
import type {
  ListQuery,
  ListResult,
  ModuleProductDto,
  ModuleProductCategory,
  ModuleCategoryDto,
  ModuleOrderDto,
  ModuleCustomerDto,
} from '@sovecom/module-sdk';

export type {
  ListQuery,
  ListResult,
  ModuleProductDto,
  ModuleProductCategory,
  ModuleCategoryDto,
  ModuleOrderDto,
  ModuleCustomerDto,
};

// ── ports (read-only, tenant-scoped) ────────────────────────────────────────────

export interface ProductReadPort {
  list(tenantId: string, query: ListQuery): Promise<ListResult<ModuleProductDto>>;
  get(tenantId: string, id: string): Promise<ModuleProductDto | null>;
}
export interface CategoryReadPort {
  list(tenantId: string, query: ListQuery): Promise<ListResult<ModuleCategoryDto>>;
  get(tenantId: string, id: string): Promise<ModuleCategoryDto | null>;
}
export interface OrderReadPort {
  list(tenantId: string, query: ListQuery): Promise<ListResult<ModuleOrderDto>>;
  get(tenantId: string, id: string): Promise<ModuleOrderDto | null>;
}
export interface CustomerReadPort {
  list(tenantId: string, query: ListQuery): Promise<ListResult<ModuleCustomerDto>>;
  get(tenantId: string, id: string): Promise<ModuleCustomerDto | null>;
}

/**
 * Narrow commerce read port (follow-up B1). The boolean-only purchase probe behind `read:orders`.
 * `tenantId` is supplied by the broker (never the module); `customerId`/`productId` are opaque,
 * bound query params. Returns ONLY a boolean — no order data crosses the port (least-privilege).
 */
export interface CommerceReadPort {
  hasPurchased(tenantId: string, customerId: string, productId: string): Promise<boolean>;
}

export interface BrokerReadPorts {
  readonly products: ProductReadPort;
  readonly categories: CategoryReadPort;
  readonly orders: OrderReadPort;
  readonly customers: CustomerReadPort;
  readonly commerce: CommerceReadPort;
}
