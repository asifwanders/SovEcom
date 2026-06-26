/**
 * The authenticated principal (SECURITY-CRITICAL).
 *
 * This is the shape {@link JwtAuthGuard} attaches to `req.user` AFTER loading the
 * row from Postgres. `tenantId` and `role` come from the DB ROW, never from the
 * (attacker-influenceable) JWT claim — the guard re-reads them so nothing
 * downstream can trust a forged `tid`/`role`.
 */
export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  totpEnabled: boolean;
}
