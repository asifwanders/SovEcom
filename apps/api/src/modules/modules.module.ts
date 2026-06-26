/**
 * ModulesModule — the admin-side module install/registry flow plus the
 * sandboxed module runtime and DB isolation + events.
 *
 * The flow includes: secure tarball ingest, manifest verification, default-deny permission grant + persist;
 * the out-of-process sandbox worker + capability-gated SDK broker. `ModuleRuntimeService`
 * exposes enable/disable (start/stop a sandboxed worker, wire the broker with the module's
 * grants + tenant). Module code runs only when enabled, not at install time; admin enable/disable endpoints + uninstall data semantics + liveness watchdog.
 *
 * `DatabaseService` + the AuditModule interceptor are @Global.
 */
import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CatalogModule } from '../catalog/catalog.module';
import { ModulesRepository } from './modules.repository';
import { ModuleIngestService } from './module-ingest.service';
import { ModulesService } from './modules.service';
import { ModulesAdminController } from './modules.controller.admin';
import { ModulesProxyController } from './modules-proxy.controller';
// the sandboxed module runtime.
import { BrokerReadAdapter } from './runtime/broker-read.adapter';
import { NodeHttpEgress, type HttpEgressPort } from './runtime/http-egress';
import { ModuleBroker } from './runtime/module-broker';
import { WorkerHost } from './runtime/worker-host';
import { ForkedWorkerChannel } from './runtime/forked-worker-channel';
import { ModuleRuntimeService } from './runtime/module-runtime.service';
import type { BrokerReadPorts } from './runtime/broker-ports';
// per-module DB isolation + migrations.
import { ModuleDbProvisioner } from './runtime/module-db.provisioner';
import { ModuleSqlExecutor } from './runtime/module-sql.executor';
import { ModuleMigrationRunner } from './runtime/module-migration.runner';
import { ModuleEventBus } from './runtime/module-event-bus';
import { ModuleEventListener } from './runtime/module-event.listener';
// broker-mediated module email.
import { ModuleMailPort, CUSTOMER_EMAIL_LOOKUP } from './runtime/module-mail.port';
// Follow-up B3: the DB-backed customer-email resolver for sdk.email.sendToCustomer.
import { CustomerEmailLookupAdapter } from './runtime/customer-email-lookup.adapter';
// i.5: the customer-identity bridge into the STORE module proxy. CustomersModule exports
// CustomerTokenService (the JWT verification the guard reuses); the guard is provided here because
// it is applied on this module's proxy controller.
import { CustomersModule } from '../customers/customers.module';
import { StoreModuleCustomerAuthGuard } from '../customers/auth/store-module-customer-auth.guard';

@Module({
  // CatalogModule exports StoreTenantService (default-tenant resolution for the public store
  // proxy surface). CustomersModule exports CustomerTokenService for the optional customer-auth
  // guard on the store proxy mount. No cycle — neither imports ModulesModule.
  imports: [CatalogModule, CustomersModule],
  providers: [
    ModulesRepository,
    ModulesService,
    // optional customer-auth on the STORE module mount (verified principal → req.customer;
    // anonymous allowed; bad token → 401). Reuses CustomerTokenService + DatabaseService (@Global).
    StoreModuleCustomerAuthGuard,
    // Default construction reads MODULES_DATA_PATH from env.
    { provide: ModuleIngestService, useFactory: () => new ModuleIngestService() },

    // module runtime
    // Read ports → the single tenant-scoped read-projection adapter over Drizzle.
    {
      provide: BrokerReadAdapter,
      useFactory: (db: DatabaseService) => new BrokerReadAdapter(db),
      inject: [DatabaseService],
    },
    // The only sanctioned egress (SSRF-guarded + allowlisted).
    NodeHttpEgress,
    // The event bus / subscription registry + the core-event fan-out listener.
    ModuleEventBus,
    ModuleEventListener,
    // Follow-up B3: the DB-backed customer-email resolver (consent/erasure-aware), bound to the
    // CUSTOMER_EMAIL_LOOKUP token the mail port injects for sendToCustomer.
    {
      provide: CUSTOMER_EMAIL_LOOKUP,
      useFactory: (db: DatabaseService) => new CustomerEmailLookupAdapter(db),
      inject: [DatabaseService],
    },
    // The broker-mediated email port (3.10-i / B3): validates + rate-limits + audits + queues via
    // core's MailService; for sendToCustomer it resolves the recipient via CUSTOMER_EMAIL_LOOKUP and
    // honours marketing consent + erasure. Injects the @Global MAIL_SERVICE + AuditService.
    ModuleMailPort,
    // The broker (chokepoint) composes the read ports + egress + own-tables executor + event bus +
    // the mail port.
    {
      provide: ModuleBroker,
      useFactory: (
        ports: BrokerReadPorts,
        egress: HttpEgressPort,
        executor: ModuleSqlExecutor,
        eventBus: ModuleEventBus,
        mail: ModuleMailPort,
      ) => new ModuleBroker(ports, egress, executor, eventBus, mail),
      inject: [
        BrokerReadAdapter,
        NodeHttpEgress,
        ModuleSqlExecutor,
        ModuleEventBus,
        ModuleMailPort,
      ],
    },
    // The worker host forks a real sandboxed child per module (scrubbed env + permission model).
    // On stop/crash it unsubscribes the worker from the event bus so dead peers are pruned.
    {
      provide: WorkerHost,
      useFactory: (eventBus: ModuleEventBus) =>
        new WorkerHost(
          (spec) =>
            new ForkedWorkerChannel({
              entry: spec.entry,
              allowFsRead: spec.allowFsRead,
              allowFsWrite: spec.allowFsWrite,
              env: spec.env,
              maxOldSpaceMb: spec.maxOldSpaceMb,
            }),
          undefined,
          { onStopped: (id) => eventBus.unsubscribe(id.tenantId, id.name) },
        ),
      inject: [ModuleEventBus],
    },
    ModuleRuntimeService,

    // per-module DB isolation + migrations
    ModuleDbProvisioner,
    ModuleSqlExecutor,
    ModuleMigrationRunner,
  ],
  // ModulesAdminController FIRST so its management routes (install/list/uninstall) take
  // precedence; the proxy catch-all only handles `:name/<subpath>`.
  controllers: [ModulesAdminController, ModulesProxyController],
  exports: [
    ModulesService,
    ModuleRuntimeService,
    ModuleDbProvisioner,
    ModuleSqlExecutor,
    ModuleMigrationRunner,
  ],
})
export class ModulesModule {}
