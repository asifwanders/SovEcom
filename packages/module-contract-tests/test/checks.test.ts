import { describe, it, expect, afterEach } from 'vitest';
import { runContractChecks } from '../src/index.js';
import { makeModuleDir, defaultManifest, cleanupFixtures } from './fixtures.js';

afterEach(() => cleanupFixtures());

/** Helper: find a check result by id. */
function check(report: ReturnType<typeof runContractChecks>, id: string) {
  const c = report.checks.find((r) => r.id === id);
  if (!c) throw new Error(`no check with id "${id}" in report`);
  return c;
}

describe('runContractChecks — report shape', () => {
  it('returns a check per hard check plus advisory checks, with ok=true on a clean module', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: ['read:products'] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) { await sdk.store.products.list(); } });
`,
    });
    const report = runContractChecks(dir);
    expect(report.ok).toBe(true);
    const ids = report.checks.map((c) => c.id).sort();
    expect(ids).toContain('manifest-valid');
    expect(ids).toContain('tables-namespaced');
    expect(ids).toContain('permissions-sufficient');
    expect(ids).toContain('core-version-compatible');
    expect(ids).toContain('migration-reversibility');
    expect(ids).toContain('webhook-idempotency');
  });
});

describe('check 1 — manifest valid', () => {
  it('FAILS on a syntactically invalid manifest (bad JSON)', () => {
    const dir = makeModuleDir({ manifest: '{ not json' });
    const report = runContractChecks(dir);
    expect(check(report, 'manifest-valid').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('FAILS on a schema-invalid manifest (unknown permission)', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: ['read:everything'] }),
    });
    const report = runContractChecks(dir);
    expect(check(report, 'manifest-valid').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('FAILS when sovecom.module.json is missing', () => {
    const dir = makeModuleDir({ omitManifest: true });
    const report = runContractChecks(dir);
    expect(check(report, 'manifest-valid').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('PASSES on a valid manifest', () => {
    const dir = makeModuleDir({ manifest: defaultManifest('demo') });
    const report = runContractChecks(dir);
    expect(check(report, 'manifest-valid').status).toBe('pass');
  });
});

describe('check 2 — tables namespaced', () => {
  it('FAILS on a non-namespaced table (surfaced as a named, friendly check)', () => {
    // A table that does not start with `mod_<name>_` is rejected by the manifest schema, so the
    // manifest check fails too; check 2 must independently and clearly name the namespacing issue.
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { tables: ['orders'] }),
    });
    const report = runContractChecks(dir);
    expect(check(report, 'tables-namespaced').status).toBe('fail');
    expect(check(report, 'tables-namespaced').messages.join(' ')).toMatch(/mod_demo_/);
    expect(report.ok).toBe(false);
  });

  it('FAILS when a migration/DDL CREATE TABLE names a non-namespaced table', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', {
        permissions: ['write:own_tables'],
        tables: ['mod_demo_items'],
      }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) {
  await sdk.tables.exec('CREATE TABLE core_orders (id text)');
} });
`,
    });
    const report = runContractChecks(dir);
    expect(check(report, 'tables-namespaced').status).toBe('fail');
    expect(check(report, 'tables-namespaced').messages.join(' ')).toMatch(/core_orders/);
  });

  it('PASSES when all declared and DDL tables are namespaced mod_<name>_*', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', {
        permissions: ['write:own_tables'],
        tables: ['mod_demo_items'],
      }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) {
  await sdk.tables.exec('CREATE TABLE IF NOT EXISTS mod_demo_items (id text)');
} });
`,
    });
    const report = runContractChecks(dir);
    expect(check(report, 'tables-namespaced').status).toBe('pass');
  });
});

describe('check 3 — permissions sufficient (declared ⊇ used)', () => {
  it('FAILS when code uses a capability whose permission is not declared', () => {
    // Uses sdk.store.products (needs read:products) and sdk.tables (needs write:own_tables) but
    // declares NEITHER.
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: [] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) {
  await sdk.store.products.list();
  await sdk.tables.exec('CREATE TABLE mod_demo_x (id text)');
} });
`,
    });
    const report = runContractChecks(dir);
    const c = check(report, 'permissions-sufficient');
    expect(c.status).toBe('fail');
    expect(c.messages.join(' ')).toMatch(/read:products/);
    expect(c.messages.join(' ')).toMatch(/write:own_tables/);
    expect(report.ok).toBe(false);
  });

  it('maps admin.orders/customers, events, http and serve correctly', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', {
        permissions: [
          'read:orders',
          'read:customers',
          'subscribe:events',
          'emit:events',
          'http:outbound',
        ],
      }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) {
  await sdk.admin.orders.list();
  await sdk.admin.customers.list();
  await sdk.events.on('order.paid', async () => {});
  await sdk.events.emit('did.thing');
  await sdk.http.fetch({ url: 'https://example.test' });
  sdk.serve(async () => ({ status: 200, body: 'ok' }));
} });
`,
    });
    const report = runContractChecks(dir);
    expect(check(report, 'permissions-sufficient').status).toBe('pass');
  });

  it('maps sdk.commerce.hasPurchased to read:orders (B1)', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: ['read:orders'] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) {
  await sdk.commerce.hasPurchased('cust-1', 'prod-1');
} });
`,
    });
    const report = runContractChecks(dir);
    // sdk.commerce → read:orders is declared, so the check passes with no missing/unused finding.
    expect(check(report, 'permissions-sufficient').status).toBe('pass');
  });

  it('FAILS when sdk.commerce is used but read:orders is NOT declared (B1)', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: ['write:own_tables'] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) {
  await sdk.commerce.hasPurchased('cust-1', 'prod-1');
} });
`,
    });
    const report = runContractChecks(dir);
    const c = check(report, 'permissions-sufficient');
    expect(c.status).toBe('fail');
    expect(c.messages.join(' ')).toMatch(/read:orders/);
  });

  it('the PASS message still carries the advisory caveat (static scan is best-effort)', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: ['read:products'] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) { await sdk.store.products.list(); } });
`,
    });
    const report = runContractChecks(dir);
    const c = check(report, 'permissions-sufficient');
    expect(c.status).toBe('pass');
    // A green verdict must still warn that aliased/destructured/dynamic capability use isn't
    // analyzed and the broker is the real enforcer.
    expect(c.messages.join(' ')).toMatch(/aliasing, destructuring, or dynamic/);
    expect(c.messages.join(' ')).toMatch(/broker enforces/);
  });

  it('treats sdk.serve as needing NO permission', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: [] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) {
  sdk.serve(async () => ({ status: 200, body: 'ok' }));
} });
`,
    });
    const report = runContractChecks(dir);
    expect(check(report, 'permissions-sufficient').status).toBe('pass');
  });

  it('emits an ADVISORY (not a failure) for a declared-but-unused permission (least privilege)', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: ['read:products', 'http:outbound'] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) { await sdk.store.products.list(); } });
`,
    });
    const report = runContractChecks(dir);
    const c = check(report, 'permissions-sufficient');
    expect(c.status).toBe('pass'); // unused permission never fails the hard check
    expect(c.advisories.join(' ')).toMatch(/http:outbound/);
  });

  it('detects usage when the activate parameter is renamed', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: [] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(core) { await core.store.products.list(); } });
`,
    });
    const report = runContractChecks(dir);
    expect(check(report, 'permissions-sufficient').status).toBe('fail');
    expect(check(report, 'permissions-sufficient').messages.join(' ')).toMatch(/read:products/);
  });
});

describe('check 4 — core-version compatible', () => {
  it('FAILS when compatibleCore targets an old major (^0.x)', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { compatibleCore: '^0.5.0' }),
    });
    const report = runContractChecks(dir);
    expect(check(report, 'core-version-compatible').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('FAILS when compatibleCore targets a future major (^2.0.0)', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { compatibleCore: '^2.0.0' }),
    });
    const report = runContractChecks(dir);
    expect(check(report, 'core-version-compatible').status).toBe('fail');
  });

  it('PASSES on ^1.0.0', () => {
    const dir = makeModuleDir({ manifest: defaultManifest('demo', { compatibleCore: '^1.0.0' }) });
    const report = runContractChecks(dir);
    expect(check(report, 'core-version-compatible').status).toBe('pass');
  });
});

describe('check 5 — advisory checks are reported as advisory, never as proven', () => {
  it('reports migration-reversibility and webhook-idempotency as advisory (status advisory) and they never fail the run', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', { permissions: ['subscribe:events'] }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) {
  await sdk.events.on('order.paid', async () => {});
} });
`,
    });
    const report = runContractChecks(dir);
    const mig = check(report, 'migration-reversibility');
    const wh = check(report, 'webhook-idempotency');
    expect(mig.status).toBe('advisory');
    expect(wh.status).toBe('advisory');
    // The honesty requirement: advisory text must NOT claim it verified/proved anything.
    expect(mig.messages.join(' ').toLowerCase()).toMatch(
      /advisory|cannot|not verified|reminder|heuristic/,
    );
    expect(wh.messages.join(' ').toLowerCase()).toMatch(
      /advisory|cannot|not verified|reminder|heuristic/,
    );
    // Advisory status never flips ok to false.
    expect(report.ok).toBe(true);
  });
});

describe('a module with multiple simultaneous mistakes', () => {
  it('fails every relevant hard check at once and ok=false', () => {
    const dir = makeModuleDir({
      manifest: defaultManifest('demo', {
        compatibleCore: '^0.1.0',
        permissions: [],
        tables: ['not_namespaced'],
      }),
      indexTs: `import { defineModule } from '@sovecom/module-sdk';
export default defineModule({ async activate(sdk) { await sdk.admin.orders.list(); } });
`,
    });
    const report = runContractChecks(dir);
    expect(report.ok).toBe(false);
    expect(check(report, 'tables-namespaced').status).toBe('fail');
    expect(check(report, 'core-version-compatible').status).toBe('fail');
    expect(check(report, 'permissions-sufficient').status).toBe('fail');
  });
});
