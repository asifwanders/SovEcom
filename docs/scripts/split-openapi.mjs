// Splits the committed apps/api/openapi.json into Admin / Store / Setup specs so the
// docs site can render three separate API-reference sections. Run before `astro build`.
//
// ponytail: keeps full `components` in each split (no reference pruning) — tiny duplication,
// zero chance of a dangling $ref. Prune only if the spec grows large enough to matter.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'apps', 'api', 'openapi.json');
const OUT = join(here, '..', 'src', 'openapi');

const SERVERS = [{ url: 'https://your-store.example.com', description: 'Your SovEcom instance' }];

const BUCKETS = {
  admin: { title: 'SovEcom Admin API', match: (p) => p.startsWith('/admin') },
  store: { title: 'SovEcom Store API', match: (p) => p.startsWith('/store') },
  // Setup & platform: everything else (first-run setup wizard, /health, /uploads).
  setup: { title: 'SovEcom Setup & Platform API', match: (p) => !p.startsWith('/admin') && !p.startsWith('/store') },
};

const spec = JSON.parse(readFileSync(SRC, 'utf8'));
const allPaths = Object.keys(spec.paths);
mkdirSync(OUT, { recursive: true });

let split = 0;
for (const [name, { title, match }] of Object.entries(BUCKETS)) {
  const paths = Object.fromEntries(Object.entries(spec.paths).filter(([p]) => match(p)));
  const count = Object.keys(paths).length;
  split += count;
  const out = {
    ...spec,
    info: { ...spec.info, title },
    servers: SERVERS,
    paths,
  };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(out, null, 2));
  console.log(`  ${name}.json — ${count} paths`);
}

// Self-check: every source path landed in exactly one bucket (buckets are mutually exclusive + exhaustive).
if (split !== allPaths.length) {
  throw new Error(`split-openapi: bucketed ${split} paths but source has ${allPaths.length} — a path was dropped or double-counted`);
}
console.log(`split-openapi: ${allPaths.length} paths → admin/store/setup OK`);
