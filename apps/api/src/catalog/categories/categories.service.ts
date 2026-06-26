/**
 * CategoriesService.
 *
 * Business rules:
 *   1. Slug generation + collision retry (mirrors products.service).
 *   2. Max depth = 5; creating/re-parenting beyond depth 5 → 422.
 *   3. Cycle prevention: reject if newParent is self or a descendant.
 *   4. Delete block: if category has children → 409.
 *   5. Tenant isolation: every DB call through repository with tenantId.
 *   6. Audit every admin mutation.
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../database/database.service';
import { isUniqueViolation } from '../../common/pg-error.util';
import { slugify } from '../products/products.service';
import {
  CategoriesRepository,
  type CategoryAncestorRow,
  type CategoryRow,
  type DbTx,
} from './categories.repository';
import type { CreateCategoryDto } from './dto/create-category.dto';
import type { UpdateCategoryDto } from './dto/update-category.dto';
import type { StoreCategoryDto } from './dto/store-category.dto';

export const MAX_CATEGORY_DEPTH = 5;
const MAX_SLUG_RETRIES = 20;

/**
 * Slugs that would shadow a sibling literal route under /store/v1/categories
 * (Fable nit). A category slugged `tree` would collide with
 * GET /store/v1/categories/tree. Generated slugs in this set get the dedupe
 * suffix applied so the literal route always wins.
 */
const RESERVED_CATEGORY_SLUGS = new Set(['tree']);

/**
 * Compute the HEIGHT of a subtree (number of levels from the root down to its
 * deepest descendant, inclusive) given the per-node relative depths returned by
 * `CategoriesRepository.subtree` (root = 1). A leaf root has height 1.
 *
 * Exported for unit testing. Used by the re-parent depth guard (F1): a moved
 * node's new bottom depth = newParentDepth + subtreeHeight; that must be ≤ MAX.
 */
export function subtreeHeight(rows: Array<{ depth: number }>): number {
  let max = 0;
  for (const r of rows) {
    if (r.depth > max) max = r.depth;
  }
  return max;
}

/**
 * Compute the depth of a node given its parentId and an ancestor-chain map.
 *
 * `ancestorMap` maps each id → parentId|null and should contain every
 * ancestor up to (and including) the immediate parent.
 *
 * Returns 1 if parentId is null (root level), otherwise walks the chain.
 *
 * Exported for unit testing.
 */
export function computeDepth(
  parentId: string | null,
  ancestorMap: Map<string, string | null>,
): number {
  if (parentId === null) return 1;
  // Count the depth of the parentId node (1 = root).
  let depth = 1;
  let current: string | null = parentId;
  while (current !== null) {
    const parent = ancestorMap.get(current);
    if (parent === undefined) break; // reached a node not in the map (treat as root)
    if (parent !== null) depth++;
    current = parent;
  }
  return depth;
}

/**
 * Returns true if setting `nodeId`'s parent to `newParentId` would create a
 * cycle. A cycle exists when `newParentId` equals `nodeId` (self-loop) or is
 * already a descendant of `nodeId`.
 *
 * `descendantMap` is a flat map of the subtree rooted at `nodeId`
 * (id → parentId) as returned by `CategoriesRepository.subtree`.
 *
 * Exported for unit testing.
 */
export function wouldCreateCycle(
  nodeId: string,
  newParentId: string,
  descendantMap: Map<string, string | null>,
): boolean {
  if (nodeId === newParentId) return true;
  return descendantMap.has(newParentId);
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly repo: CategoriesRepository,
    private readonly audit: AuditService,
    private readonly db: DatabaseService,
  ) {}

  // ── Slug generation ────────────────────────────────────────────────────────

  async generateUniqueSlug(tenantId: string, base: string, excludeId?: string): Promise<string> {
    const baseSlug = slugify(base);
    // Fable nit: never hand out a slug that shadows a literal sibling route.
    if (
      !RESERVED_CATEGORY_SLUGS.has(baseSlug) &&
      !(await this.repo.slugExists(tenantId, baseSlug, excludeId))
    ) {
      return baseSlug;
    }
    for (let i = 2; i <= MAX_SLUG_RETRIES; i++) {
      const candidate = `${baseSlug}-${i}`;
      if (
        !RESERVED_CATEGORY_SLUGS.has(candidate) &&
        !(await this.repo.slugExists(tenantId, candidate, excludeId))
      ) {
        return candidate;
      }
    }
    return `${baseSlug}-${uuidv7().slice(-8)}`;
  }

  // ── Parent resolution (F3) ───────────────────────────────────────────────

  /**
   * Resolve `parentId` within the tenant and return its 1-indexed depth.
   *
   * F3 (Fable): a parentId that doesn't resolve in-tenant (bogus or another
   * tenant's id) used to slip past the guards (empty ancestors() ⇒ depth 1) and
   * then hit the composite FK as a raw 23503 → unhandled 500. We resolve it
   * FIRST and return a clean 404 so the error contract is correct.
   */
  private async resolveParentDepth(tenantId: string, parentId: string, tx?: DbTx): Promise<number> {
    const parent = await this.repo.findById(tenantId, parentId, tx);
    if (!parent) {
      throw new NotFoundException(`Parent category ${parentId} not found`);
    }
    const chain = await this.repo.ancestors(tenantId, parentId, tx);
    const ancestorMap = new Map<string, string | null>(
      chain.map((r: CategoryAncestorRow) => [r.id, r.parentId]),
    );
    return computeDepth(parentId, ancestorMap);
  }

  // ── Create depth guard ───────────────────────────────────────────────────

  /**
   * Depth guard for CREATE (a leaf node of height 1). Rejects 422 if the new
   * node would sit below depth {@link MAX_CATEGORY_DEPTH}.
   */
  private async assertCreateDepth(
    tenantId: string,
    parentId: string | null | undefined,
  ): Promise<void> {
    if (!parentId) return; // root → depth 1
    const parentDepth = await this.resolveParentDepth(tenantId, parentId);
    // New leaf depth = parentDepth + 1.
    if (parentDepth + 1 > MAX_CATEGORY_DEPTH) {
      throw new UnprocessableEntityException(
        `Maximum category depth is ${MAX_CATEGORY_DEPTH}. This category would exceed it.`,
      );
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    actorId: string,
    dto: CreateCategoryDto,
    ip?: string,
    userAgent?: string,
  ): Promise<CategoryRow> {
    // F3: resolve + depth-check the parent BEFORE insert (404 on bogus/cross-tenant).
    await this.assertCreateDepth(tenantId, dto.parentId);

    const slug = dto.slug
      ? await this.generateUniqueSlug(tenantId, dto.slug)
      : await this.generateUniqueSlug(tenantId, dto.name);

    const id = uuidv7();

    let category: CategoryRow;
    try {
      category = await this.repo.insert({
        id,
        tenantId,
        parentId: dto.parentId ?? null,
        name: dto.name,
        slug,
        description: dto.description ?? null,
        seoTitle: dto.seoTitle ?? null,
        seoDescription: dto.seoDescription ?? null,
        position: dto.position ?? 0,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const retrySlug = await this.generateUniqueSlug(tenantId, dto.slug ?? dto.name);
        category = await this.repo.insert({
          id,
          tenantId,
          parentId: dto.parentId ?? null,
          name: dto.name,
          slug: retrySlug,
          description: dto.description ?? null,
          seoTitle: dto.seoTitle ?? null,
          seoDescription: dto.seoDescription ?? null,
          position: dto.position ?? 0,
        });
      } else {
        throw err;
      }
    }

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'category.created',
      resourceType: 'category',
      resourceId: id,
      ip,
      userAgent,
      changes: { name: dto.name, slug, parentId: dto.parentId ?? null },
    });

    return category;
  }

  // ── List (admin, flat) ─────────────────────────────────────────────────────

  async adminList(tenantId: string): Promise<CategoryRow[]> {
    return this.repo.findAll(tenantId);
  }

  // ── Get by ID (admin) ──────────────────────────────────────────────────────

  async adminFindById(tenantId: string, id: string): Promise<CategoryRow> {
    const cat = await this.repo.findById(tenantId, id);
    if (!cat) throw new NotFoundException(`Category ${id} not found`);
    return cat;
  }

  // ── Update / PATCH ─────────────────────────────────────────────────────────

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdateCategoryDto,
    ip?: string,
    userAgent?: string,
  ): Promise<CategoryRow> {
    const existing = await this.repo.findById(tenantId, id);
    if (!existing) throw new NotFoundException(`Category ${id} not found`);

    const isReparenting = dto.parentId !== undefined && dto.parentId !== existing.parentId;

    let newSlug: string | undefined;
    if (dto.slug && dto.slug !== existing.slug) {
      newSlug = await this.generateUniqueSlug(tenantId, dto.slug, id);
    }
    // Name-only change keeps the existing slug (consistent with products 1.6).

    // Audit-diff completeness (Fable nit): record EVERY field that changed,
    // including description/seoTitle/seoDescription — not just name/slug/parent.
    const changes: Record<string, unknown> = {};
    if (dto.name !== undefined && dto.name !== existing.name) changes['name'] = dto.name;
    if (newSlug) changes['slug'] = newSlug;
    if (isReparenting) changes['parentId'] = dto.parentId ?? null;
    if (dto.position !== undefined && dto.position !== existing.position) {
      changes['position'] = dto.position;
    }
    if (dto.description !== undefined && dto.description !== existing.description) {
      changes['description'] = dto.description;
    }
    if (dto.seoTitle !== undefined && dto.seoTitle !== existing.seoTitle) {
      changes['seoTitle'] = dto.seoTitle;
    }
    if (dto.seoDescription !== undefined && dto.seoDescription !== existing.seoDescription) {
      changes['seoDescription'] = dto.seoDescription;
    }

    const patch = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.seoTitle !== undefined ? { seoTitle: dto.seoTitle } : {}),
      ...(dto.seoDescription !== undefined ? { seoDescription: dto.seoDescription } : {}),
      ...(dto.position !== undefined ? { position: dto.position } : {}),
      ...(isReparenting ? { parentId: dto.parentId ?? null } : {}),
      ...(newSlug ? { slug: newSlug } : {}),
    };

    let updated: CategoryRow | null;

    if (isReparenting && dto.parentId) {
      // F1 + F2: re-parenting under a real parent must serialize per-tenant and
      // validate cycle + FULL-SUBTREE depth on a consistent snapshot inside ONE
      // transaction, so two concurrent PATCHes cannot both pass the checks and
      // commit a cycle or an over-depth tree.
      updated = await this.db.db.transaction(async (tx) => {
        await this.repo.lockTenant(tx, tenantId);

        const newParentId = dto.parentId!;

        // (a) Cycle + height of the moved subtree, computed together from the
        //     SAME subtree read (F1: previously only the new parent's depth was
        //     checked, never the moved node's descendants).
        const subtreeRows = await this.repo.subtree(tenantId, id, tx);
        const descendantMap = new Map<string, string | null>(
          subtreeRows.map((r) => [r.id, r.parentId]),
        );
        if (wouldCreateCycle(id, newParentId, descendantMap)) {
          throw new UnprocessableEntityException(
            'Circular category reference: the target parent is a descendant of this category.',
          );
        }

        // (b) F3 + F1: resolve the parent (404 if bogus/cross-tenant) and assert
        //     newParentDepth + movedSubtreeHeight ≤ MAX_CATEGORY_DEPTH.
        const parentDepth = await this.resolveParentDepth(tenantId, newParentId, tx);
        const height = subtreeHeight(subtreeRows);
        if (parentDepth + height > MAX_CATEGORY_DEPTH) {
          throw new UnprocessableEntityException(
            `Maximum category depth is ${MAX_CATEGORY_DEPTH}. ` +
              `Re-parenting this subtree (height ${height}) under a depth-${parentDepth} ` +
              `category would exceed it.`,
          );
        }

        return this.repo.update(tenantId, id, patch, tx);
      });
    } else {
      // No re-parent (or moving to root): a plain update is safe.
      // Moving to root can never increase depth or create a cycle.
      updated = await this.repo.update(tenantId, id, patch);
    }

    if (!updated) throw new NotFoundException(`Category ${id} not found`);

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'category.updated',
      resourceType: 'category',
      resourceId: id,
      ip,
      userAgent,
      changes,
    });

    return updated;
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async delete(
    tenantId: string,
    actorId: string,
    id: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const existing = await this.repo.findById(tenantId, id);
    if (!existing) throw new NotFoundException(`Category ${id} not found`);

    // F2: atomic delete-if-no-children. A count-then-delete pair was a TOCTOU —
    // a child inserted between the two statements got CASCADE-wiped along with
    // the whole subtree. This deletes ONLY when no child exists at execution
    // time. On 0 rows deleted we re-check existence to return the correct 404
    // (vanished) vs 409 (a child appeared / still has children).
    const deleted = await this.repo.deleteIfNoChildren(tenantId, id);
    if (!deleted) {
      const stillExists = await this.repo.findById(tenantId, id);
      if (!stillExists) throw new NotFoundException(`Category ${id} not found`);
      throw new ConflictException(
        'This category has child categories. Move or delete child categories first.',
      );
    }

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'category.deleted',
      resourceType: 'category',
      resourceId: id,
      ip,
      userAgent,
      changes: { name: existing.name },
    });
  }

  // ── Store endpoints ────────────────────────────────────────────────────────

  async storeFlatList(tenantId: string): Promise<StoreCategoryDto[]> {
    const cats = await this.repo.findAll(tenantId);
    const ids = cats.map((c) => c.id);
    // store counts must reflect only PUBLISHED products (the public product surface
    // is published-only); draft/archived assignments must not leak into anonymous counts.
    const counts = await this.repo.publishedProductCounts(tenantId, ids);
    return cats.map((c) => this._toStoreDto(c, counts[c.id] ?? 0));
  }

  async storeTree(tenantId: string): Promise<StoreCategoryDto[]> {
    type TreeRow = CategoryAncestorRow & {
      name: string;
      slug: string;
      position: number;
      depth: number;
    };
    const rows = (await this.repo.tree(tenantId)) as TreeRow[];
    const ids = rows.map((r) => r.id);
    // published-only counts for the public store tree.
    const counts = await this.repo.publishedProductCounts(tenantId, ids);

    // Build map id → node (with children array).
    const nodeMap = new Map<string, StoreCategoryDto & { children: StoreCategoryDto[] }>();
    for (const row of rows) {
      nodeMap.set(row.id, {
        id: row.id,
        slug: row.slug,
        name: row.name,
        position: row.position,
        parentId: row.parentId,
        productCount: counts[row.id] ?? 0,
        children: [],
      });
    }

    // Assemble tree.
    const roots: StoreCategoryDto[] = [];
    for (const row of rows) {
      const node = nodeMap.get(row.id)!;
      if (row.parentId === null) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(row.parentId);
        if (parent) {
          (parent.children ??= []).push(node);
        } else {
          // Parent capped by depth limit — promote to root in output.
          roots.push(node);
        }
      }
    }
    return roots;
  }

  async storeFindBySlug(tenantId: string, slug: string): Promise<StoreCategoryDto> {
    const cat = await this.repo.findBySlug(tenantId, slug);
    if (!cat) throw new NotFoundException(`Category not found`);
    // published-only count for the public category page.
    const counts = await this.repo.publishedProductCounts(tenantId, [cat.id]);
    return this._toStoreDto(cat, counts[cat.id] ?? 0);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _toStoreDto(cat: CategoryRow, productCount: number): StoreCategoryDto {
    return {
      id: cat.id,
      slug: cat.slug,
      name: cat.name,
      position: cat.position,
      parentId: cat.parentId,
      productCount,
    };
  }
}
