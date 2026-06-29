/**
 * UsersService — admin staff-accounts management (SECURITY-CRITICAL).
 *
 * Enforces ALL security guards mandated by the spec:
 *   - role ∈ {admin, staff} only — 'owner' rejected on create/role-change.
 *   - Email lowercased, per-tenant unique (409 on conflict).
 *   - Password breach-checked + min-length (Zod layer), then argon2id-hashed.
 *   - Tenant-scope every operation via principal's tenantId (never client-supplied).
 *   - Cannot create/demote/deactivate/change-role for 'owner' users.
 *   - Cannot change own role or deactivate self (403).
 *   - token_version bumped on role-change and deactivate (invalidates live access
 *     tokens); the target's refresh tokens are also revoked (in the repository tx)
 *     so a demoted/deactivated user cannot refresh into a fresh session.
 *
 * Auditing is handled entirely by the @Audit decorator on the controller routes
 * + the global AuditInterceptor — this service makes NO direct audit.record()
 * calls (doing so would double-write the audit row).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PasswordService } from '../auth/services/password.service';
import { isBreachedPassword } from '../auth/services/breached-passwords';
import { UsersRepository, type UserView, type UserListResult } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    private readonly passwords: PasswordService,
  ) {}

  // ── List ──────────────────────────────────────────────────────────────────

  /** Paginated staff list for the tenant. */
  list(tenantId: string, page: number, pageSize: number): Promise<UserListResult> {
    return this.repo.list(tenantId, page, pageSize);
  }

  // ── Create ────────────────────────────────────────────────────────────────

  /**
   * Create a new staff account.
   * Guards: role ∈ {admin,staff}; breach-check + hash password; 409 on dup email.
   */
  async create(
    tenantId: string,
    dto: { email: string; name: string; role: 'admin' | 'staff'; password: string },
  ): Promise<UserView> {
    // The Zod DTO already validates role ∈ {admin,staff}, but a defence-in-depth
    // explicit check ensures no code path bypasses it.
    if (dto.role === ('owner' as string)) {
      throw new BadRequestException('Cannot create an owner account');
    }

    // Breach check (offline bundled list; no network egress — EU-privacy rule).
    if (isBreachedPassword(dto.password)) {
      throw new BadRequestException('password is too common or breached');
    }

    // email is already lowercased by the Zod DTO; store it as-is.
    const email = dto.email.toLowerCase();

    // 409 on duplicate email within the tenant.
    const existing = await this.repo.findByEmail(tenantId, email);
    if (existing) {
      throw new ConflictException('email already registered');
    }

    const passwordHash = await this.passwords.hash(dto.password);

    return this.repo.insert({
      tenantId,
      email,
      name: dto.name,
      role: dto.role,
      passwordHash,
    });
  }

  // ── Role change ───────────────────────────────────────────────────────────

  /**
   * Change the role of a staff member.
   * Guards: target must be same tenant; target role !== owner; self → 403.
   */
  async changeRole(
    tenantId: string,
    actorId: string,
    targetId: string,
    newRole: 'admin' | 'staff',
  ): Promise<UserView> {
    // Cannot change own role (self-lockout / self-escalation guard).
    if (actorId === targetId) {
      throw new ForbiddenException('Cannot change your own role');
    }

    // Load the target to check their current role + tenant membership.
    const target = await this.repo.findFullById(tenantId, targetId);
    if (!target) {
      // Not found OR wrong tenant — return 404 (no tenant-existence oracle).
      throw new NotFoundException('User not found');
    }

    // Owners are off-limits (setup singleton — cannot demote via this endpoint).
    if (target.role === 'owner') {
      throw new ForbiddenException('Cannot change an owner account');
    }

    const updated = await this.repo.changeRole(tenantId, targetId, newRole);
    // changeRole already verified the row belongs to the tenant; null is unreachable here.
    return updated!;
  }

  // ── Deactivate ────────────────────────────────────────────────────────────

  /**
   * Deactivate a staff member (set disabled_at = now, bump token_version).
   * Guards: same tenant; not owner; not self.
   */
  async deactivate(tenantId: string, actorId: string, targetId: string): Promise<UserView> {
    if (actorId === targetId) {
      throw new ForbiddenException('Cannot deactivate yourself');
    }

    const target = await this.repo.findFullById(tenantId, targetId);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    if (target.role === 'owner') {
      throw new ForbiddenException('Cannot deactivate an owner account');
    }

    const updated = await this.repo.deactivate(tenantId, targetId);
    return updated!;
  }

  // ── Reactivate ────────────────────────────────────────────────────────────

  /**
   * Reactivate a previously disabled user (clear disabled_at).
   * Same tenant guard via repository (null → 404).
   */
  async reactivate(tenantId: string, targetId: string): Promise<UserView> {
    const updated = await this.repo.reactivate(tenantId, targetId);
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated;
  }
}
