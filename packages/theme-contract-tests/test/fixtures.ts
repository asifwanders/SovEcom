/**
 * Shared fixture builder for the theme contract-test suite. Writes a minimal theme directory
 * (`sovecom.theme.json` + an MIT `LICENSE`) into a fresh temp dir so each check can be exercised
 * against a crafted GOOD or BAD theme without touching the repo. A theme has no code, so there is
 * nothing else to write.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FixtureSpec {
  /** Raw `sovecom.theme.json` contents. If omitted, a valid default manifest is written. */
  manifest?: string | Record<string, unknown>;
  /** Raw `LICENSE` contents. If omitted, the canonical MIT License is written. */
  license?: string;
  /** Skip writing `sovecom.theme.json` entirely (to exercise the missing-manifest path). */
  omitManifest?: boolean;
  /** Skip writing `LICENSE` entirely (to exercise the missing-license path). */
  omitLicense?: boolean;
}

const created: string[] = [];

export const MIT_LICENSE = `MIT License

Copyright (c) 2026 SovEcom

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** The opening of the AGPL-3.0 text the module CLI emits — used to craft a non-MIT theme. */
export const AGPL_LICENSE = `                    GNU AFFERO GENERAL PUBLIC LICENSE
                       Version 3, 19 November 2007

 Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.
`;

export function makeThemeDir(spec: FixtureSpec = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tct-fixture-'));
  created.push(dir);

  if (!spec.omitManifest) {
    const manifest =
      spec.manifest === undefined
        ? defaultManifest('demo')
        : typeof spec.manifest === 'string'
          ? spec.manifest
          : JSON.stringify(spec.manifest, null, 2);
    writeFileSync(join(dir, 'sovecom.theme.json'), manifest, 'utf8');
  }

  if (!spec.omitLicense) {
    writeFileSync(join(dir, 'LICENSE'), spec.license ?? MIT_LICENSE, 'utf8');
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
      slots: ['product-page'],
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
