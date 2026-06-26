import {
  MODULE_PERMISSION_ALLOWLIST,
  MANIFEST_MAX_BYTES,
  moduleManifestSchema,
  parseAndVerifyManifest,
  assertCoreCompatible,
  type ModuleManifest,
} from './module-manifest';
import { CORE_API_VERSION } from './core-version';

/** A minimal, valid manifest (matches the module contract). */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'wishlist',
    displayName: 'Wishlist',
    version: '1.0.0',
    compatibleCore: '^1.0.0',
    permissions: ['read:products', 'write:own_tables'],
    slots: [
      { slot: 'product-detail-sidebar', component: 'wishlist-button' },
      { slot: 'header-icons', component: 'wishlist-icon' },
    ],
    settings: { schema: './settings.schema.json' },
    tables: ['mod_wishlist_items'],
    ...overrides,
  };
}

describe('moduleManifestSchema', () => {
  it('parses a valid manifest', () => {
    const parsed = moduleManifestSchema.parse(validManifest());
    expect(parsed.name).toBe('wishlist');
    expect(parsed.permissions).toEqual(['read:products', 'write:own_tables']);
    expect(parsed.tables).toEqual(['mod_wishlist_items']);
  });

  it('parses a minimal manifest (no slots/settings/tables)', () => {
    const parsed = moduleManifestSchema.parse({
      name: 'minimal',
      displayName: 'Minimal',
      version: '2.3.4',
      compatibleCore: '1.0.0',
      permissions: [],
    });
    expect(parsed.name).toBe('minimal');
    expect(parsed.permissions).toEqual([]);
  });

  it('rejects an uppercase name', () => {
    const r = moduleManifestSchema.safeParse(validManifest({ name: 'Wishlist' }));
    expect(r.success).toBe(false);
  });

  it('rejects a leading-digit name', () => {
    const r = moduleManifestSchema.safeParse(validManifest({ name: '1wishlist' }));
    expect(r.success).toBe(false);
  });

  it('rejects an invalid semver version', () => {
    const r = moduleManifestSchema.safeParse(validManifest({ version: 'not-a-version' }));
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('version');
  });

  it('rejects an invalid compatibleCore range', () => {
    const r = moduleManifestSchema.safeParse(validManifest({ compatibleCore: 'garbage>>' }));
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('compatibleCore');
  });

  it('rejects a permission outside the allowlist (default-deny)', () => {
    const r = moduleManifestSchema.safeParse(
      validManifest({ permissions: ['read:products', 'write:core_tables'] }),
    );
    expect(r.success).toBe(false);
  });

  it('accepts every allowlisted permission', () => {
    const parsed = moduleManifestSchema.parse(
      validManifest({ permissions: [...MODULE_PERMISSION_ALLOWLIST] }),
    );
    expect(parsed.permissions).toHaveLength(MODULE_PERMISSION_ALLOWLIST.length);
  });

  it('rejects a tables entry not matching mod_<name>_', () => {
    const r = moduleManifestSchema.safeParse(
      validManifest({ tables: ['mod_wishlist_items', 'core_products'] }),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('mod_wishlist_');
  });

  it('rejects a tables entry namespaced to a different module name', () => {
    const r = moduleManifestSchema.safeParse(
      validManifest({ name: 'wishlist', tables: ['mod_other_items'] }),
    );
    expect(r.success).toBe(false);
  });

  // The namespace check compares the `mod_<name>_` prefix as a LITERAL string (never a
  // dynamic RegExp built from `name`), so a hyphen in the slug can't be interpreted as a
  // regex range and let a module claim another module's tables.
  it('treats a hyphenated name as a literal prefix (no regex-range smuggling)', () => {
    // `a-z` is a valid slug; it must ONLY match `mod_a-z_*`, never `mod_b_*` / `mod_x_*`.
    const own = moduleManifestSchema.safeParse(
      validManifest({ name: 'a-z', tables: ['mod_a-z_items'] }),
    );
    expect(own.success).toBe(true);
    const smuggled = moduleManifestSchema.safeParse(
      validManifest({ name: 'a-z', tables: ['mod_b_customers'] }),
    );
    expect(smuggled.success).toBe(false);
  });

  it('rejects an unknown top-level key (.strict)', () => {
    const r = moduleManifestSchema.safeParse(validManifest({ surprise: true }));
    expect(r.success).toBe(false);
  });

  // ── slots: structured {slot, component} entries ──────────────────
  describe('slots (structured slot/component entries)', () => {
    it('parses valid slot entries (slot + component slugs)', () => {
      const parsed = moduleManifestSchema.parse(
        validManifest({ slots: [{ slot: 'footer', component: 'newsletter-form' }] }),
      );
      expect(parsed.slots).toEqual([{ slot: 'footer', component: 'newsletter-form' }]);
    });

    it('rejects a slot entry with an uppercase slot slug', () => {
      const r = moduleManifestSchema.safeParse(
        validManifest({ slots: [{ slot: 'Footer', component: 'newsletter-form' }] }),
      );
      expect(r.success).toBe(false);
    });

    it('rejects a slot entry with an uppercase component slug', () => {
      const r = moduleManifestSchema.safeParse(
        validManifest({ slots: [{ slot: 'footer', component: 'Newsletter-Form' }] }),
      );
      expect(r.success).toBe(false);
    });

    it('rejects a slot entry missing the component', () => {
      const r = moduleManifestSchema.safeParse(validManifest({ slots: [{ slot: 'footer' }] }));
      expect(r.success).toBe(false);
    });

    it('rejects an extra key inside a slot entry (.strict)', () => {
      const r = moduleManifestSchema.safeParse(
        validManifest({
          slots: [{ slot: 'footer', component: 'newsletter-form', priority: 1 }],
        }),
      );
      expect(r.success).toBe(false);
    });

    it('rejects more than MAX_SLOTS entries', () => {
      const many = Array.from({ length: 65 }, (_, i) => ({
        slot: `slot-${i}`,
        component: `component-${i}`,
      }));
      const r = moduleManifestSchema.safeParse(validManifest({ slots: many }));
      expect(r.success).toBe(false);
    });

    it('rejects the SAME slot declared more than once (no self-conflict)', () => {
      // A module fills a slot at most once — declaring it twice would force the
      // registry to silently drop one component. Rejected at the boundary.
      const r = moduleManifestSchema.safeParse(
        validManifest({
          slots: [
            { slot: 'footer', component: 'newsletter-form' },
            { slot: 'footer', component: 'social-links' },
          ],
        }),
      );
      expect(r.success).toBe(false);
    });
  });
});

describe('parseAndVerifyManifest', () => {
  it('returns a typed manifest for valid JSON', () => {
    const m: ModuleManifest = parseAndVerifyManifest(JSON.stringify(validManifest()));
    expect(m.name).toBe('wishlist');
  });

  it('rejects raw larger than MANIFEST_MAX_BYTES', () => {
    const padded = validManifest({ displayName: 'x'.repeat(MANIFEST_MAX_BYTES) });
    expect(() => parseAndVerifyManifest(JSON.stringify(padded))).toThrow(
      /too large|exceeds|bytes/i,
    );
  });

  it('throws a clear error on malformed JSON', () => {
    expect(() => parseAndVerifyManifest('{ not valid json ')).toThrow(/JSON/i);
  });

  it('throws a descriptive error on a schema-invalid manifest', () => {
    expect(() => parseAndVerifyManifest(JSON.stringify(validManifest({ name: 'BAD' })))).toThrow(
      /manifest/i,
    );
  });
});

describe('assertCoreCompatible', () => {
  const base = parseAndVerifyManifest(JSON.stringify(validManifest()));

  it('passes for ^1.0.0 against CORE 1.0.0', () => {
    expect(CORE_API_VERSION).toBe('1.0.0');
    expect(() => assertCoreCompatible({ ...base, compatibleCore: '^1.0.0' })).not.toThrow();
  });

  it('passes for an exact 1.0.0', () => {
    expect(() => assertCoreCompatible({ ...base, compatibleCore: '1.0.0' })).not.toThrow();
  });

  it('fails for ^2.0.0 (different major) with a clear message', () => {
    expect(() => assertCoreCompatible({ ...base, compatibleCore: '^2.0.0' })).toThrow(
      /compatible|version|major/i,
    );
  });

  it('fails for >=2', () => {
    expect(() => assertCoreCompatible({ ...base, compatibleCore: '>=2' })).toThrow();
  });

  it('passes for >=1.0.0', () => {
    expect(() => assertCoreCompatible({ ...base, compatibleCore: '>=1.0.0' })).not.toThrow();
  });
});
