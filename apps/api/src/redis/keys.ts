const NS = 'sovecom';

export const keys = {
  tenant(tenantId: string): string {
    return `${NS}:t:${tenantId}`;
  },

  cart(tenantId: string, sessionId: string): string {
    return `${keys.tenant(tenantId)}:cart:${sessionId}`;
  },

  session(tenantId: string, sessionId: string): string {
    return `${keys.tenant(tenantId)}:session:${sessionId}`;
  },

  inventoryReservation(tenantId: string, variantId: string): string {
    return `${keys.tenant(tenantId)}:invres:${variantId}`;
  },

  /** Per-tenant set of cartIds that have pending Postgres writes. */
  cartDirty(tenantId: string): string {
    return `${keys.tenant(tenantId)}:cart:dirty`;
  },
};
