/**
 * per-module DB isolation + migration runner integration.
 *
 * SECURITY-CRITICAL. Against a REAL Postgres, proves the DB-enforced boundary — INCLUDING the
 * adversarial role-switch escapes the A+B review found (RESET ROLE / SET ROLE / set_config('role'))
 * which the original SET-LOCAL-ROLE design failed. Module SQL runs on a connection authenticated
 * AS the module's own LOGIN role, so there is no privileged session user to climb back to.
 */
import { bootAuthApp, teardownAuthApp, AuthHarness } from '../auth/_auth-harness';
import { DatabaseService } from '../../../src/database/database.service';
import { moduleMigrations } from '../../../src/database/schema/module_migrations';
import { eq } from 'drizzle-orm';
import { ModuleDbProvisioner } from '../../../src/modules/runtime/module-db.provisioner';
import { ModuleSqlExecutor } from '../../../src/modules/runtime/module-sql.executor';
import {
  ModuleMigrationRunner,
  type ModuleMigration,
} from '../../../src/modules/runtime/module-migration.runner';

const MOD = 'itest';

describe('Module DB isolation + migrations (integration)', () => {
  let h: AuthHarness;
  let db: DatabaseService;
  let provisioner: ModuleDbProvisioner;
  let executor: ModuleSqlExecutor;
  let runner: ModuleMigrationRunner;

  beforeAll(async () => {
    h = await bootAuthApp();
    db = h.app.get(DatabaseService);
    provisioner = new ModuleDbProvisioner(db);
    executor = new ModuleSqlExecutor(db);
    runner = new ModuleMigrationRunner(executor, db);
    await provisioner.deprovision(MOD);
    await provisioner.provision(MOD);
    const pw = await provisioner.rotateCredential(MOD);
    executor.open(MOD, pw);
  });

  afterAll(async () => {
    await executor.close(MOD);
    await provisioner.deprovision(MOD).catch(() => undefined); // also clears the ledger
    await teardownAuthApp(h);
  });

  const initMigration: ModuleMigration = {
    id: '0001_init',
    up: 'CREATE TABLE items (id int PRIMARY KEY, label text NOT NULL)',
    down: 'DROP TABLE items',
  };

  // ── the escapes the original design failed (must all be blocked) ─────────────────
  it('module SQL cannot SET ROLE to the app role', async () => {
    await expect(executor.runAsModule(MOD, (tx) => tx.unsafe('SET ROLE sovecom'))).rejects.toThrow(
      /permission denied|not.*member|does not exist/i,
    );
  });

  it("module SQL cannot escape via set_config('role', …) to read core", async () => {
    await expect(
      executor.runAsModule(MOD, async (tx) => {
        await tx.unsafe("SELECT set_config('role', 'sovecom', false)");
        return tx.unsafe('SELECT count(*) FROM public.tenants');
      }),
    ).rejects.toThrow(/permission denied|not.*member/i);
  });

  it('RESET ROLE stays the module role — core remains unreachable', async () => {
    await expect(
      executor.runAsModule(MOD, async (tx) => {
        await tx.unsafe('RESET ROLE').simple();
        return tx.unsafe('SELECT 1 FROM public.tenants LIMIT 1');
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('a module role CANNOT read or write a core table', async () => {
    await expect(
      executor.runAsModule(MOD, (tx) => tx.unsafe('SELECT 1 FROM public.tenants LIMIT 1')),
    ).rejects.toThrow(/permission denied|does not exist/i);
    await expect(
      executor.runAsModule(MOD, (tx) =>
        tx.unsafe("INSERT INTO public.tenants (id, name) VALUES (gen_random_uuid(), 'x')"),
      ),
    ).rejects.toThrow(/permission denied|does not exist/i);
  });

  it('module SQL cannot SET SESSION AUTHORIZATION to a privileged role', async () => {
    await expect(
      executor.runAsModule(MOD, (tx) => tx.unsafe('SET SESSION AUTHORIZATION sovecom').simple()),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cross-module: a module cannot reach another module's schema", async () => {
    const OTHER = 'itestb';
    await provisioner.deprovision(OTHER);
    await provisioner.provision(OTHER);
    executor.open(OTHER, await provisioner.rotateCredential(OTHER));
    try {
      await executor.execDdl(OTHER, 'CREATE TABLE secret (id int)');
      // From MOD's own connection, reaching into mod_itestb is denied by the DB.
      await expect(
        executor.runAsModule(MOD, (tx) => tx.unsafe('SELECT 1 FROM mod_itestb.secret')),
      ).rejects.toThrow(/permission denied|does not exist/i);
      // …and it cannot SET ROLE to the other module's role either.
      await expect(
        executor.runAsModule(MOD, (tx) => tx.unsafe('SET ROLE modrole_itestb')),
      ).rejects.toThrow(/permission denied|not.*member|does not exist/i);
    } finally {
      await executor.close(OTHER);
      await provisioner.deprovision(OTHER);
    }
  });

  it('rejects a stacked multi-statement runtime exec (single-statement contract)', async () => {
    await expect(executor.exec(MOD, 'SELECT 1; DROP TABLE IF EXISTS whatever')).rejects.toThrow(
      /single statement/i,
    );
  });

  it('the module role has NO USAGE on schema public (inherited PUBLIC grant revoked)', async () => {
    // Regression for the REVOKE-from-role no-op: USAGE on `public` is granted to the pseudo-role
    // PUBLIC, so REVOKE … FROM <role> does nothing. Provisioning must REVOKE … FROM PUBLIC, after
    // which has_schema_privilege(role, 'public', 'USAGE') is false.
    const res = await db.session.unsafe(
      `SELECT has_schema_privilege('modrole_${MOD}', 'public', 'USAGE') AS has_usage`,
    );
    expect((res[0] as { has_usage: boolean }).has_usage).toBe(false);
  });

  // ── normal operation ────────────────────────────────────────────────────────────
  it('applies a migration in the module schema + records it in the CORE-owned ledger', async () => {
    expect(await runner.applyPending(MOD, [initMigration])).toEqual(['0001_init']);
    expect(await runner.applyPending(MOD, [initMigration])).toEqual([]); // idempotent
    const ledger = await db.db
      .select()
      .from(moduleMigrations)
      .where(eq(moduleMigrations.module, MOD));
    expect(ledger.map((r) => r.migrationId)).toEqual(['0001_init']);
  });

  it('the module can read/write its OWN table through the executor', async () => {
    await executor.exec(MOD, 'INSERT INTO items (id, label) VALUES ($1, $2)', [1, 'hello']);
    const res = await executor.exec(MOD, 'SELECT id, label FROM items ORDER BY id');
    expect(res.rows).toEqual([{ id: 1, label: 'hello' }]);
  });

  it('cannot tamper the core ledger from module SQL (no access to public.module_migrations)', async () => {
    await expect(
      executor.runAsModule(MOD, (tx) => tx.unsafe('DELETE FROM public.module_migrations')),
    ).rejects.toThrow(/permission denied|does not exist/i);
  });

  it('refuses a changed already-applied migration (checksum integrity)', async () => {
    const tampered: ModuleMigration = { ...initMigration, up: initMigration.up + ' -- changed' };
    await expect(runner.applyPending(MOD, [tampered])).rejects.toThrow(/checksum|changed/i);
  });

  it('reverts a migration (drops the table, removes the ledger row)', async () => {
    await runner.revert(MOD, initMigration);
    await expect(executor.exec(MOD, 'SELECT 1 FROM items')).rejects.toThrow(/does not exist/i);
    expect(await runner.applyPending(MOD, [initMigration])).toEqual(['0001_init']);
  });

  it('deprovision removes the schema and role entirely', async () => {
    await executor.close(MOD);
    await provisioner.deprovision(MOD);
    const schemas = await db.session.unsafe(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'mod_${MOD}'`,
    );
    expect(schemas.length).toBe(0);
    const roles = await db.session.unsafe(
      `SELECT 1 FROM pg_roles WHERE rolname = 'modrole_${MOD}'`,
    );
    expect(roles.length).toBe(0);
    // re-provision + reopen so afterAll is clean.
    await provisioner.provision(MOD);
    executor.open(MOD, await provisioner.rotateCredential(MOD));
  });
});
