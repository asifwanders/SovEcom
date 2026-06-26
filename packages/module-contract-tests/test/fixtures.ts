/**
 * Shared fixture builder for the contract-test suite. Writes a minimal module directory
 * (`sovecom.module.json` + `src/index.ts` + optional `src/db/schema.ts`) into a fresh temp dir
 * so each check can be exercised against a crafted GOOD or BAD module without touching the repo.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FixtureSpec {
  /** Raw `sovecom.module.json` contents. If omitted, a valid default manifest is written. */
  manifest?: string | Record<string, unknown>;
  /** Contents of `src/index.ts`. If omitted, a minimal `defineModule({ activate() {} })` body. */
  indexTs?: string;
  /** Optional `src/db/schema.ts` contents. */
  schemaTs?: string;
  /** Skip writing `sovecom.module.json` entirely (to exercise the missing-manifest path). */
  omitManifest?: boolean;
}

const created: string[] = [];

export function makeModuleDir(spec: FixtureSpec = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'mct-fixture-'));
  created.push(dir);

  if (!spec.omitManifest) {
    const manifest =
      spec.manifest === undefined
        ? defaultManifest('demo')
        : typeof spec.manifest === 'string'
          ? spec.manifest
          : JSON.stringify(spec.manifest, null, 2);
    writeFileSync(join(dir, 'sovecom.module.json'), manifest, 'utf8');
  }

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    spec.indexTs ??
      `import { defineModule } from '@sovecom/module-sdk';\nexport default defineModule({ async activate(sdk) { void sdk; } });\n`,
    'utf8',
  );

  if (spec.schemaTs !== undefined) {
    mkdirSync(join(dir, 'src', 'db'), { recursive: true });
    writeFileSync(join(dir, 'src', 'db', 'schema.ts'), spec.schemaTs, 'utf8');
  }

  return dir;
}

export function defaultManifest(name: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name,
      displayName: name,
      version: '0.1.0',
      compatibleCore: '^1.0.0',
      permissions: [],
      tables: [],
      ...overrides,
    },
    null,
    2,
  );
}

export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
