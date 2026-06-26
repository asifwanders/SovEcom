/**
 * Stacking resolver. PURE, deterministic.
 *
 * Rules:
 *  - Non-stackable + non-stackable → only ONE applies: the single LARGEST-saving one
 *    (best for the customer).
 *  - Non-stackable + stackable     → both apply.
 *  - Stackable + stackable         → both apply.
 *
 * So: among the NON-stackable candidates keep only the largest-saving; keep ALL
 * stackable. The combined survivors are ordered LARGEST-saving FIRST so the
 * downstream grandTotal clamp favours the customer (the biggest discount is taken
 * before any headroom runs out). Ties (equal amount) break by `discountId` for a
 * stable, deterministic order.
 */

export interface StackingCandidate {
  amount: number;
  discountId: string;
  stackable: boolean;
}

/** Order by amount DESC, then discountId ASC (deterministic tie-break). */
function byAmountDescThenId(a: StackingCandidate, b: StackingCandidate): number {
  if (b.amount !== a.amount) return b.amount - a.amount;
  return a.discountId < b.discountId ? -1 : a.discountId > b.discountId ? 1 : 0;
}

export function resolveStacking<T extends StackingCandidate>(scored: T[]): T[] {
  const stackable: T[] = [];
  let bestNonStackable: T | null = null;

  for (const s of scored) {
    if (s.stackable) {
      stackable.push(s);
      continue;
    }
    if (
      bestNonStackable === null ||
      byAmountDescThenId(s, bestNonStackable) < 0 // s sorts before current best → larger (or tie-id smaller)
    ) {
      bestNonStackable = s;
    }
  }

  const survivors = [...stackable];
  if (bestNonStackable !== null) survivors.push(bestNonStackable);
  survivors.sort(byAmountDescThenId);
  return survivors;
}
