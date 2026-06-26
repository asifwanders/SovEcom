/**
 * the {@link ModuleSdk} capability contract, EXTRACTED here
 * as the single source of truth (was `apps/api/src/modules/runtime/worker-sdk.ts`). These are
 * PURE TYPES: no `RpcPeer`, no runtime, no DB/pg handle. The capability object is what core hands
 * a module's `activate(sdk)`; each method maps 1:1 onto ONE gated broker RPC. ALL permission /
 * tenant / refusal enforcement lives in the core-side broker — a module cannot weaken it.
 *
 * apps/api's in-tree `createModuleSdk(peer)` IMPLEMENTS this interface and a compile-time
 * conformance check (`*.type-test.ts`) guards that the broker never drifts from this contract.
 */
import type {
  ListQuery,
  ListResult,
  ModuleProductDto,
  ModuleCategoryDto,
  ModuleOrderDto,
  ModuleCustomerDto,
} from './dto.js';
import type { ModuleHttpHandler } from './http.js';
import type {
  ModuleEmailMessage,
  ModuleCustomerEmailMessage,
  ModuleEmailSendResult,
} from './email.js';

/** Storefront-facing read surface (catalog). Gated by `read:products` / `read:categories`. */
export interface StoreClient {
  products: {
    list(query?: Partial<ListQuery>): Promise<ListResult<ModuleProductDto>>;
    get(id: string): Promise<ModuleProductDto | null>;
  };
  categories: {
    list(query?: Partial<ListQuery>): Promise<ListResult<ModuleCategoryDto>>;
    get(id: string): Promise<ModuleCategoryDto | null>;
  };
}

/** Admin-facing read surface. Gated by `read:orders` / `read:customers` (customer = field-limited). */
export interface AdminClient {
  orders: {
    list(query?: Partial<ListQuery>): Promise<ListResult<ModuleOrderDto>>;
    get(id: string): Promise<ModuleOrderDto | null>;
  };
  customers: {
    list(query?: Partial<ListQuery>): Promise<ListResult<ModuleCustomerDto>>;
    get(id: string): Promise<ModuleCustomerDto | null>;
  };
}

/**
 * Narrow commerce read surface (follow-up B1). Gated by the EXISTING `read:orders` permission
 * (default-deny: FORBIDDEN without it). It deliberately returns ONLY a boolean verdict — never order
 * rows — so a module can ASK "did this customer buy this product?" without being handed any order
 * details (least-privilege). The query is tenant-scoped from the broker context (never module
 * input) and runs against paid/fulfilled orders only.
 */
export interface CommerceClient {
  /**
   * @returns `true` iff the tenant has a paid (or later: fulfilled/shipped/…) order for
   *          `customerId` that contains `productId`. Both ids are opaque, bound params. A bare
   *          boolean — no order data crosses the boundary.
   */
  hasPurchased(customerId: string, productId: string): Promise<boolean>;
}

/** Outbound HTTP (gated by `http:outbound`; mediated + SSRF-guarded in core). */
export interface HttpClient {
  fetch(request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
}

/** Module's OWN tables (gated by `write:own_tables`). Parameterized SQL against its own schema. */
export interface TablesClient {
  /** Run a SELECT (or any returning statement); resolves the rows. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<{ rows: T[]; rowCount: number }>;
  /** Run a mutation; resolves the affected/returned rows + count. */
  exec(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
}

/**
 * Outbound email (gated by `email:send`; 3.10-i). The module supplies its own subject + body and
 * NEVER sees SMTP credentials or core's transactional templates. Core validates the recipient +
 * subject (header-injection-safe), rate-limits per module, audits every send, and QUEUES the
 * message through core's MailService scoped to the module's tenant. Resolves `{ queued: true }`
 * on success; rejects with `RATE_LIMITED` over the cap or `FORBIDDEN` without the grant.
 *
 * `sendToCustomer` (follow-up B3) is the PRIVACY-PRESERVING variant: the module names a customer by
 * its opaque `customerId` ONLY — it supplies no address and NEVER receives one. Core resolves the
 * recipient from the (broker-context tenant, customerId) composite, honours marketing CONSENT
 * (`accepts_marketing`) and RGPD erasure (`deleted_at`/`anonymized_at`), and either sends or
 * SUPPRESSES. It resolves `{ queued: true }` when sent or `{ queued: false }` when suppressed — and
 * the module CANNOT learn WHY a send was suppressed (no consent/existence oracle). It shares the
 * EXISTING `email:send` grant + per-module rate limit (it is strictly more privacy-preserving than
 * `send`, which already lets a module email any address it supplies).
 */
export interface EmailClient {
  send(message: ModuleEmailMessage): Promise<ModuleEmailSendResult>;
  sendToCustomer(message: ModuleCustomerEmailMessage): Promise<ModuleEmailSendResult>;
}

/** Domain events (gated by `subscribe:events` / `emit:events`). */
export interface EventsClient {
  /**
   * Subscribe to an event and register a handler. Re-sends the full subscription set to core, so
   * call all `on(...)` during `activate`. Events: curated core names (`order.paid`, `product.*`,
   * …) or another module's `mod.<name>.*`.
   */
  on(event: string, handler: (payload: unknown) => void | Promise<void>): Promise<void>;
  /** Emit a module event (delivered as `mod.<thisModule>.<event>` to other subscribed modules). */
  emit(event: string, payload?: unknown): Promise<void>;
}

/** The capability object handed to a module's `activate(sdk)` — its ONLY channel to core. */
export interface ModuleSdk {
  readonly store: StoreClient;
  readonly admin: AdminClient;
  /** Narrow commerce reads (gated by `read:orders`; boolean-only — see {@link CommerceClient}). */
  readonly commerce: CommerceClient;
  readonly http: HttpClient;
  readonly tables: TablesClient;
  readonly events: EventsClient;
  /** Outbound email via core's MailService (gated by `email:send`; 3.10-i). */
  readonly email: EmailClient;
  /**
   * Register the module's HTTP handler. Core proxies requests on the module's mounted routes
   * (`/{store,admin}/v1/modules/<name>/*`) to it. At most one handler; the last call wins.
   */
  serve(handler: ModuleHttpHandler): void;
}
