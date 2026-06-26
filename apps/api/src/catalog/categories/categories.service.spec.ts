/**
 * CategoriesService unit tests (test-first).
 *
 * Tests: slug gen helpers, depth computation, cycle detection.
 */
import { slugify } from '../products/products.service';
import { computeDepth, wouldCreateCycle, subtreeHeight } from './categories.service';

// ── slugify (reused from products) ─────────────────────────────────────────

describe('slugify() — categories', () => {
  it('lowercases and hyphens', () => {
    expect(slugify('Men Clothing')).toBe('men-clothing');
  });

  it('strips diacritics', () => {
    expect(slugify('Été & Été')).toBe('ete-ete');
  });

  it('strips leading/trailing hyphens', () => {
    expect(slugify('--Tops--')).toBe('tops');
  });
});

// ── computeDepth ─────────────────────────────────────────────────────────────

describe('computeDepth()', () => {
  /**
   * `computeDepth(parentId, ancestorMap)` returns the depth of the node
   * identified by `parentId` (1 = root). The new child's depth = result + 1.
   *
   * `ancestorMap` contains every ancestor from `parentId` up to the root,
   * mapping each id → its parentId (null if root).
   */

  it('returns 1 when parentId is null (creating a root node)', () => {
    // No parent means the new node IS the root at depth 1.
    expect(computeDepth(null, new Map())).toBe(1);
  });

  it('returns 1 for a direct root node (no ancestors)', () => {
    // parentId = 'root', root.parentId = null → root is at depth 1.
    const ancestors = new Map<string, string | null>([['root', null]]);
    expect(computeDepth('root', ancestors)).toBe(1);
  });

  it('returns 2 for a child-of-root node', () => {
    // parentId = 'child', child.parentId = 'root', root.parentId = null.
    // child is at depth 2.
    const ancestors = new Map<string, string | null>([
      ['child', 'root'],
      ['root', null],
    ]);
    expect(computeDepth('child', ancestors)).toBe(2);
  });

  it('returns 4 for a deeply nested node D where A→B→C→D', () => {
    const ancestors = new Map<string, string | null>([
      ['D', 'C'],
      ['C', 'B'],
      ['B', 'A'],
      ['A', null],
    ]);
    // D is at depth 4. New child of D would be at depth 5 = MAX → allowed.
    expect(computeDepth('D', ancestors)).toBe(4);
  });

  it('returns 1 when the ancestor map is empty and parentId is null', () => {
    expect(computeDepth(null, new Map())).toBe(1);
  });
});

// ── wouldCreateCycle ──────────────────────────────────────────────────────────

describe('wouldCreateCycle()', () => {
  /**
   * Ancestor map: id → parentId (null = root).
   * This mirrors the data the repository returns for walking the tree.
   */

  it('returns false for a completely unrelated parent', () => {
    // Tree: A → B → C (C's children can be reparented to A without cycle)
    const descendants = new Map<string, string | null>([['C', null]]);
    // Re-parent C under A (A is not a descendant of C)
    expect(wouldCreateCycle('C', 'A', descendants)).toBe(false);
  });

  it('returns true when setting parent = self', () => {
    const descendants = new Map<string, string | null>();
    expect(wouldCreateCycle('A', 'A', descendants)).toBe(true);
  });

  it('returns true for a direct cycle: A → B, try B.parent = A but A.parent = B', () => {
    // Descendants of B: A (A is already a child of B)
    // If we set A.parent = B the cycle would be A→B→A — but the map holds
    // *descendants* here keyed by id, mapping to their parent.
    // For wouldCreateCycle we check: is `newParentId` a descendant of `nodeId`?
    // So for cycle: nodeId=B, newParentId=A, and A is a child of B.
    const descendantsOfB = new Map<string, string | null>([['A', 'B']]);
    expect(wouldCreateCycle('B', 'A', descendantsOfB)).toBe(true);
  });

  it('detects deep cycle: A→B→C, try set A.parent=C', () => {
    // C is a descendant of A (A→B→C). Setting A.parent=C creates cycle.
    // descendantsOfA includes B and C.
    const descendants = new Map<string, string | null>([
      ['B', 'A'],
      ['C', 'B'],
    ]);
    expect(wouldCreateCycle('A', 'C', descendants)).toBe(true);
  });

  it('returns false when moving to a sibling (no overlap)', () => {
    // Tree: root → A, root → B, A has child A1.
    // Move A1 under B: B is not in descendants of A1.
    const descendantsOfA1 = new Map<string, string | null>();
    expect(wouldCreateCycle('A1', 'B', descendantsOfA1)).toBe(false);
  });
});

// ── subtreeHeight (F1 BLOCKER guard) ──────────────────────────────────────────

describe('subtreeHeight()', () => {
  /**
   * `subtree()` returns rows with `depth` RELATIVE to the moved root (root = 1).
   * subtreeHeight is the max of those — the number of levels the moved subtree
   * occupies. Re-parent guard: newParentDepth + height must be ≤ MAX_DEPTH(5).
   */

  it('is 1 for a leaf root (no children)', () => {
    expect(subtreeHeight([{ depth: 1 }])).toBe(1);
  });

  it('is 3 for a 3-level subtree X1→X2→X3', () => {
    // Rows returned by subtree(X1): X1@1, X2@2, X3@3.
    expect(subtreeHeight([{ depth: 1 }, { depth: 2 }, { depth: 3 }])).toBe(3);
  });

  it('takes the max across a branchy subtree (unordered rows)', () => {
    // X1@1 with two branches; deepest is depth 4.
    expect(
      subtreeHeight([{ depth: 1 }, { depth: 2 }, { depth: 4 }, { depth: 2 }, { depth: 3 }]),
    ).toBe(4);
  });

  it('is 0 for an empty subtree (defensive)', () => {
    expect(subtreeHeight([])).toBe(0);
  });

  it('proves the F1 guard math: parentDepth(3) + height(3) = 6 > 5 → would reject', () => {
    // A subtree of height 3 re-parented under a depth-3 category bottoms out at
    // depth 6, which the service rejects (3 + 3 > MAX_CATEGORY_DEPTH=5).
    const height = subtreeHeight([{ depth: 1 }, { depth: 2 }, { depth: 3 }]);
    const parentDepth = 3;
    expect(parentDepth + height).toBeGreaterThan(5);
  });

  it('proves a legal move passes: parentDepth(2) + height(3) = 5 ≤ 5 → allowed', () => {
    const height = subtreeHeight([{ depth: 1 }, { depth: 2 }, { depth: 3 }]);
    const parentDepth = 2;
    expect(parentDepth + height).toBeLessThanOrEqual(5);
  });
});
