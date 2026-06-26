/**
 * the authenticated CUSTOMER principal (SECURITY-CRITICAL.1).
 *
 * The shape {@link CustomerAuthGuard} attaches to `req.customer` AFTER loading the
 * row from Postgres. `tenantId` comes from the DB ROW, never from the JWT claim —
 * the guard re-reads it so nothing downstream can trust a forged `tid`. This is a
 * DISTINCT principal from {@link AuthenticatedUser} (admin): a customer principal
 * never carries a `role` and never reaches an admin route.
 */
export interface AuthenticatedCustomer {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  isB2b: boolean;
}
