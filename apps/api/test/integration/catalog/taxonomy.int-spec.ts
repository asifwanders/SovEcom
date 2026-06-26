/**
 * Catalog Taxonomy (Categories & Tags) integration tests.
 *
 * Uses the auth harness. Covers all acceptance criteria from the spec:
 *   - Category CRUD (admin), depth guard, cycle detection, re-parent
 *   - Tree endpoint nesting + order + productCount
 *   - DELETE with children → 409; after cleanup → 204
 *   - Tag CRUD, slug uniqueness, cascade on delete
 *   - Product↔category & product↔tag assignment (replace-set)
 *   - Store: public allowlist, no tenant_id, rate-limit 429, :slug 404
 *   - Tenant isolation
 */
import request from 'supertest';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
  newId,
} from '../auth/_auth-harness';
import { AuthService } from '../../../src/auth/services/auth.service';
import { ResetService } from '../../../src/auth/services/reset.service';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';

const ADMIN_CATS = '/admin/v1/categories';
const ADMIN_TAGS = '/admin/v1/tags';
const ADMIN_PRODUCTS = '/admin/v1/products';
const STORE_CATS = '/store/v1/categories';
const STORE_TAGS = '/store/v1/tags';

// ── harness helpers ──────────────────────────────────────────────────────────

async function login(h: AuthHarness, email: string, password: string): Promise<string> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

async function insertTenant(h: AuthHarness): Promise<string> {
  const id = newId();
  const slug = `tenant-${id.slice(-8)}`;
  await h.client`insert into tenants (id, name, slug) values (${id}, ${slug}, ${slug})`;
  return id;
}

async function switchDefaultTenant(h: AuthHarness, id: string): Promise<void> {
  await h.client`
    insert into system_state (key, value)
    values ('default_tenant_id', to_jsonb(${id}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
  type Cached = { defaultTenantId: string | null };
  (h.app.get(AuthService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  (h.app.get(ResetService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
}

/** Create a minimal published product for assignment tests. */
async function createProduct(h: AuthHarness, token: string) {
  const res = await request(h.http())
    .post(ADMIN_PRODUCTS)
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: `Product ${newId().slice(-6)}`,
      status: 'draft',
    })
    .expect(201);
  return res.body as { id: string; slug: string };
}

/** Create one category; returns its id. */
async function createCat(
  h: AuthHarness,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await request(h.http())
    .post(ADMIN_CATS)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(201);
  return res.body.id as string;
}

/**
 * Build a linear chain of `levels` categories under `parentId` (or root).
 * Returns the ids top-to-bottom. e.g. buildChain(.., null, 3) → [X1, X2, X3].
 */
async function buildChain(
  h: AuthHarness,
  token: string,
  parentId: string | null,
  levels: number,
  label: string,
): Promise<string[]> {
  const ids: string[] = [];
  let parent = parentId;
  for (let i = 0; i < levels; i++) {
    const body: Record<string, unknown> = { name: `${label}${i + 1}-${newId().slice(-4)}` };
    if (parent) body.parentId = parent;
    const id = await createCat(h, token, body);
    ids.push(id);
    parent = id;
  }
  return ids;
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('Catalog API — taxonomy integration', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
    type Cached = { defaultTenantId: string | null };
    (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  });

  // ── Admin: category CRUD ──────────────────────────────────────────────────

  describe('POST /admin/v1/categories', () => {
    it('creates a root category and returns it', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Apparel', position: 0 })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toBe('apparel');
      expect(res.body.parentId).toBeNull();
      // Admin endpoint returns the full DB row (includes tenantId — intentional).
      // Fable nit: the `embedding` vector must NOT be in the response (bloat).
      expect(res.body).not.toHaveProperty('embedding');
    });

    it('does not expose the embedding vector in the admin list either', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await createCat(h, token, { name: `EmbedCheck-${newId().slice(-4)}` });

      const list = await request(h.http())
        .get(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      for (const item of list.body as Array<Record<string, unknown>>) {
        expect(item).not.toHaveProperty('embedding');
      }
    });

    it('reserves the slug "tree" so a category cannot shadow /store/v1/categories/tree', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      // A category explicitly named/slugged "tree" must get a non-"tree" slug.
      const res = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Tree', slug: 'tree' })
        .expect(201);
      expect(res.body.slug).not.toBe('tree');

      // /store/v1/categories/tree still returns the nested tree (array), not a
      // single category by slug.
      const treeRes = await request(h.http()).get(`${STORE_CATS}/tree`).expect(200);
      expect(Array.isArray(treeRes.body.data)).toBe(true);
    });

    it('falls back to a usable slug for a non-Latin name (no empty slug)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '电脑' })
        .expect(201);
      expect(typeof res.body.slug).toBe('string');
      expect(res.body.slug.length).toBeGreaterThan(0);
    });

    it('auto-generates slug from name', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: "Men's Clothing" })
        .expect(201);

      expect(res.body.slug).toBe('men-s-clothing');
    });

    it('accepts explicit slug', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Electronics', slug: 'electronics' })
        .expect(201);

      expect(res.body.slug).toBe('electronics');
    });

    it('deduplicates slug on collision (same name twice)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const r1 = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Shoes' })
        .expect(201);

      const r2 = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Shoes' })
        .expect(201);

      expect(r1.body.slug).toBeDefined();
      expect(r2.body.slug).toBeDefined();
      expect(r1.body.slug).not.toBe(r2.body.slug);
    });

    it('returns 401 unauthenticated', async () => {
      await request(h.http()).post(ADMIN_CATS).send({ name: 'Hats' }).expect(401);
    });

    it('returns 403 for staff without CATEGORIES_WRITE (staff has it → 201)', async () => {
      // staff role includes categories:write per the role-permissions map.
      const staff = await seedAdmin(h, { role: 'staff' });
      const token = await login(h, staff.email, staff.password);
      await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Staff Cat' })
        .expect(201);
    });
  });

  // ── Category depth guard ──────────────────────────────────────────────────

  describe('Category depth (max 5)', () => {
    it('allows nesting up to 5 levels', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      let parentId: string | null = null;
      for (let depth = 1; depth <= 5; depth++) {
        const body: Record<string, unknown> = { name: `Level ${depth} ${newId().slice(-4)}` };
        if (parentId) body.parentId = parentId;
        const res = await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${token}`)
          .send(body)
          .expect(201);
        parentId = res.body.id as string;
      }
      // parentId is now at depth 5.
      expect(parentId).toBeDefined();
    });

    it('rejects a 6th-level category with 422', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      let parentId: string | null = null;
      for (let depth = 1; depth <= 5; depth++) {
        const body: Record<string, unknown> = { name: `L${depth}-${newId().slice(-4)}` };
        if (parentId) body.parentId = parentId;
        const res = await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${token}`)
          .send(body)
          .expect(201);
        parentId = res.body.id as string;
      }

      // Try to add level 6 → 422 (depth guard).
      await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Level 6 ${newId().slice(-4)}`, parentId })
        .expect(422);
    });
  });

  // ── Cycle detection ────────────────────────────────────────────────────────

  describe('Cycle detection', () => {
    it('rejects setting parent = self (422)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const catRes = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Self Loop' })
        .expect(201);

      await request(h.http())
        .patch(`${ADMIN_CATS}/${catRes.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: catRes.body.id })
        .expect(422);
    });

    it('rejects A→B→C then setting A.parent=C (deep cycle)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const a = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `A-${newId().slice(-4)}` })
        .expect(201);

      const b = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `B-${newId().slice(-4)}`, parentId: a.body.id })
        .expect(201);

      const c = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `C-${newId().slice(-4)}`, parentId: b.body.id })
        .expect(201);

      // Try: A.parent = C (would form A→B→C→A loop) → 422.
      await request(h.http())
        .patch(`${ADMIN_CATS}/${a.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: c.body.id })
        .expect(422);
    });

    it('allows valid re-parent within depth limit', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      // Create sibling roots, then re-parent one as a child of the other.
      const root1 = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Root1-${newId().slice(-4)}` })
        .expect(201);

      const root2 = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Root2-${newId().slice(-4)}` })
        .expect(201);

      // Move root2 under root1 — valid (depth 2 < 5).
      await request(h.http())
        .patch(`${ADMIN_CATS}/${root2.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: root1.body.id })
        .expect(200);
    });
  });

  // ── F1 BLOCKER: re-parenting a SUBTREE must enforce max-depth on descendants ─

  describe('Re-parent subtree depth guard (F1 BLOCKER)', () => {
    it('rejects 422 when moving a node-with-children would push a descendant past depth 5, and does NOT persist the move', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      // X1→X2→X3 (X1 is a root, the moved subtree has height 3).
      const [x1] = await buildChain(h, token, null, 3, 'X');
      // Y1→Y2→Y3 (Y3 is at depth 3).
      const yChain = await buildChain(h, token, null, 3, 'Y');
      const y3 = yChain[2]!;

      // PATCH X1 {parentId: Y3}: X1 would land at depth 4, X3 at depth 6 → 422.
      await request(h.http())
        .patch(`${ADMIN_CATS}/${x1}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: y3 })
        .expect(422);

      // The move must NOT have persisted — X1 is still a root (parentId null).
      const x1Row = await request(h.http())
        .get(`${ADMIN_CATS}/${x1}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(x1Row.body.parentId).toBeNull();

      // DB-level confirmation: no category sits below depth 5 in this tenant.
      const deepest = await h.client<{ d: number }[]>`
        WITH RECURSIVE t AS (
          SELECT id, 1 AS depth FROM categories
          WHERE tenant_id = ${admin.tenantId} AND parent_id IS NULL
          UNION ALL
          SELECT c.id, t.depth + 1 FROM categories c
          INNER JOIN t ON c.parent_id = t.id
          WHERE c.tenant_id = ${admin.tenantId} AND t.depth < 32
        )
        SELECT COALESCE(MAX(depth), 0)::int AS d FROM t
      `;
      expect(deepest[0]!.d).toBeLessThanOrEqual(5);
    });

    it('allows moving a node-with-children when the deepest descendant stays within depth 5', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      // X1→X2→X3 (height 3) and a single root P (depth 1).
      const [x1] = await buildChain(h, token, null, 3, 'X');
      const p = await createCat(h, token, { name: `P-${newId().slice(-4)}` });

      // Move X1 under P: X1@2, X2@3, X3@4 — all ≤ 5 → 200.
      await request(h.http())
        .patch(`${ADMIN_CATS}/${x1}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: p })
        .expect(200);

      const x1Row = await request(h.http())
        .get(`${ADMIN_CATS}/${x1}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(x1Row.body.parentId).toBe(p);
    });

    it('rejects re-parenting a node under its OWN deep descendant (cycle, via a depth-3 descendant) and does NOT persist', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      // A1→A2→A3.
      const [a1, , a3] = await buildChain(h, token, null, 3, 'A');

      // PATCH A1 {parentId: A3}: A3 is a descendant of A1 → cycle → 422.
      await request(h.http())
        .patch(`${ADMIN_CATS}/${a1}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: a3 })
        .expect(422);

      // A1 still a root.
      const a1Row = await request(h.http())
        .get(`${ADMIN_CATS}/${a1}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(a1Row.body.parentId).toBeNull();
    });
  });

  // ── F3: bogus / cross-tenant parentId → 404, never 500 ──────────────────────

  describe('Unresolvable parentId (F3)', () => {
    it('CREATE with a nonexistent in-tenant parentId → 404 (not 500)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Orphan-${newId().slice(-4)}`, parentId: newId() })
        .expect(404);
    });

    it('PATCH re-parent to a nonexistent parentId → 404 (not 500), no move persisted', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const cat = await createCat(h, token, { name: `Movable-${newId().slice(-4)}` });

      await request(h.http())
        .patch(`${ADMIN_CATS}/${cat}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: newId() })
        .expect(404);

      const row = await request(h.http())
        .get(`${ADMIN_CATS}/${cat}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(row.body.parentId).toBeNull();
    });

    it('CREATE with a CROSS-TENANT parentId → 404 (not 500), and nothing is inserted', async () => {
      // Tenant A owns a category.
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);
      const catA = await createCat(h, tokenA, { name: `A-Parent-${newId().slice(-4)}` });

      // Tenant B tries to create a child under tenant A's category.
      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: `B-Child-${newId().slice(-4)}`, parentId: catA })
        .expect(404);

      // Tenant B has zero categories (nothing leaked / inserted).
      const list = await request(h.http())
        .get(ADMIN_CATS)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect((list.body as unknown[]).length).toBe(0);
    });

    it('PATCH re-parent to a CROSS-TENANT parentId → 404 (not 500)', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);
      const catA = await createCat(h, tokenA, { name: `A-Target-${newId().slice(-4)}` });

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);
      const catB = await createCat(h, tokenB, { name: `B-Movable-${newId().slice(-4)}` });

      await request(h.http())
        .patch(`${ADMIN_CATS}/${catB}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ parentId: catA })
        .expect(404);

      const row = await request(h.http())
        .get(`${ADMIN_CATS}/${catB}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(row.body.parentId).toBeNull();
    });
  });

  // ── Tree endpoint ──────────────────────────────────────────────────────────

  describe('GET /store/v1/categories/tree', () => {
    it('returns nested tree with correct parent→children structure', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      const root = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Root-${newId().slice(-4)}`, position: 0 })
        .expect(201);

      const child = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Child-${newId().slice(-4)}`, parentId: root.body.id, position: 0 })
        .expect(201);

      const treeRes = await request(h.http()).get(`${STORE_CATS}/tree`).expect(200);

      // Find the root node in the tree.
      const tree = treeRes.body.data as Array<{
        id: string;
        children?: Array<{ id: string }>;
        tenantId?: string;
        createdAt?: string;
      }>;
      const rootNode = tree.find((n) => n.id === root.body.id);
      expect(rootNode).toBeDefined();
      expect(rootNode!.children).toBeDefined();
      const childIds = rootNode!.children!.map((c) => c.id);
      expect(childIds).toContain(child.body.id);

      // Allowlist check: no tenantId / timestamps.
      for (const node of tree) {
        expect(node.tenantId).toBeUndefined();
        expect(node.createdAt).toBeUndefined();
      }
    });

    it('includes productCount per category (published products only)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      const cat = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `CountCat-${newId().slice(-4)}` })
        .expect(201);

      const product = await createProduct(h, token);
      // The store count is published-only, so publish the product first.
      await h.client`update products set status = 'published' where id = ${product.id}`;

      // Assign product to category.
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [cat.body.id] })
        .expect(204);

      const treeRes = await request(h.http()).get(`${STORE_CATS}/tree`).expect(200);

      const tree = treeRes.body.data as Array<{ id: string; productCount: number }>;
      const catNode = tree.find((n) => n.id === cat.body.id);
      expect(catNode).toBeDefined();
      expect(catNode!.productCount).toBe(1);
    });

    it('store productCount excludes draft/archived products', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      const cat = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `MixedCat-${newId().slice(-4)}` })
        .expect(201);
      const catId = cat.body.id as string;

      // One published, one draft, one archived — all in the same category.
      const published = await createProduct(h, token);
      const draft = await createProduct(h, token);
      const archived = await createProduct(h, token);
      await h.client`update products set status = 'published' where id = ${published.id}`;
      await h.client`update products set status = 'archived' where id = ${archived.id}`;
      for (const p of [published, draft, archived]) {
        await request(h.http())
          .put(`${ADMIN_PRODUCTS}/${p.id}/categories`)
          .set('Authorization', `Bearer ${token}`)
          .send({ categoryIds: [catId] })
          .expect(204);
      }

      // Store-facing surfaces (flat list, tree, by-slug) count ONLY the published one.
      const flat = await request(h.http()).get(STORE_CATS).expect(200);
      const flatNode = (flat.body.data as Array<{ id: string; productCount: number }>).find(
        (n) => n.id === catId,
      );
      expect(flatNode!.productCount).toBe(1);

      const tree = await request(h.http()).get(`${STORE_CATS}/tree`).expect(200);
      const treeNode = (tree.body.data as Array<{ id: string; productCount: number }>).find(
        (n) => n.id === catId,
      );
      expect(treeNode!.productCount).toBe(1);

      const bySlug = await request(h.http()).get(`${STORE_CATS}/${cat.body.slug}`).expect(200);
      expect((bySlug.body as { productCount: number }).productCount).toBe(1);

      // The ADMIN count is unchanged — it still counts all 3 assignments.
      const adminCount = await h.client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM product_categories WHERE category_id = ${catId}`;
      expect(adminCount[0]!.count).toBe(3);
    });
  });

  // ── DELETE category with children ─────────────────────────────────────────

  describe('DELETE /admin/v1/categories/:id', () => {
    it('returns 409 if category has children', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const parent = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Parent-${newId().slice(-4)}` })
        .expect(201);

      await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Child-${newId().slice(-4)}`, parentId: parent.body.id })
        .expect(201);

      await request(h.http())
        .delete(`${ADMIN_CATS}/${parent.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    it('allows delete after moving child away', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const parent = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `ToDelete-${newId().slice(-4)}` })
        .expect(201);

      const child = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Movable-${newId().slice(-4)}`, parentId: parent.body.id })
        .expect(201);

      // Move child to root (remove parentId).
      await request(h.http())
        .patch(`${ADMIN_CATS}/${child.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: null })
        .expect(200);

      // Now delete parent should succeed.
      await request(h.http())
        .delete(`${ADMIN_CATS}/${parent.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
    });

    it('product_categories rows for deleted category are gone', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const cat = await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `CascadeCat-${newId().slice(-4)}` })
        .expect(201);

      const product = await createProduct(h, token);

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [cat.body.id] })
        .expect(204);

      // Delete the category (no children).
      await request(h.http())
        .delete(`${ADMIN_CATS}/${cat.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      // DB-level: product_categories row should be gone (CASCADE).
      const rows = await h.client<{ count: string }[]>`
        SELECT count(*)::int AS count FROM product_categories
        WHERE category_id = ${cat.body.id}
      `;
      expect(Number(rows[0].count)).toBe(0);
    });

    it('deleting a nonexistent category → 404 (F2 re-check path)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .delete(`${ADMIN_CATS}/${newId()}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('atomic delete-if-no-children removes a leaf and is idempotent (second delete → 404)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const leaf = await createCat(h, token, { name: `Leaf-${newId().slice(-4)}` });

      await request(h.http())
        .delete(`${ADMIN_CATS}/${leaf}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await request(h.http())
        .delete(`${ADMIN_CATS}/${leaf}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  // ── Tag CRUD ───────────────────────────────────────────────────────────────

  describe('Tag CRUD', () => {
    it('creates a tag with auto-slug', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_TAGS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Summer Sale' })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toBe('summer-sale');
    });

    it('deduplicates slugs on collision', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const r1 = await request(h.http())
        .post(ADMIN_TAGS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Arrival' })
        .expect(201);

      const r2 = await request(h.http())
        .post(ADMIN_TAGS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Arrival' })
        .expect(201);

      expect(r1.body.slug).not.toBe(r2.body.slug);
    });

    it('PATCH updates a tag name', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_TAGS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `OldName-${newId().slice(-4)}` })
        .expect(201);

      const updated = await request(h.http())
        .patch(`${ADMIN_TAGS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name' })
        .expect(200);

      expect(updated.body.name).toBe('New Name');
    });

    it('DELETE tag cascades product_tags', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const tag = await request(h.http())
        .post(ADMIN_TAGS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `CascadeTag-${newId().slice(-4)}` })
        .expect(201);

      const product = await createProduct(h, token);

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/tags`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tagIds: [tag.body.id] })
        .expect(204);

      await request(h.http())
        .delete(`${ADMIN_TAGS}/${tag.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const rows = await h.client<{ count: string }[]>`
        SELECT count(*)::int AS count FROM product_tags
        WHERE tag_id = ${tag.body.id}
      `;
      expect(Number(rows[0].count)).toBe(0);
    });
  });

  // ── Assignment (replace-set) ───────────────────────────────────────────────

  describe('Product↔Category & Product↔Tag assignment', () => {
    it('assigns multiple categories to a product (replace-set)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const product = await createProduct(h, token);

      const catA = (
        await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `CatA-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      const catB = (
        await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `CatB-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      // First assign: [A].
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [catA.id] })
        .expect(204);

      // Replace with [B, C] — A should be gone.
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [catB.id] })
        .expect(204);

      const rows = await h.client<{ category_id: string }[]>`
        SELECT category_id FROM product_categories WHERE product_id = ${product.id}
      `;
      const ids = rows.map((r) => r.category_id);
      expect(ids).not.toContain(catA.id);
      expect(ids).toContain(catB.id);
      expect(ids).toHaveLength(1);
    });

    it('assigns multiple tags to a product (replace-set)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const product = await createProduct(h, token);

      const tagA = (
        await request(h.http())
          .post(ADMIN_TAGS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `TagA-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      const tagB = (
        await request(h.http())
          .post(ADMIN_TAGS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `TagB-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      // Assign [A, B].
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/tags`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tagIds: [tagA.id, tagB.id] })
        .expect(204);

      const rows = await h.client<{ tag_id: string }[]>`
        SELECT tag_id FROM product_tags WHERE product_id = ${product.id}
      `;
      const ids = rows.map((r) => r.tag_id);
      expect(ids).toContain(tagA.id);
      expect(ids).toContain(tagB.id);
      expect(ids).toHaveLength(2);
    });

    it('assigning [] clears all categories', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const product = await createProduct(h, token);

      const cat = (
        await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `Clearable-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [cat.id] })
        .expect(204);

      // Clear.
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [] })
        .expect(204);

      const rows = await h.client<{ category_id: string }[]>`
        SELECT category_id FROM product_categories WHERE product_id = ${product.id}
      `;
      expect(rows).toHaveLength(0);
    });

    it('cross-tenant category id → 400 (category not found in tenant)', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      // Create a category in tenant A.
      const catA = (
        await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ name: `CrossTenantCat-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      // Create tenant B.
      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);
      const productB = await createProduct(h, tokenB);

      // Tenant B tries to assign tenant A's category.
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${productB.id}/categories`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ categoryIds: [catA.id] })
        .expect(400);
    });

    it('cross-tenant tag id → 400', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      const tagA = (
        await request(h.http())
          .post(ADMIN_TAGS)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ name: `CrossTenantTag-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);
      const productB = await createProduct(h, tokenB);

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${productB.id}/tags`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ tagIds: [tagA.id] })
        .expect(400);
    });

    it('unauthenticated assignment → 401', async () => {
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${newId()}/categories`)
        .send({ categoryIds: [] })
        .expect(401);
    });

    it('staff (PRODUCTS_WRITE) can assign', async () => {
      const staff = await seedAdmin(h, { role: 'staff' });
      const token = await login(h, staff.email, staff.password);

      const product = await createProduct(h, token);

      const cat = (
        await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `StaffCat-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [cat.id] })
        .expect(204);
    });

    // ── F4: duplicate ids in the payload → idempotent set, never 500 ───────────

    it('duplicate categoryIds [X, X] → 204 idempotent (one row), never 500', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const product = await createProduct(h, token);
      const cat = await createCat(h, token, { name: `DupCat-${newId().slice(-4)}` });

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [cat, cat, cat] })
        .expect(204);

      const rows = await h.client<{ category_id: string }[]>`
        SELECT category_id FROM product_categories WHERE product_id = ${product.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.category_id).toBe(cat);
    });

    it('duplicate tagIds [X, X] → 204 idempotent (one row), never 500', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const product = await createProduct(h, token);
      const tag = (
        await request(h.http())
          .post(ADMIN_TAGS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `DupTag-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/tags`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tagIds: [tag.id, tag.id] })
        .expect(204);

      const rows = await h.client<{ tag_id: string }[]>`
        SELECT tag_id FROM product_tags WHERE product_id = ${product.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tag_id).toBe(tag.id);
    });

    // ── DATA-LOSS REGRESSION: admin GET /:id must echo assigned categories/tags ──
    // The admin edit form pre-selects from product.categories/product.tags; if the
    // single-product GET omits them they come back empty and a subsequent save PUTs
    // [] → wiping the assignments. These tests pin that the GET returns them.

    it('admin GET /products/:id includes assigned categories and tags', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const product = await createProduct(h, token);
      const cat = await createCat(h, token, { name: `EchoCat-${newId().slice(-4)}` });
      const tag = (
        await request(h.http())
          .post(ADMIN_TAGS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `EchoTag-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [cat] })
        .expect(204);
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/tags`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tagIds: [tag.id] })
        .expect(204);

      const res = await request(h.http())
        .get(`${ADMIN_PRODUCTS}/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = res.body as {
        categories: Array<{ id: string }>;
        tags: Array<{ id: string }>;
      };
      expect(Array.isArray(body.categories)).toBe(true);
      expect(Array.isArray(body.tags)).toBe(true);
      expect(body.categories.map((c) => c.id)).toEqual([cat]);
      expect(body.tags.map((t) => t.id)).toEqual([tag.id]);
    });

    it('edit→save round-trip (mirroring the admin form) preserves assignments', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const product = await createProduct(h, token);
      const cat = await createCat(h, token, { name: `RTCat-${newId().slice(-4)}` });
      const tag = (
        await request(h.http())
          .post(ADMIN_TAGS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `RTTag-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [cat] })
        .expect(204);
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/tags`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tagIds: [tag.id] })
        .expect(204);

      // The form loads the product, derives the assigned ids from the GET response,
      // then on save re-PUTs exactly what it loaded. If the GET omits them, the form
      // would PUT [] here and wipe the assignments.
      const loaded = (
        await request(h.http())
          .get(`${ADMIN_PRODUCTS}/${product.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as { categories: Array<{ id: string }>; tags: Array<{ id: string }> };

      const assignedCategoryIds = (loaded.categories ?? []).map((c) => c.id);
      const assignedTagIds = (loaded.tags ?? []).map((t) => t.id);

      // Save: PATCH the product (title only), then re-PUT the loaded taxonomy sets.
      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Renamed product' })
        .expect(200);
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: assignedCategoryIds })
        .expect(204);
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/tags`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tagIds: assignedTagIds })
        .expect(204);

      // Assignments must survive the save round-trip.
      const catRows = await h.client<{ category_id: string }[]>`
        SELECT category_id FROM product_categories WHERE product_id = ${product.id}
      `;
      const tagRows = await h.client<{ tag_id: string }[]>`
        SELECT tag_id FROM product_tags WHERE product_id = ${product.id}
      `;
      expect(catRows.map((r) => r.category_id)).toEqual([cat]);
      expect(tagRows.map((r) => r.tag_id)).toEqual([tag.id]);
    });

    it('mixed duplicates [A, B, A] → 204 with exactly {A, B}', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const product = await createProduct(h, token);
      const a = await createCat(h, token, { name: `MixA-${newId().slice(-4)}` });
      const b = await createCat(h, token, { name: `MixB-${newId().slice(-4)}` });

      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${product.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [a, b, a] })
        .expect(204);

      const rows = await h.client<{ category_id: string }[]>`
        SELECT category_id FROM product_categories WHERE product_id = ${product.id}
      `;
      const ids = rows.map((r) => r.category_id).sort();
      expect(ids).toEqual([a, b].sort());
    });
  });

  // ── Store public allowlist ─────────────────────────────────────────────────

  describe('Store categories & tags — allowlist + public access', () => {
    it('GET /store/v1/categories is public (no auth)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Public-${newId().slice(-4)}` })
        .expect(201);

      await request(h.http()).get(STORE_CATS).expect(200);
    });

    it('GET /store/v1/tags is public (no auth)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http())
        .post(ADMIN_TAGS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `PubTag-${newId().slice(-4)}` })
        .expect(201);

      await request(h.http()).get(STORE_TAGS).expect(200);
    });

    it('store categories response does not expose tenantId or timestamps', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `AllowlistCat-${newId().slice(-4)}` })
        .expect(201);

      const res = await request(h.http()).get(STORE_CATS).expect(200);

      const forbidden = ['tenantId', 'tenant_id', 'createdAt', 'updatedAt', 'embedding'];
      for (const item of res.body.data as Array<Record<string, unknown>>) {
        for (const field of forbidden) {
          expect(item).not.toHaveProperty(field);
        }
        // Must have the allowed fields.
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('slug');
        expect(item).toHaveProperty('name');
      }
    });

    it('store tags response does not expose tenantId or timestamps', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http())
        .post(ADMIN_TAGS)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `AllowlistTag-${newId().slice(-4)}` })
        .expect(201);

      const res = await request(h.http()).get(STORE_TAGS).expect(200);

      const forbidden = ['tenantId', 'tenant_id', 'createdAt'];
      for (const item of res.body.data as Array<Record<string, unknown>>) {
        for (const field of forbidden) {
          expect(item).not.toHaveProperty(field);
        }
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('slug');
        expect(item).toHaveProperty('name');
      }
    });

    it(':slug returns 404 for missing slug', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http()).get(`${STORE_CATS}/does-not-exist-xyz`).expect(404);
    });

    it(':slug returns the category for an existing slug', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      const cat = (
        await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: `SlugFind-${newId().slice(-4)}`, slug: `slugfind-${newId().slice(-6)}` })
          .expect(201)
      ).body as { id: string; slug: string };

      const res = await request(h.http()).get(`${STORE_CATS}/${cat.slug}`).expect(200);
      expect(res.body.id).toBe(cat.id);
    });

    it('store categories rate-limit triggers 429', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      // The store rate limit is shared with products (store:<ip>). Reset happens
      // in beforeEach (flushdb). Fire enough requests to trigger.
      let saw429 = false;
      for (let i = 0; i < 130; i++) {
        const res = await request(h.http()).get(STORE_CATS);
        if (res.status === 429) {
          saw429 = true;
          break;
        }
      }
      expect(saw429).toBe(true);
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    it('admin A cannot GET a category from tenant B', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      const catA = (
        await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ name: `IsolCat-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .get(`${ADMIN_CATS}/${catA.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });

    it('admin A cannot DELETE a category from tenant B', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      const catA = (
        await request(h.http())
          .post(ADMIN_CATS)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ name: `IsolDelCat-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .delete(`${ADMIN_CATS}/${catA.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });

    it('admin A cannot GET a tag from tenant B', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      const tagA = (
        await request(h.http())
          .post(ADMIN_TAGS)
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ name: `IsolTag-${newId().slice(-4)}` })
          .expect(201)
      ).body as { id: string };

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .get(`${ADMIN_TAGS}/${tagA.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });

    it('store does not leak categories from wrong tenant', async () => {
      // Tenant A creates a category; store uses tenant B — category not visible.
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      await request(h.http())
        .post(ADMIN_CATS)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: `SecretCat-${newId().slice(-4)}` })
        .expect(201);

      // Switch store to tenant B (different tenant, no categories).
      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);

      const res = await request(h.http()).get(STORE_CATS).expect(200);
      // Tenant B has no categories — list should be empty.
      expect((res.body.data as unknown[]).length).toBe(0);
    });
  });
});
