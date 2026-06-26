/**
 * namespaced migration runner.
 *
 * Applies a module's own migrations AS the module role inside its schema (via
 * {@link ModuleSqlExecutor}), so DDL is confined to `mod_<name>` — a migration touching a core
 * table fails at the database. The ledger is the CORE-owned `module_migrations` table, written
 * ONLY through the app connection (Drizzle), never the module role — so a module cannot forge or
 * drop its migration history (A+B review HIGH). Migrations are append-only + checksum-verified.
 *
 * Apply order per migration: read ledger (app) → run `up` DDL (module conn, confined) → record
 * ledger (app). The two connections aren't a single transaction; if the ledger write fails AFTER
 * the DDL applied (rare — a DB blip), the next run sees the migration as pending and its `up`
 * re-runs (a CREATE will surface "already exists"); this is logged and operationally recoverable.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { moduleMigrations } from '../../database/schema/module_migrations';
import { assertModuleName } from './module-identifier';
import { ModuleSqlExecutor, type ModuleTx } from './module-sql.executor';

export interface ModuleMigration {
  readonly id: string;
  readonly up: string;
  readonly down?: string;
}

const ID_RE = /^[0-9a-z][0-9a-z_-]{0,63}$/;

/**
 * Hash a migration's up/down UNAMBIGUOUSLY. The previous `${up} ${down}` concat collided across
 * the boundary at whitespace ({up:'A',down:'B C'} hashed the same as {up:'A B',down:'C'}); a JSON
 * tuple is injective so distinct (up, down) pairs never share a checksum. NOTE: this changes the
 * stored checksum for any given migration — a one-time ledger concern only, and no modules ship
 * yet so the live `module_migrations` ledger is empty (safe to change now).
 */
export function checksum(m: ModuleMigration): string {
  return createHash('sha256')
    .update(JSON.stringify([m.up, m.down ?? null]))
    .digest('hex');
}

@Injectable()
export class ModuleMigrationRunner {
  private readonly logger = new Logger(ModuleMigrationRunner.name);

  constructor(
    private readonly executor: ModuleSqlExecutor,
    private readonly database: DatabaseService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Apply all not-yet-applied migrations (ascending by id). Returns the ids applied this run. */
  async applyPending(name: string, migrations: readonly ModuleMigration[]): Promise<string[]> {
    assertModuleName(name);
    this.validateInput(migrations);
    const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));

    const applied = await this.readApplied(name);
    const maxApplied = [...applied.keys()].sort((a, b) => a.localeCompare(b)).pop();
    for (const m of ordered) {
      const prior = applied.get(m.id);
      if (prior !== undefined) {
        if (prior !== checksum(m)) {
          throw new Error(`migration "${m.id}" changed after being applied (checksum mismatch)`);
        }
        continue;
      }
      if (maxApplied !== undefined && m.id.localeCompare(maxApplied) < 0) {
        throw new Error(
          `migration "${m.id}" sorts before already-applied "${maxApplied}" (append-only)`,
        );
      }
    }

    const appliedNow: string[] = [];
    for (const m of ordered) {
      if (applied.has(m.id)) continue;
      await this.applyOne(name, m);
      appliedNow.push(m.id);
    }
    if (appliedNow.length) this.logger.log(`module ${name}: applied ${appliedNow.join(', ')}`);
    return appliedNow;
  }

  /** Revert a single applied migration (runs `down` as the module, removes the ledger row). */
  async revert(name: string, migration: ModuleMigration): Promise<void> {
    assertModuleName(name);
    if (!migration.down) {
      throw new Error(`migration "${migration.id}" has no down() and cannot be reverted`);
    }
    await this.executor.runAsModule(
      name,
      async (tx: ModuleTx) => {
        await tx.unsafe(migration.down!).simple();
      },
      { statementTimeout: '30s' },
    );
    await this.db
      .delete(moduleMigrations)
      .where(
        and(eq(moduleMigrations.module, name), eq(moduleMigrations.migrationId, migration.id)),
      );
    this.logger.log(`module ${name}: reverted ${migration.id}`);
  }

  private validateInput(migrations: readonly ModuleMigration[]): void {
    const seen = new Set<string>();
    for (const m of migrations) {
      if (!ID_RE.test(m.id)) throw new Error(`invalid migration id: ${JSON.stringify(m.id)}`);
      if (seen.has(m.id)) throw new Error(`duplicate migration id: ${m.id}`);
      seen.add(m.id);
      if (typeof m.up !== 'string' || m.up.trim().length === 0) {
        throw new Error(`migration "${m.id}" has empty up()`);
      }
    }
  }

  private async readApplied(name: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: moduleMigrations.migrationId, checksum: moduleMigrations.checksum })
      .from(moduleMigrations)
      .where(eq(moduleMigrations.module, name));
    return new Map(rows.map((r) => [r.id, r.checksum]));
  }

  private async applyOne(name: string, m: ModuleMigration): Promise<void> {
    // 1) Run the DDL confined to the module schema (module connection).
    await this.executor.execDdl(name, m.up);
    // 2) Record it in the core-owned ledger (app connection — module-untouchable).
    await this.db
      .insert(moduleMigrations)
      .values({ module: name, migrationId: m.id, checksum: checksum(m) });
  }
}
