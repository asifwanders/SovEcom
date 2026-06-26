/**
 * Per-module database provisioning.
 *
 * Runs PRIVILEGED DDL (as the app role) to stand up / tear down a module's isolated database
 * home: a schema `mod_<name>` owned by a LOGIN role `modrole_<name>` that has rights on ONLY that
 * schema and none on core. Module SQL later runs on a connection authenticated AS that role (see
 * {@link ModuleSqlExecutor}) — so the role is LOGIN, and crucially the app role does NOT grant the
 * module role to itself.
 *
 * The role's password is EPHEMERAL: {@link rotateCredential} mints a fresh random one on each
 * enable and returns it to the runtime (held in memory only, never persisted). Requires the app
 * DB role to have CREATEROLE (superuser in dev).
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { DatabaseService } from '../../database/database.service';
import {
  assertModuleName,
  quotedRole,
  quotedSchema,
  roleName,
  schemaName,
} from './module-identifier';

@Injectable()
export class ModuleDbProvisioner {
  private readonly logger = new Logger(ModuleDbProvisioner.name);

  constructor(private readonly database: DatabaseService) {}

  private get sql() {
    return this.database.session;
  }

  /**
   * Idempotently create the module's LOGIN role + owned schema, lock it down, and pin safe role
   * defaults. The role starts with NO password (cannot connect until {@link rotateCredential}).
   * The app role is deliberately NOT granted membership in the module role.
   */
  async provision(name: string): Promise<void> {
    assertModuleName(name);
    const role = quotedRole(name);
    const schema = quotedSchema(name);
    const roleLiteral = roleName(name);

    await this.sql.unsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleLiteral}') THEN
           CREATE ROLE ${role} LOGIN PASSWORD NULL;
         END IF;
       END $$;`,
    );
    await this.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role}`);
    // Never reach core. The default USAGE/CREATE on schema `public` is granted to the PSEUDO-ROLE
    // PUBLIC, so every role (including this module role) inherits it — `REVOKE … FROM ${role}` is a
    // NO-OP against that inherited grant. We must REVOKE FROM PUBLIC, and likewise strip the default
    // EXECUTE-on-functions grant PUBLIC carries, so the module role has no usable access to public.
    // These act on the SHARED public schema, but REVOKE-from-PUBLIC is idempotent and safe to re-run
    // per provision(). Then pin the role's defaults so even a missing per-tx SET cannot expose
    // public, and runaway statements/txns are bounded.
    await this.sql.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await this.sql.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    );
    await this.sql.unsafe(`ALTER ROLE ${role} SET search_path TO ${schema}`);
    await this.sql.unsafe(`ALTER ROLE ${role} SET statement_timeout TO '5s'`);
    await this.sql.unsafe(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout TO '10s'`);
    // DB-enforced connection cap (defence in depth over the app-layer per-module pool size).
    await this.sql.unsafe(`ALTER ROLE ${role} CONNECTION LIMIT 5`);
    this.logger.log(`provisioned module DB home: schema ${schemaName(name)} / role ${roleLiteral}`);
  }

  /**
   * Mint a fresh random password for the module role and return it (memory-only — never stored).
   * Called on enable, immediately before the runtime opens the module connection. The password is
   * hex (no quote/backslash) so it is safe to interpolate into the ALTER ROLE literal.
   */
  async rotateCredential(name: string): Promise<string> {
    assertModuleName(name);
    const role = quotedRole(name);
    const password = randomBytes(24).toString('hex');
    await this.sql.unsafe(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    return password;
  }

  /**
   * Fully remove the module's DB home: DROP SCHEMA CASCADE + the role. Used by uninstall WHEN the
   * admin confirms data deletion; disable never calls this. Each step is guarded so
   * a partial state can't leave a dangling role: the schema drop and role drop are independent and
   * idempotent, and the role is only dropped once it owns nothing.
   */
  async deprovision(name: string): Promise<void> {
    assertModuleName(name);
    const role = quotedRole(name);
    const schema = quotedSchema(name);
    const roleLiteral = roleName(name);

    // Terminate any lingering sessions for this role first — otherwise DROP SCHEMA blocks on the
    // lock and DROP ROLE fails ("objects depend on it"), leaving a dangling role. (The runtime
    // closes the module connection on disable; this is defence in depth for uninstall ordering.)
    await this.sql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`,
      [roleLiteral],
    );
    await this.sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await this.sql.unsafe(
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleLiteral}') THEN
           EXECUTE 'DROP OWNED BY ${role}';
           EXECUTE 'DROP ROLE ${role}';
         END IF;
       END $$;`,
    );
    // The schema (and its tables) are gone — clear the module's migration ledger too, so a
    // future reinstall starts fresh rather than thinking migrations are already applied.
    await this.sql.unsafe(`DELETE FROM module_migrations WHERE module = $1`, [name]);
    this.logger.log(`deprovisioned module DB home: ${schemaName(name)} / ${roleLiteral}`);
  }
}
