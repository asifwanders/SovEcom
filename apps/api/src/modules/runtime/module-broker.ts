/**
 * The SDK broker: the SINGLE chokepoint between a module worker and core.
 * Registered as the RPC handler set on each worker's peer.
 *
 * For EVERY inbound call the broker:
 *   1. **default-deny permission check** — the method's capability must be in the module's
 *      admin-granted permissions, else FORBIDDEN;
 *   2. **validates params** with a strict per-method schema (rejects extras — a module cannot
 *      smuggle a `tenantId`);
 *   3. **tenant-scopes** the data access with the worker's identity tenant (never the module's
 *      input);
 *   4. returns a read-only DTO from a narrow port — never a query handle.
 *
 * Two categories are refused without any permission ever enabling them:
 *   - **FORBIDDEN methods** — core-table writes + cart/checkout/payments/inventory/orders
 *     mutations: refused BY DESIGN (Threat Model §6, not by permission).
 *   - **NOT_AVAILABLE methods** — capabilities in the manifest vocabulary whose runtime is
 *     deferred to a later release. The mechanism is kept for future capabilities.
 */
import { z } from 'zod';

import type { ModulePermission } from '../module-manifest';
import { RpcError, RpcErrorCode } from './ipc-protocol';
import type { RpcPeer } from './rpc';
import type { BrokerReadPorts } from './broker-ports';
import type { HttpEgressPort } from './http-egress';
import type { ModuleSqlExecutor } from './module-sql.executor';
import type { ModuleEventBus } from './module-event-bus';
import type { ModuleMailPort } from './module-mail.port';

/**
 * Maximum concurrent inbound RPC calls from a single worker (DoS hardening).
 * Excess calls are immediately rejected with {@link RpcErrorCode.BUSY} so a runaway module
 * cannot starve the core event loop. Exported so unit tests can lower it for brevity.
 */
export const MAX_INFLIGHT_PER_WORKER = 16;

/** Per-worker broker context, derived from the installed_modules row at worker start. */
export interface BrokerContext {
  readonly tenantId: string;
  readonly moduleName: string;
  readonly grantedPermissions: ReadonlySet<ModulePermission>;
  /** Admin-approved outbound host allowlist for `http:outbound` (default-deny when empty). */
  readonly httpAllowlist: ReadonlySet<string>;
}

const listQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional().default(50),
    cursor: z.string().max(512).optional(),
  })
  .strict();

const getByIdSchema = z.object({ id: z.string().min(1).max(64) }).strict();

/**
 * `commerce.hasPurchased` params (B1). Two opaque, bounded id strings — `.strict()` rejects extras
 * (a module cannot smuggle a `tenantId`; the tenant comes from ctx). Bounds mirror the other id
 * params (1..64). The broker treats both as bind params; it never interprets them.
 */
const hasPurchasedSchema = z
  .object({
    customerId: z.string().min(1).max(64),
    productId: z.string().min(1).max(64),
  })
  .strict();

const httpFetchSchema = z
  .object({
    url: z.string().url().max(2048),
    method: z.string().max(10).optional(),
    headers: z.record(z.string().max(128), z.string().max(8192)).optional(),
    body: z
      .string()
      .max(256 * 1024)
      .optional(),
  })
  .strict();

// Own-table access: a parameterized statement against the module's OWN schema. The DB role is
// the real isolation boundary (the executor runs it on a connection authenticated AS the module
// role); this just enforces
// a string statement + bound primitive params (no objects/nested injection vectors).
const tablesSqlSchema = z
  .object({
    sql: z
      .string()
      .min(1)
      .max(16 * 1024),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .max(64)
      .optional(),
  })
  .strict();

type ListParams = z.infer<typeof listQuerySchema>;
type GetParams = z.infer<typeof getByIdSchema>;
type HasPurchasedParams = z.infer<typeof hasPurchasedSchema>;

interface ReadCapability {
  readonly method: string;
  readonly permission: ModulePermission;
  readonly schema: z.ZodTypeAny;
  /** `params` is the schema-validated output (cast per capability inside each `run`). */
  readonly run: (ports: BrokerReadPorts, ctx: BrokerContext, params: unknown) => Promise<unknown>;
}

/** The ONLY methods that actually do something today — all read-only, all tenant-scoped. */
const READ_CAPABILITIES: readonly ReadCapability[] = [
  {
    method: 'products.list',
    permission: 'read:products',
    schema: listQuerySchema,
    run: (p, c, q) => p.products.list(c.tenantId, q as ListParams),
  },
  {
    method: 'products.get',
    permission: 'read:products',
    schema: getByIdSchema,
    run: (p, c, q) => p.products.get(c.tenantId, (q as GetParams).id),
  },
  {
    method: 'categories.list',
    permission: 'read:categories',
    schema: listQuerySchema,
    run: (p, c, q) => p.categories.list(c.tenantId, q as ListParams),
  },
  {
    method: 'categories.get',
    permission: 'read:categories',
    schema: getByIdSchema,
    run: (p, c, q) => p.categories.get(c.tenantId, (q as GetParams).id),
  },
  {
    method: 'orders.list',
    permission: 'read:orders',
    schema: listQuerySchema,
    run: (p, c, q) => p.orders.list(c.tenantId, q as ListParams),
  },
  {
    method: 'orders.get',
    permission: 'read:orders',
    schema: getByIdSchema,
    run: (p, c, q) => p.orders.get(c.tenantId, (q as GetParams).id),
  },
  {
    method: 'customers.list',
    permission: 'read:customers',
    schema: listQuerySchema,
    run: (p, c, q) => p.customers.list(c.tenantId, q as ListParams),
  },
  {
    method: 'customers.get',
    permission: 'read:customers',
    schema: getByIdSchema,
    run: (p, c, q) => p.customers.get(c.tenantId, (q as GetParams).id),
  },
  {
    // commerce.hasPurchased (B1): gated by the EXISTING read:orders permission. Tenant-scoped from
    // ctx; the two ids are bound params. Returns ONLY a boolean — no order data (least-privilege).
    method: 'commerce.hasPurchased',
    permission: 'read:orders',
    schema: hasPurchasedSchema,
    run: (p, c, q) => {
      const { customerId, productId } = q as HasPurchasedParams;
      return p.commerce.hasPurchased(c.tenantId, customerId, productId);
    },
  },
];

/**
 * Methods refused CATEGORICALLY — by design, never enabled by any permission grant.
 * Core-table writes + the entire transactional path. Listed explicitly so the refusal is
 * self-documenting and tested, rather than relying on "no handler registered".
 */
export const FORBIDDEN_METHODS: readonly string[] = [
  'products.create',
  'products.update',
  'products.delete',
  'categories.create',
  'categories.update',
  'categories.delete',
  'customers.create',
  'orders.create',
  'orders.update',
  'orders.cancel',
  'cart.create',
  'cart.addItem',
  'cart.update',
  'checkout.start',
  'checkout.complete',
  'payments.charge',
  'payments.capture',
  'payments.refund',
  'inventory.adjust',
  'inventory.reserve',
  'customers.update',
  'customers.delete',
];

/**
 * Capabilities whose runtime is deferred → a clean NOT_AVAILABLE.
 * Currently EMPTY. Slots became declarative manifest metadata in a prior release.
 * The mechanism is retained for future deferred capabilities.
 */
const DEFERRED_METHODS: Readonly<Record<string, string>> = {};

const eventsSubscribeSchema = z
  .object({ events: z.array(z.string().min(1).max(128)).max(64) })
  .strict();
const eventsEmitSchema = z
  .object({ event: z.string().min(1).max(128), payload: z.unknown().optional() })
  .strict();

export class ModuleBroker {
  private readonly capabilities = new Map<string, ReadCapability>(
    READ_CAPABILITIES.map((c) => [c.method, c]),
  );

  constructor(
    private readonly ports: BrokerReadPorts,
    private readonly egress: HttpEgressPort,
    private readonly executor: ModuleSqlExecutor,
    private readonly eventBus: ModuleEventBus,
    private readonly mail: ModuleMailPort,
  ) {}

  /** Wire this broker as the handler set for one worker's peer, bound to its context. */
  registerOn(peer: RpcPeer, ctx: BrokerContext): void {
    // Per-worker inbound concurrency cap: all substantive handlers are wrapped so
    // that at most MAX_INFLIGHT_PER_WORKER calls from this worker are in-flight at once. A call
    // arriving when the cap is reached is IMMEDIATELY rejected (BUSY) so the worker's backlog
    // doesn't grow unboundedly and core's event loop cannot be monopolised by one module.
    let inflight = 0;
    const cap =
      <T>(fn: (p: unknown) => Promise<T> | T) =>
      async (params: unknown): Promise<T> => {
        if (inflight >= MAX_INFLIGHT_PER_WORKER) {
          throw new RpcError(RpcErrorCode.BUSY, 'worker concurrency limit exceeded');
        }
        inflight++;
        try {
          return await fn(params);
        } finally {
          inflight--;
        }
      };

    for (const capability of READ_CAPABILITIES) {
      peer.handle(
        capability.method,
        cap((params) => this.invokeRead(capability, ctx, params)),
      );
    }
    // http:outbound — the only sanctioned egress (SSRF-guarded + allowlisted in the port).
    peer.handle(
      'http.fetch',
      cap((params) => this.invokeHttp(ctx, params)),
    );
    // write:own_tables — parameterized SQL against the module's OWN schema, executed under the
    // module's low-privilege DB role (the executor runs it on a dedicated connection whose
    // session user IS modrole_<module> — that is the isolation boundary).
    peer.handle(
      'tables.query',
      cap((params) => this.invokeTables(ctx, params)),
    );
    peer.handle(
      'tables.exec',
      cap((params) => this.invokeTables(ctx, params)),
    );
    // subscribe:events / emit:events — record subscriptions on (and emit from) THIS worker's peer.
    peer.handle(
      'events.subscribe',
      cap((params) => this.invokeEventsSubscribe(peer, ctx, params)),
    );
    peer.handle(
      'events.emit',
      cap((params) => this.invokeEventsEmit(ctx, params)),
    );
    // email:send — module-originated mail, queued through core's MailService. The mail port
    // permission-gates (below), validates (header-injection-safe), rate-limits per module, audits,
    // and tenant-scopes — the module never gets SMTP creds or a core template.
    peer.handle(
      'email.send',
      cap((params) => this.invokeEmail(ctx, params)),
    );
    // email.sendToCustomer rides the SAME email:send grant (NO new permission). It is
    // strictly MORE privacy-preserving than `send` (consent-gated + rate-limited; the module never
    // supplies or sees an address). The mail port resolves the recipient + honours marketing consent
    // and erasure, and either sends or returns { queued: false } with no leaked reason.
    peer.handle(
      'email.sendToCustomer',
      cap((params) => this.invokeEmailToCustomer(ctx, params)),
    );
    // Forbidden + deferred stubs are trivially synchronous — wrapping them is harmless but we
    // keep them outside the cap to stay simple and avoid masking a FORBIDDEN with BUSY.
    for (const method of FORBIDDEN_METHODS) {
      peer.handle(method, () => {
        throw new RpcError(
          RpcErrorCode.FORBIDDEN,
          `"${method}" is refused by design: modules cannot write core tables or touch the ` +
            `cart/checkout/payments/inventory/orders path`,
        );
      });
    }
    for (const [method, reason] of Object.entries(DEFERRED_METHODS)) {
      peer.handle(method, () => {
        throw new RpcError(RpcErrorCode.NOT_AVAILABLE, `"${method}" not available: ${reason}`);
      });
    }
  }

  private async invokeRead(
    cap: ReadCapability,
    ctx: BrokerContext,
    params: unknown,
  ): Promise<unknown> {
    // 1. default-deny permission gate
    if (!ctx.grantedPermissions.has(cap.permission)) {
      throw new RpcError(
        RpcErrorCode.FORBIDDEN,
        `permission not granted: "${cap.permission}" (required for ${cap.method})`,
      );
    }
    // 2. strict param validation (rejects extras — a module cannot inject tenantId)
    const parsed = cap.schema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new RpcError(
        RpcErrorCode.PROTOCOL,
        `invalid params for ${cap.method}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    // 3. tenant-scoped data access via the narrow port (ctx.tenantId, never module input)
    return cap.run(this.ports, ctx, parsed.data);
  }

  private async invokeHttp(ctx: BrokerContext, params: unknown): Promise<unknown> {
    if (!ctx.grantedPermissions.has('http:outbound')) {
      throw new RpcError(RpcErrorCode.FORBIDDEN, 'permission not granted: "http:outbound"');
    }
    const parsed = httpFetchSchema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new RpcError(
        RpcErrorCode.PROTOCOL,
        `invalid params for http.fetch: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    // The egress port enforces https-only, the allowlist, the SSRF guard, and size/timeout
    // bounds — throwing RpcError(FORBIDDEN) on any violation.
    return this.egress.fetch(parsed.data, ctx.httpAllowlist);
  }

  private async invokeTables(ctx: BrokerContext, params: unknown): Promise<unknown> {
    if (!ctx.grantedPermissions.has('write:own_tables')) {
      throw new RpcError(RpcErrorCode.FORBIDDEN, 'permission not granted: "write:own_tables"');
    }
    const parsed = tablesSqlSchema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new RpcError(
        RpcErrorCode.PROTOCOL,
        `invalid params for tables: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    // The executor runs this on a connection authenticated AS modrole_<module> (search_path = its
    // schema), so the DB confines it to the module's OWN tables — a statement touching core fails
    // at PG, and RESET ROLE/SET ROLE cannot reach a privileged role.
    return this.executor.exec(ctx.moduleName, parsed.data.sql, parsed.data.params ?? []);
  }

  private invokeEventsSubscribe(peer: RpcPeer, ctx: BrokerContext, params: unknown): { ok: true } {
    if (!ctx.grantedPermissions.has('subscribe:events')) {
      throw new RpcError(RpcErrorCode.FORBIDDEN, 'permission not granted: "subscribe:events"');
    }
    const parsed = eventsSubscribeSchema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new RpcError(RpcErrorCode.PROTOCOL, 'invalid params for events.subscribe');
    }
    try {
      // tenant + module come from the worker's identity (ctx), never the request.
      this.eventBus.subscribe(ctx.tenantId, ctx.moduleName, peer, parsed.data.events);
    } catch (err) {
      throw new RpcError(
        RpcErrorCode.PROTOCOL,
        err instanceof Error ? err.message : 'bad subscription',
      );
    }
    return { ok: true };
  }

  private invokeEventsEmit(ctx: BrokerContext, params: unknown): { ok: true } {
    if (!ctx.grantedPermissions.has('emit:events')) {
      throw new RpcError(RpcErrorCode.FORBIDDEN, 'permission not granted: "emit:events"');
    }
    const parsed = eventsEmitSchema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new RpcError(RpcErrorCode.PROTOCOL, 'invalid params for events.emit');
    }
    try {
      // Namespaced to mod.<thisModule>.* inside the bus — a module can't forge a core event.
      this.eventBus.emitModuleEvent(
        ctx.tenantId,
        ctx.moduleName,
        parsed.data.event,
        parsed.data.payload,
      );
    } catch (err) {
      // Preserve a typed RpcError (e.g. BUSY from the emit rate limit); else it's a bad name/payload.
      if (err instanceof RpcError) throw err;
      throw new RpcError(RpcErrorCode.PROTOCOL, err instanceof Error ? err.message : 'bad emit');
    }
    return { ok: true };
  }

  /**
   * Email send. Default-deny permission gate HERE (mirroring every other capability); the
   * mail port then does validation, the per-module rate limit, audit, and the tenant-scoped send.
   * The port already throws typed RpcError (PROTOCOL / RATE_LIMITED / HANDLER_ERROR) on refusal.
   */
  private invokeEmail(ctx: BrokerContext, params: unknown): Promise<{ queued: boolean }> {
    if (!ctx.grantedPermissions.has('email:send')) {
      throw new RpcError(RpcErrorCode.FORBIDDEN, 'permission not granted: "email:send"');
    }
    return this.mail.send({ tenantId: ctx.tenantId, moduleName: ctx.moduleName }, params);
  }

  /**
   * Email to customer. SAME default-deny `email:send` gate as `send` (NO new permission).
   * It is strictly more privacy-preserving than `send`, which already lets a module email any
   * address it supplies. The mail port then validates, rate-limits (shared bucket), resolves the
   * customer tenant-scoped, honours consent/erasure (suppress → { queued: false }), and audits.
   * Tenant comes from ctx, never input.
   */
  private invokeEmailToCustomer(ctx: BrokerContext, params: unknown): Promise<{ queued: boolean }> {
    if (!ctx.grantedPermissions.has('email:send')) {
      throw new RpcError(RpcErrorCode.FORBIDDEN, 'permission not granted: "email:send"');
    }
    return this.mail.sendToCustomer({ tenantId: ctx.tenantId, moduleName: ctx.moduleName }, params);
  }
}
