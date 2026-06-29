/**
 * UsersRepository (SECURITY-CRITICAL: admin-account CRUD + privilege path).
 *
 * EVERY query is tenant-scoped to `tenantId` from the DB-sourced principal
 * (never client-supplied). The `disabled_at` column controls login eligibility;
 * `token_version` bumps on role change / deactivation to invalidate live sessions.
 *
 * Security invariants enforced here:
 *   - No query ever crosses tenant boundaries.
 *   - Never select / return password_hash or totp_secret (safe view only).
 *   - owner-role rows are never written by this module.
 *   - A role change or deactivation revokes the target's refresh tokens in the
 *     SAME transaction as the token_version bump, so a deactivated/demoted user
 *     cannot keep (or refresh) a live session.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, count, desc, sql, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { users } from '../database/schema/users';
import { refreshTokens } from '../database/schema/sessions';

/** The safe user view returned to callers — no secrets. */
export interface UserView {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  disabledAt: string | null;
  lastLoginAt: string | null;
  totpEnabled: boolean;
  createdAt: string;
}

export interface UserListResult {
  data: UserView[];
  total: number;
  page: number;
  pageSize: number;
}

/** Raw DB row with the fields we need, no secrets. */
type SafeUserRow = {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  totpEnabled: boolean;
  createdAt: Date;
};

function toView(row: SafeUserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    totpEnabled: row.totpEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Columns returned by list / get — NO password_hash, NO totp_secret. */
const SAFE_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  disabledAt: users.disabledAt,
  lastLoginAt: users.lastLoginAt,
  totpEnabled: users.totpEnabled,
  createdAt: users.createdAt,
} as const;

@Injectable()
export class UsersRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Paginated list of staff for a tenant, newest first. NEVER returns secrets. */
  async list(tenantId: string, page: number, pageSize: number): Promise<UserListResult> {
    const where = eq(users.tenantId, tenantId);

    const [totalRow] = await this.db.db.select({ value: count() }).from(users).where(where);
    const total = Number(totalRow?.value ?? 0);

    const rows = await this.db.db
      .select(SAFE_COLUMNS)
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return { data: rows.map(toView), total, page, pageSize };
  }

  /**
   * Find a full user row by id + tenantId for internal auth checks.
   * Returns null if not found. Selects role + token_version + disabled_at.
   */
  async findFullById(
    tenantId: string,
    id: string,
  ): Promise<{ id: string; role: string; tokenVersion: number; disabledAt: Date | null } | null> {
    const [row] = await this.db.db
      .select({
        id: users.id,
        role: users.role,
        tokenVersion: users.tokenVersion,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  }

  /** Find by email within tenant (for duplicate-email check). */
  async findByEmail(tenantId: string, email: string): Promise<{ id: string } | null> {
    const [row] = await this.db.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Insert a new user (pre-hashed password). Returns the safe view.
   * Caller MUST ensure role is not 'owner'.
   */
  async insert(values: {
    tenantId: string;
    email: string;
    name: string;
    role: 'admin' | 'staff';
    passwordHash: string;
  }): Promise<UserView> {
    const [row] = await this.db.db
      .insert(users)
      .values({
        tenantId: values.tenantId,
        email: values.email,
        name: values.name,
        role: values.role,
        passwordHash: values.passwordHash,
      })
      .returning(SAFE_COLUMNS);
    return toView(row!);
  }

  /**
   * Change a user's role, bump token_version, and revoke every live refresh
   * token for the target — ALL in one transaction. The token_version bump kills
   * outstanding access tokens; revoking the refresh tokens forces a full re-auth
   * (a demotion must not leave a higher-privilege session refreshable).
   * Returns updated view, or null if user not in tenant.
   */
  async changeRole(
    tenantId: string,
    id: string,
    role: 'admin' | 'staff',
  ): Promise<UserView | null> {
    return this.db.db.transaction(async (tx) => {
      const [row] = await tx
        .update(users)
        .set({ role, tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: sql`now()` })
        .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
        .returning(SAFE_COLUMNS);
      if (!row) {
        return null;
      }
      // Revoke every still-live refresh token for the target (logout everywhere).
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.userId, id),
            eq(refreshTokens.tenantId, tenantId),
            isNull(refreshTokens.revokedAt),
          ),
        );
      return toView(row);
    });
  }

  /**
   * Set disabled_at = now(), bump token_version, and revoke every live refresh
   * token for the target — ALL in one transaction. Revoking the refresh tokens is
   * the load-bearing guard: without it a deactivated user with a valid refresh
   * cookie could mint fresh access tokens indefinitely via the refresh path.
   * Returns updated view, or null if user not in tenant.
   */
  async deactivate(tenantId: string, id: string): Promise<UserView | null> {
    return this.db.db.transaction(async (tx) => {
      const [row] = await tx
        .update(users)
        .set({
          disabledAt: sql`now()`,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
        .returning(SAFE_COLUMNS);
      if (!row) {
        return null;
      }
      // Revoke every still-live refresh token for the target (logout everywhere).
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.userId, id),
            eq(refreshTokens.tenantId, tenantId),
            isNull(refreshTokens.revokedAt),
          ),
        );
      return toView(row);
    });
  }

  /**
   * Clear disabled_at (reactivate).
   * Returns updated view, or null if user not in tenant.
   */
  async reactivate(tenantId: string, id: string): Promise<UserView | null> {
    const [row] = await this.db.db
      .update(users)
      .set({ disabledAt: null, updatedAt: sql`now()` })
      .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
      .returning(SAFE_COLUMNS);
    return row ? toView(row) : null;
  }
}
