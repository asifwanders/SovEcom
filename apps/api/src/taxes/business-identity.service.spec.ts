/**
 * TenantSettingsService.updateBusinessIdentity / updateEuVatRegistration
 * unit tests. These feed INVOICES (legal/money-sensitive), so we pin:
 *  - the read-merge-write PRESERVES unrelated settings keys (analytics, tax_mode, the
 *    OTHER identity block) — it must never clobber the rest of the JSONB;
 *  - the write is TENANT-SCOPED (keys off the passed tenantId);
 *  - `parseBusinessIdentity` only returns an address when line1/city/country are present.
 *
 * The DB is mocked: `select()...limit()` returns the seeded settings row; `update()...`
 * captures the merged JSONB + the tenant id from the `where(eq(...))` argument.
 */
import { TenantSettingsService, parseBusinessIdentity } from './tenant-settings.service';

/** Build a service over a mocked db seeded with `settings`, capturing writes. */
function make(settings: Record<string, unknown>) {
  const writes: Array<{ values: unknown; where: unknown }> = [];

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [{ settings }],
  };

  const db = {
    db: {
      select: () => selectChain,
      update: () => ({
        set: (values: unknown) => ({
          where: (where: unknown) => {
            writes.push({ values, where });
            return Promise.resolve();
          },
        }),
      }),
    },
  };

  const svc = new TenantSettingsService(db as never);
  return { svc, writes };
}

/** The merged settings JSONB passed to `.set({ settings, ... })`. */
function persisted(writes: Array<{ values: unknown }>): Record<string, unknown> {
  const first = writes[0];
  if (!first) throw new Error('expected a write to have been captured');
  return (first.values as { settings: Record<string, unknown> }).settings;
}

describe('updateBusinessIdentity', () => {
  it('merges name/siren/address into business_identity, preserving other settings keys', async () => {
    const { svc, writes } = make({
      analytics: { ga4_id: 'G-KEEP' },
      tax_mode: 'eu_vat',
      eu_vat_registration: { origin_country: 'FR', vat_number: 'FR123' },
      business_identity: { name: 'Old Name', siren: 'OLD-SIREN' },
    });

    const result = await svc.updateBusinessIdentity('tenant-1', {
      name: 'Acme SARL',
      address: {
        name: 'Acme SARL',
        company: null,
        line1: '1 rue de Paris',
        line2: null,
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
      },
    });

    const saved = persisted(writes);
    // Unrelated keys preserved.
    expect(saved.analytics).toEqual({ ga4_id: 'G-KEEP' });
    expect(saved.tax_mode).toBe('eu_vat');
    expect(saved.eu_vat_registration).toEqual({ origin_country: 'FR', vat_number: 'FR123' });
    // Patched block: name replaced, siren preserved (not in patch), address set.
    const bi = saved.business_identity as Record<string, unknown>;
    expect(bi.name).toBe('Acme SARL');
    expect(bi.siren).toBe('OLD-SIREN');
    expect((bi.address as Record<string, unknown>).line1).toBe('1 rue de Paris');

    expect(result.name).toBe('Acme SARL');
    expect(result.address?.city).toBe('Paris');
  });

  it('is tenant-scoped — the write WHERE is built with the passed tenantId', async () => {
    const { svc, writes } = make({});
    await svc.updateBusinessIdentity('tenant-XYZ', { siren: '12345' });
    // The WHERE is drizzle `eq(tenants.id, tenantId)`; the bound param value lives in a
    // queryChunk carrying a `brand`/`value` pair. Assert the tenant id is that param.
    const chunks = (writes[0]?.where as { queryChunks?: unknown[] }).queryChunks ?? [];
    const boundValues = chunks
      .filter(
        (c): c is { brand: unknown; value: unknown } =>
          typeof c === 'object' && c !== null && 'brand' in c && 'value' in c,
      )
      .map((c) => c.value);
    expect(boundValues).toContain('tenant-XYZ');
  });

  it('clears the address when patched with null, keeping name/siren', async () => {
    const { svc, writes } = make({
      business_identity: { name: 'Keep', address: { line1: 'x', city: 'y', country: 'FR' } },
    });
    await svc.updateBusinessIdentity('t', { address: null });
    const bi = persisted(writes).business_identity as Record<string, unknown>;
    expect(bi.address).toBeNull();
    expect(bi.name).toBe('Keep');
  });
});

describe('updateEuVatRegistration', () => {
  it('upper-cases the origin country and preserves the business_identity block', async () => {
    const { svc, writes } = make({
      business_identity: { name: 'Acme' },
      eu_vat_registration: { origin_country: 'DE', vat_number: 'DE999' },
    });
    const result = await svc.updateEuVatRegistration('t', { originCountry: 'fr' });
    const saved = persisted(writes);
    expect(saved.business_identity).toEqual({ name: 'Acme' });
    expect((saved.eu_vat_registration as Record<string, unknown>).origin_country).toBe('FR');
    // vat_number preserved (not in patch).
    expect((saved.eu_vat_registration as Record<string, unknown>).vat_number).toBe('DE999');
    expect(result.originCountry).toBe('FR');
  });
});

describe('parseBusinessIdentity', () => {
  it('fresh store → all null', () => {
    expect(parseBusinessIdentity({})).toEqual({ name: null, siren: null, address: null });
  });

  it('drops an address missing line1/city/country → null', () => {
    const out = parseBusinessIdentity({
      business_identity: { address: { line1: 'x', city: 'y' } }, // no country
    });
    expect(out.address).toBeNull();
  });

  it('returns a full address when line1/city/country are present', () => {
    const out = parseBusinessIdentity({
      business_identity: { address: { line1: 'a', city: 'b', country: 'FR' } },
    });
    expect(out.address).toEqual({
      name: null,
      company: null,
      line1: 'a',
      line2: null,
      city: 'b',
      postalCode: null,
      country: 'FR',
    });
  });
});
