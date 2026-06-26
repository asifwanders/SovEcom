/**
 * the module SQL executor: the ONE place untrusted module
 * SQL runs, and where the DB-enforced isolation lives.
 *
 * SECURITY MODEL (revised after the A+B review). Module SQL runs on a DEDICATED connection
 * authenticated AS the module's LOGIN role `modrole_<name>`. The connection's SESSION user is
 * therefore the unprivileged module role — so even `RESET ROLE` / `SET ROLE` / `set_config('role',…)`
 * inside module SQL can only land back on `modrole_<name>` (a member of nothing: not core, not the
 * app role, not other module roles). It can never reach core or another module's schema. This is
 * why we do NOT `SET LOCAL ROLE` on the shared app pool (that role switch is reversible by the
 * session user —).
 *
 * Per-statement `statement_timeout` + the role-default `idle_in_transaction_session_timeout` and a
 * small per-module pool bound runaway/DoS.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import postgres from 'postgres';

import { assertModuleName, quotedSchema, roleName } from './module-identifier';

export interface ModuleQueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount: number;
}

const MAX_RUNTIME_SQL_BYTES = 16 * 1024;
const MAX_RESULT_ROWS = 1000;
const RUNTIME_STATEMENT_TIMEOUT = '5s';
const MIGRATION_STATEMENT_TIMEOUT = '30s';
const PER_MODULE_POOL_MAX = 3;

/** A postgres.js-like tagged client usable inside a module transaction. */
export interface ModuleTx {
  unsafe(
    query: string,
    params?: unknown[],
  ): Promise<Array<Record<string, unknown>>> & {
    simple(): Promise<Array<Record<string, unknown>>>;
  };
}

@Injectable()
export class ModuleSqlExecutor implements OnModuleDestroy {
  private readonly logger = new Logger(ModuleSqlExecutor.name);
  private readonly clients = new Map<string, postgres.Sql>();

  /**
   * Open the module's dedicated connection (authenticated as `modrole_<name>` with the given
   * ephemeral password). Idempotent — replaces any existing client. Called on enable.
   */
  open(name: string, password: string): void {
    assertModuleName(name);
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is not set');
    const url = new URL(base);
    url.username = roleName(name);
    url.password = password;
    // Lazy connect; small pool to bound a module's connection footprint.
    const client = postgres(url.toString(), {
      max: PER_MODULE_POOL_MAX,
      idle_timeout: 30,
      connection: { application_name: `mod_${name}` },
    });
    this.replace(name, client);
  }

  /** Close + forget the module's connection (called on disable/uninstall). Best-effort. */
  async close(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;
    this.clients.delete(name);
    await client.end({ timeout: 5 }).catch(() => undefined);
  }

  isOpen(name: string): boolean {
    return this.clients.has(name);
  }

  /**
   * Run `fn` inside a transaction on the module's own connection. Sets a per-statement timeout +
   * pins search_path (belt-and-suspenders over the role default). NO `SET ROLE` — the session user
   * already IS the unprivileged module role, so there is nothing to escape to.
   */
  async runAsModule<T>(
    name: string,
    fn: (tx: ModuleTx) => Promise<T>,
    options: { statementTimeout?: string } = {},
  ): Promise<T> {
    const sql = this.client(name);
    const schema = quotedSchema(name);
    const timeout = options.statementTimeout ?? RUNTIME_STATEMENT_TIMEOUT;
    return sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${timeout}'`);
      await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
      return fn(tx as unknown as ModuleTx);
    }) as Promise<T>;
  }

  /** Execute ONE parameterized runtime statement (broker tables.query/exec). Caps SQL + rows. */
  async exec(name: string, text: string, params: unknown[] = []): Promise<ModuleQueryResult> {
    if (Buffer.byteLength(text, 'utf8') > MAX_RUNTIME_SQL_BYTES) {
      throw new Error('module SQL exceeds the runtime size cap');
    }
    // SINGLE statement only: with an empty params array postgres.js uses the simple protocol,
    // which would otherwise allow `;`-stacked statements. Stacking is fully confined to the
    // module's own schema (the connection is the module role), but the runtime contract is one
    // statement per call — reject an embedded `;` (use separate exec calls / a migration for more,
    // and bind values as params, never inline). A lone trailing `;` is allowed.
    if (text.trim().replace(/;\s*$/, '').includes(';')) {
      throw new Error('module runtime SQL must be a single statement (use params for values)');
    }
    return this.runAsModule(name, async (tx) => {
      const res = (await tx.unsafe(text, params)) as Array<Record<string, unknown>>;
      if (res.length > MAX_RESULT_ROWS) {
        throw new Error(`module query returned more than ${MAX_RESULT_ROWS} rows`);
      }
      return { rows: [...res], rowCount: res.length };
    });
  }

  /** Run a (possibly multi-statement, no-param) DDL block — migrations only. */
  async execDdl(name: string, ddl: string): Promise<void> {
    await this.runAsModule(
      name,
      async (tx) => {
        await tx.unsafe(ddl).simple();
      },
      { statementTimeout: MIGRATION_STATEMENT_TIMEOUT },
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const name of [...this.clients.keys()]) await this.close(name);
  }

  private client(name: string): postgres.Sql {
    assertModuleName(name);
    const c = this.clients.get(name);
    if (!c) throw new Error(`module DB connection not open: ${name} (enable the module first)`);
    return c;
  }

  private replace(name: string, client: postgres.Sql): void {
    const prev = this.clients.get(name);
    this.clients.set(name, client);
    if (prev) void prev.end({ timeout: 5 }).catch(() => undefined);
  }
}
