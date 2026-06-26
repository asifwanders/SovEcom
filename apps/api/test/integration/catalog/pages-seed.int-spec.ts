/**
 * Integration tests for the default legal/content `pages` seed
 * (`seedDefaultPages`).
 *
 * Real Postgres via the auth harness. Covers:
 *   - Every expected slug exists in BOTH `en` and `fr`, `status='published'`.
 *   - Each body opens with the TEMPLATE/counsel notice and carries `[BRACKETED]`
 *     placeholders (Prime Directive #7 — flagged-for-counsel templates).
 *   - The `privacy`/`terms` slugs match the storefront footer links.
 *   - Idempotency: running the seed twice does not error and does not duplicate.
 *   - The seed is tenant-scoped (rows carry the passed tenant_id only).
 *   - A seeded published page is retrievable via the store path the storefront
 *     uses (`PagesService.storeFindBySlug`), and an unknown locale → 404.
 */
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  makeTenant,
  AuthHarness,
  newId,
} from '../auth/_auth-harness';
import { seedDefaultPages } from '../../../src/database/seeds/pages/seed-pages';
import { SEED_PAGE_SLUGS } from '../../../src/database/seeds/pages/types';
import { PagesService } from '../../../src/catalog/pages/pages.service';

interface PageRow {
  slug: string;
  locale: string;
  status: string;
  title: string;
  body: string;
}

async function allPages(h: AuthHarness, tenantId: string): Promise<PageRow[]> {
  return h.client<PageRow[]>`
    select slug, locale, status, title, body from pages where tenant_id = ${tenantId}
  `;
}

describe('Catalog — default pages seed (integration)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
  });

  it('seeds every expected slug in BOTH en and fr, all published', async () => {
    const tenantId = await makeTenant(h);
    const count = await seedDefaultPages(h.db, tenantId);
    // 5 slugs × 2 locales.
    expect(count).toBe(SEED_PAGE_SLUGS.length * 2);

    const rows = await allPages(h, tenantId);
    expect(rows).toHaveLength(SEED_PAGE_SLUGS.length * 2);

    for (const slug of SEED_PAGE_SLUGS) {
      const en = rows.find((r) => r.slug === slug && r.locale === 'en');
      const fr = rows.find((r) => r.slug === slug && r.locale === 'fr');
      expect(en).toBeDefined();
      expect(fr).toBeDefined();
      expect(en!.status).toBe('published');
      expect(fr!.status).toBe('published');
    }
  });

  it('aligns the legal slugs to the storefront footer links', () => {
    // Footer.tsx links /privacy and /terms — they MUST be in the seeded set so
    // the links resolve instead of 404.
    expect(SEED_PAGE_SLUGS).toEqual(expect.arrayContaining(['privacy', 'terms']));
  });

  it('every body carries the TEMPLATE/counsel notice + bracketed placeholders', async () => {
    const tenantId = await makeTenant(h);
    await seedDefaultPages(h.db, tenantId);
    const rows = await allPages(h, tenantId);

    for (const row of rows) {
      // Prominent counsel notice opens every body (EN "TEMPLATE" / FR "MODÈLE").
      const noticeWord = row.locale === 'fr' ? 'MODÈLE' : 'TEMPLATE';
      expect(row.body.startsWith('> ⚠️')).toBe(true);
      expect(row.body).toContain(noticeWord);
      expect(row.body.toLowerCase()).toContain(
        row.locale === 'fr' ? 'conseil juridique' : 'legal counsel',
      );
      // At least one bracketed placeholder for merchant-specific facts.
      expect(/\[[^\]]+\]/.test(row.body)).toBe(true);
    }
  });

  it('includes the EU model withdrawal form in both locales', async () => {
    const tenantId = await makeTenant(h);
    await seedDefaultPages(h.db, tenantId);
    const rows = await allPages(h, tenantId);

    const en = rows.find((r) => r.slug === 'withdrawal' && r.locale === 'en');
    const fr = rows.find((r) => r.slug === 'withdrawal' && r.locale === 'fr');
    expect(en!.body).toContain('Model withdrawal form');
    expect(en!.body).toContain('[TRADER NAME]');
    expect(fr!.body).toContain('formulaire type de rétractation');
    expect(fr!.body).toContain('[NOM DU PROFESSIONNEL]');
  });

  it('is idempotent — re-running does not error or duplicate', async () => {
    const tenantId = await makeTenant(h);

    const first = await seedDefaultPages(h.db, tenantId);
    expect(first).toBe(SEED_PAGE_SLUGS.length * 2);

    // Second run: no error, inserts nothing.
    const second = await seedDefaultPages(h.db, tenantId);
    expect(second).toBe(0);

    // Row count stable.
    const rows = await allPages(h, tenantId);
    expect(rows).toHaveLength(SEED_PAGE_SLUGS.length * 2);
  });

  it('seeds only the passed tenant (no cross-tenant rows)', async () => {
    const tenantA = await makeTenant(h);
    const tenantB = newId();
    await h.client`insert into tenants (id, name, slug) values (${tenantB}, ${'b'}, ${'tenant-b-' + tenantB.slice(-8)})`;

    await seedDefaultPages(h.db, tenantA);

    const rowsB = await allPages(h, tenantB);
    expect(rowsB).toHaveLength(0);
  });

  it('a seeded published page is retrievable via the store path; unknown locale → 404', async () => {
    const tenantId = await makeTenant(h);
    await seedDefaultPages(h.db, tenantId);

    const svc = h.app.get(PagesService, { strict: false });

    const en = await svc.storeFindBySlug(tenantId, 'privacy', 'en');
    expect(en.slug).toBe('privacy');
    expect(en.locale).toBe('en');
    expect(en.body.startsWith('> ⚠️')).toBe(true);

    const fr = await svc.storeFindBySlug(tenantId, 'privacy', 'fr');
    expect(fr.locale).toBe('fr');

    // No default-locale fallback: a locale with no row → 404.
    await expect(svc.storeFindBySlug(tenantId, 'privacy', 'de')).rejects.toThrow();
  });
});
