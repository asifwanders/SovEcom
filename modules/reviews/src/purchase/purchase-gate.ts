/**
 * reviews — the purchase-gate seam. A review may be left only by a customer who actually purchased
 * the product.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * GAP CLOSED (follow-up B1): the module read surface now exposes a narrow, boolean-only purchase
 * probe — `sdk.commerce.hasPurchased(customerId, productId)` — gated by the module's EXISTING
 * `read:orders` permission. Core answers ONLY a boolean (no order rows/line items leak); the query is
 * tenant-scoped from the broker context and matches a paid (or later) order for that customer
 * containing that product. So a (customer, product) purchase is now GENUINELY verifiable.
 *
 * DESIGN (still honest, still one seam): the whole purchase decision is funnelled through ONE seam,
 * {@link hasPurchased}, which delegates to an injected {@link PurchaseVerifier}. The DEFAULT is now
 * {@link commercePurchaseVerifier}, which calls `sdk.commerce.hasPurchased` and returns its real
 * verdict — purchaser → true (review pending), non-purchaser → false (403). The seam stays injectable
 * so tests can stub the verdict deterministically without a DB. The previous default-deny
 * {@link denyUnverifiablePurchaseVerifier} is retained for callers with no commerce read.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { CommerceClient } from '@sovecom/module-sdk';

/**
 * The verdict port the gate delegates to. An implementation answers "did THIS customer purchase
 * THIS product?" using whatever signal the runtime can provide. It is given the gated commerce
 * client so the real implementation can call `hasPurchased`.
 */
export interface PurchaseVerifier {
  /**
   * @returns `true` only when the customer's purchase of the product can be POSITIVELY established.
   *          Must NEVER return `true` on an inability to check — an unprovable purchase is a deny.
   */
  verify(input: {
    readonly customerId: string;
    readonly productId: string;
    readonly commerce: CommerceClient;
  }): Promise<boolean>;
}

/**
 * The RUNTIME default (B1): delegates to the gated `read:orders` commerce probe. Returns core's real
 * boolean verdict. On a thrown/failed probe it DENIES (returns `false`) — an unprovable purchase is
 * never a pass (secure-by-default).
 */
export const commercePurchaseVerifier: PurchaseVerifier = {
  async verify({ customerId, productId, commerce }): Promise<boolean> {
    try {
      return await commerce.hasPurchased(customerId, productId);
    } catch {
      return false;
    }
  },
};

/**
 * The pre-B1 default-deny verifier: returns `false` unconditionally. Retained for callers with no
 * commerce read (the seam used to ship CLOSED). The live module now uses {@link commercePurchaseVerifier}.
 */
export const denyUnverifiablePurchaseVerifier: PurchaseVerifier = {
  verify(): Promise<boolean> {
    return Promise.resolve(false);
  },
};

/**
 * The single purchase-gate seam every review write routes through. It calls the gated commerce probe
 * via the injected verifier — purchaser → true, non-purchaser → false. The `read:orders` grant is
 * exercised for real (the static contract scan sees `sdk.commerce.hasPurchased` used).
 *
 * @param commerce the gated `read:orders` commerce surface (`sdk.commerce`).
 * @param verifier the verdict implementation (defaults to the real commerce verifier).
 */
export async function hasPurchased(
  commerce: CommerceClient,
  customerId: string,
  productId: string,
  verifier: PurchaseVerifier = commercePurchaseVerifier,
): Promise<boolean> {
  if (customerId.length === 0 || productId.length === 0) return false;
  return verifier.verify({ customerId, productId, commerce });
}
