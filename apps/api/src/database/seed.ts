import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { EU_STANDARD_RATES } from '../taxes/engine/eu-vat-rules';
import { seedDefaultPages } from './seeds/pages/seed-pages';
import { seedE2eFixture, PLACEHOLDER_PASSWORD_HASH } from './seeds/e2e/seed-e2e-fixture';
import { seedBundledThemes } from './seeds/themes/seed-themes';

/**
 * Idempotently seeds the install baseline. Run with `pnpm seed`.
 *
 * Creates (all via insert + ON CONFLICT DO NOTHING so re-runs are no-ops):
 *   - the single default tenant (slug 'default'),
 *   - an admin-user shell for it. The seed never
 *     sets a usable default password — `password_hash` is a sentinel Argon2id-shaped
 *     placeholder (satisfies the `$argon2id$` CHECK) that no password verifies against;
 *     the real credential is set through the one-time setup-token flow.
 *   - the three system_state keys (`installed`, `version`, `default_tenant_id`).
 *
 * No `eq`/relational query — keeps clean under the api's nodenext type resolution.
 */
// PLACEHOLDER_PASSWORD_HASH is the single source of truth in seed-e2e-fixture.ts (so the E2E
// fixture's fail-safe admin mutation matches the exact sentinel this baseline writes) — imported above.
const ADMIN_EMAIL = 'admin@default.local';
const APP_VERSION = '0.0.1';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    // 1. Default tenant.
    const inserted = await db
      .insert(schema.tenants)
      .values({ name: 'Default Store', slug: 'default' })
      .onConflictDoNothing({ target: schema.tenants.slug })
      .returning();

    let [tenant] = inserted;
    if (!tenant) {
      const existing = await client<
        { id: string }[]
      >`select id from tenants where slug = 'default'`;
      const row = existing[0];
      if (!row) {
        throw new Error('default tenant missing after seed insert');
      }
      tenant = { id: row.id } as typeof schema.tenants.$inferSelect;
      console.log('Default tenant already exists (slug "default").');
    } else {
      console.log(`Default tenant created: ${tenant.id}`);
    }

    // 2. Admin-user shell (no usable password — set via setup-token flow).
    await db
      .insert(schema.users)
      .values({
        tenantId: tenant.id,
        email: ADMIN_EMAIL,
        passwordHash: PLACEHOLDER_PASSWORD_HASH,
        name: 'Administrator',
        role: 'owner',
      })
      .onConflictDoNothing();

    // 3. system_state keys the install + seed rely on.
    await db
      .insert(schema.systemState)
      .values([
        { key: 'installed', value: false },
        { key: 'version', value: APP_VERSION },
        { key: 'default_tenant_id', value: tenant.id },
      ])
      .onConflictDoNothing({ target: schema.systemState.key });

    // 4. Default FR commerce baseline. EU-first.
    //    Idempotent; all scoped to the default tenant. Uses the Drizzle insert API so
    //    the `id` $defaultFn (uuidv7) is applied automatically.

    // 4a. EU-27 STANDARD VAT rates, country-wide
    //     (region NULL). The eu_vat resolver reads these by destination/origin country.
    //     The tax_rates unique index is on (tenant_id, country, coalesce(region,'')),
    //     so a raw ON CONFLICT can't target it — guard each with an existence check.
    //     Rates are the source of truth in eu-vat-rules.EU_STANDARD_RATES (yearly review).
    let seededTax = 0;
    for (const [country, fraction] of EU_STANDARD_RATES) {
      const existing = await client`
        select 1 from tax_rates where tenant_id = ${tenant.id} and country = ${country} and region is null limit 1
      `;
      if (existing.length > 0) continue;
      // NUMERIC(5,4) string: 0.2 → "0.2000", 0.255 → "0.2550".
      const rate = fraction.toFixed(4);
      const name = country === 'FR' ? 'TVA standard' : `VAT standard (${country})`;
      await db.insert(schema.taxRates).values({
        tenantId: tenant.id,
        country,
        region: null,
        rate,
        name,
      });
      seededTax += 1;
    }
    if (seededTax > 0) {
      console.log(`Seeded ${seededTax} EU-27 standard VAT rates.`);
    }

    // 4b. Default FR shipping zone + one flat rate (€4.90).
    const existingZone = await client<{ id: string }[]>`
      select id from shipping_zones where tenant_id = ${tenant.id} and name = 'France' limit 1
    `;
    let zoneId = existingZone[0]?.id;
    if (!zoneId) {
      const [zone] = await db
        .insert(schema.shippingZones)
        .values({ tenantId: tenant.id, name: 'France', countries: ['FR'] })
        .returning();
      if (!zone) {
        throw new Error('shipping zone missing after seed insert');
      }
      zoneId = zone.id;
      console.log(`Default FR shipping zone created: ${zoneId}`);
    }

    const existingRate = await client`
      select 1 from shipping_rates where tenant_id = ${tenant.id} and zone_id = ${zoneId} and name = 'Colissimo' limit 1
    `;
    if (existingRate.length === 0) {
      await db.insert(schema.shippingRates).values({
        tenantId: tenant.id,
        zoneId,
        name: 'Colissimo',
        type: 'flat',
        amount: 490,
        currency: 'EUR',
      });
      console.log('Default FR shipping rate created (Colissimo flat €4.90).');
    }

    // 4c. Default EU legal/content pages, FR+EN,
    //     published TEMPLATES flagged for counsel. Idempotent (ON CONFLICT DO
    //     NOTHING) and NON-BLOCKING: a failure here must never abort the install
    //     seed, so it is wrapped — log + continue.
    try {
      const seededPages = await seedDefaultPages(db, tenant.id);
      if (seededPages > 0) {
        console.log(`Seeded ${seededPages} default legal/content page rows (FR+EN templates).`);
      }
    } catch (pagesErr) {
      console.warn('Default pages seed skipped (non-fatal):', pagesErr);
    }

    // 4e. Bundled themes (`default` + `boutique`) into installed_themes (follow-up A) so the admin
    //     theme-switcher lists/activates them and activating `boutique` renders Boutique by active
    //     NAME (no STOREFRONT_THEME env). Idempotent + NON-CLOBBERING (ON CONFLICT DO NOTHING; sets
    //     `default` active ONLY if the tenant has no active theme) → SELF-HEALING on every boot for
    //     already-provisioned tenants, no backfill migration needed. NON-BLOCKING (log + continue)
    //     like the pages seed — a theme-seed failure must never abort the baseline install seed.
    try {
      const seededThemes = await seedBundledThemes(db, tenant.id);
      if (seededThemes > 0) {
        console.log(`Seeded ${seededThemes} bundled theme rows (default + boutique).`);
      }
    } catch (themesErr) {
      console.warn('Bundled themes seed skipped (non-fatal):', themesErr);
    }

    // 4d. OPT-IN deterministic storefront-E2E catalog fixture.
    //     OFF by default so a real install stays catalog-empty; ON only when `SEED_E2E_FIXTURE=1` (the
    //     CI `storefront-e2e` job + local E2E runners). Idempotent + NON-BLOCKING (log + continue) like
    //     the pages seed — a fixture failure must never abort the baseline install seed.
    if (process.env.SEED_E2E_FIXTURE === '1') {
      // Defense-in-depth (finding #1): this branch overwrites the admin credential with a repo-public
      // plaintext and flips `installed=true`. `pnpm seed` bypasses env.validation.ts, so guard here.
      // Throw OUTSIDE the try/catch below (which is log-and-continue) so production aborts LOUDLY —
      // `main`'s outer catch then `process.exit(1)`s. The fixture re-checks this itself (second line).
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'SEED_E2E_FIXTURE=1 is set in production. Refusing to seed the public test admin credential / flip installed=true.',
        );
      }
      try {
        const seededFixture = await seedE2eFixture(db, tenant.id);
        if (seededFixture > 0) {
          console.log(`Seeded the storefront-E2E catalog fixture (${seededFixture} rows).`);
        } else {
          console.log('Storefront-E2E catalog fixture already present (no-op).');
        }
      } catch (fixtureErr) {
        console.warn('E2E catalog fixture seed skipped (non-fatal):', fixtureErr);
      }
    }

    await client.end();
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    await client.end();
    process.exit(1);
  }
}

void main();
