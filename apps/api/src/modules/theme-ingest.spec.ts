/**
 * ThemeIngestService unit tests.
 *
 * The theme-side security tests. Themes are declarative assets (no worker, no
 * permissions, no code execution), but they use the same hardened {@link GuardedTarExtractor},
 * so supply-chain risks — zip-slip, zip-bomb, symlinks — must be defended here. These tests
 * fabricate malicious tarballs in-process (traversal, absolute paths, symlinks, hardlinks,
 * oversized/lying-size entries) and assert the service rejects them WITHOUT writing outside
 * the destination root, WITHOUT executing any code, and cleans up partial extractions.
 * The install/commit/discard lifecycle (no overwrite / no auto-update) is covered alongside.
 *
 * We hand-roll a minimal USTAR writer to craft entries that test security boundaries.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  ThemeIngestService,
  ThemeIngestError,
  THEME_MANIFEST_FILENAME,
} from './theme-ingest.service';
import { MANIFEST_MAX_BYTES } from './module-manifest';

// ── minimal USTAR tar writer ───────────────────────────────────────────────────
// typeflag: '0' file, '5' dir, '2' symlink, '1' hardlink. 512-byte blocks; two
// trailing zero blocks end the archive.

const BLOCK = 512;

interface TarEntry {
  name: string;
  type?: '0' | '5' | '2' | '1';
  data?: Buffer;
  /** Override the declared size in the header (to forge a "lying" size). */
  declaredSize?: number;
  linkname?: string;
}

function octal(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}

function tarHeader(entry: TarEntry): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  const name = entry.name;
  buf.write(name.slice(0, 100), 0, 'utf8'); // name [0..100)
  buf.write('0000644\0', 100, 'ascii'); // mode [100..108)
  buf.write('0000000\0', 108, 'ascii'); // uid  [108..116)
  buf.write('0000000\0', 116, 'ascii'); // gid  [116..124)
  const size = entry.declaredSize ?? entry.data?.length ?? 0;
  buf.write(octal(size, 12), 124, 'ascii'); // size [124..136)
  buf.write(octal(0, 12), 136, 'ascii'); // mtime [136..148)
  buf.write('        ', 148, 'ascii'); // checksum field as spaces while computing
  buf.write(entry.type ?? '0', 156, 'ascii'); // typeflag [156]
  if (entry.linkname) buf.write(entry.linkname.slice(0, 100), 157, 'utf8'); // linkname [157..257)
  buf.write('ustar\0', 257, 'ascii'); // magic [257..263)
  buf.write('00', 263, 'ascii'); // version [263..265)

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i] ?? 0;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}

function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e));
    if (e.type === '5' || e.type === '2' || e.type === '1') continue;
    const data = e.data ?? Buffer.alloc(0);
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

function gzip(buf: Buffer): Buffer {
  return zlib.gzipSync(buf);
}

/** A minimal valid theme manifest as raw JSON bytes. */
function manifestJson(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      name: 'aurora',
      displayName: 'Aurora',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      slots: ['product-page', 'footer'],
      settingsSchema: './settings.schema.json',
      ...overrides,
    }),
  );
}

/** A standard npm-style theme tarball: everything under `package/`. */
function validTgz(extra: TarEntry[] = []): Buffer {
  return gzip(
    buildTar([
      { name: 'package/', type: '5' },
      { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
      { name: 'package/templates/product.html', data: Buffer.from('<main></main>\n') },
      ...extra,
    ]),
  );
}

// ── harness ────────────────────────────────────────────────────────────────────

let baseDir: string;
let svc: ThemeIngestService;

beforeEach(async () => {
  baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'themeroot-'));
  svc = new ThemeIngestService(baseDir);
});

afterEach(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true });
});

/** All files (relative paths) currently present under the themes root. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(root, full));
    }
  }
  await walk(root);
  return out;
}

/** Count residual `.ingest-*` temp dirs (orphaned partial extractions). */
async function tempIngestDirs(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && e.name.startsWith('.ingest-')).map((e) => e.name);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('ThemeIngestService — happy path', () => {
  it('extracts a valid theme tarball and returns the verified manifest in an ISOLATED temp dir', async () => {
    const { manifest, extractedDir } = await svc.ingest(validTgz());
    expect(manifest.name).toBe('aurora');
    expect(manifest.slots).toEqual(['product-page', 'footer']);
    // Install mode leaves the tree in an isolated `.ingest-*` temp dir for the caller to commit.
    expect(path.dirname(extractedDir)).toBe(path.resolve(baseDir));
    expect(path.basename(extractedDir).startsWith('.ingest-')).toBe(true);
    expect(extractedDir).not.toBe(path.join(baseDir, 'aurora'));
    expect(fs.existsSync(path.join(extractedDir, THEME_MANIFEST_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(extractedDir, 'templates', 'product.html'))).toBe(true);
    // The per-theme dir is created only by an explicit commit.
    expect(fs.existsSync(path.join(baseDir, 'aurora'))).toBe(false);
  });

  it('commitExtraction places a verified temp dir at themes/<name>; discardExtraction removes it', async () => {
    const { extractedDir } = await svc.ingest(validTgz());
    const themeDir = await svc.commitExtraction(extractedDir, 'aurora');
    expect(themeDir).toBe(path.join(baseDir, 'aurora'));
    expect(fs.existsSync(path.join(themeDir, THEME_MANIFEST_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(themeDir, 'templates', 'product.html'))).toBe(true);
    expect(await tempIngestDirs(baseDir)).toEqual([]); // temp dir consumed by the rename

    // discardExtraction removes a temp dir without touching themes/<name>
    const second = await svc.ingest(validTgz());
    await svc.discardExtraction(second.extractedDir);
    expect(fs.existsSync(second.extractedDir)).toBe(false);
    expect(fs.existsSync(themeDir)).toBe(true); // the committed theme is untouched
  });

  it('commitExtraction refuses an invalid theme name', async () => {
    const { extractedDir } = await svc.ingest(validTgz());
    await expect(svc.commitExtraction(extractedDir, 'BAD_UPPER')).rejects.toThrow(/invalid name/i);
    await expect(svc.commitExtraction(extractedDir, '../escape')).rejects.toThrow(/invalid name/i);
  });

  it('commitExtraction refuses a temp dir outside the themes root', async () => {
    await expect(
      svc.commitExtraction(path.join(os.tmpdir(), 'elsewhere'), 'aurora'),
    ).rejects.toThrow(/outside the themes root/i);
  });

  it('discardExtraction REFUSES to remove a real theme dir (only .ingest-* temps)', async () => {
    const { extractedDir } = await svc.ingest(validTgz());
    const themeDir = await svc.commitExtraction(extractedDir, 'aurora');
    await svc.discardExtraction(themeDir); // not an .ingest-* temp -> no-op, never an rmrf
    expect(fs.existsSync(themeDir)).toBe(true);
    expect(fs.existsSync(path.join(themeDir, THEME_MANIFEST_FILENAME))).toBe(true);
  });

  it('removeThemeDir deletes a committed theme by name; refuses non-slug names', async () => {
    const { extractedDir } = await svc.ingest(validTgz());
    const themeDir = await svc.commitExtraction(extractedDir, 'aurora');
    expect(fs.existsSync(themeDir)).toBe(true);
    await svc.removeThemeDir('aurora');
    expect(fs.existsSync(themeDir)).toBe(false);

    // A non-slug / traversal name is a best-effort no-op that never throws and never touches the FS.
    await expect(svc.removeThemeDir('../baseDir')).resolves.toBeUndefined();
    await expect(svc.removeThemeDir('BAD')).resolves.toBeUndefined();
    await expect(svc.removeThemeDir('does-not-exist')).resolves.toBeUndefined();
  });

  it('accepts a local file path as well as a Buffer', async () => {
    const tgzPath = path.join(baseDir, 'theme.tgz');
    await fsp.writeFile(tgzPath, validTgz());
    const { manifest } = await svc.ingest(tgzPath);
    expect(manifest.name).toBe('aurora');
  });

  it('inspect mode cleans up the extraction dir (verify-only)', async () => {
    const { manifest, extractedDir } = await svc.ingest(validTgz(), { mode: 'inspect' });
    expect(manifest.name).toBe('aurora');
    expect(fs.existsSync(extractedDir)).toBe(false);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
    expect(fs.existsSync(path.join(baseDir, 'aurora'))).toBe(false);
  });

  it('confined: every written path is under the dest root', async () => {
    const { extractedDir } = await svc.ingest(validTgz());
    const files = await listFiles(extractedDir);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const abs = path.resolve(extractedDir, rel);
      expect(abs.startsWith(extractedDir + path.sep)).toBe(true);
    }
  });
});

describe('ThemeIngestService — zip-slip / traversal', () => {
  it('rejects a `../evil.txt` entry and writes nothing outside the root', async () => {
    const tgz = gzip(
      buildTar([
        { name: 'package/', type: '5' },
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/../../evil.txt', data: Buffer.from('pwned') },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(ThemeIngestError);
    expect(fs.existsSync(path.join(path.dirname(baseDir), 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'evil.txt'))).toBe(false);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
    expect(fs.existsSync(path.join(baseDir, 'aurora'))).toBe(false);
  });

  it('rejects an absolute `/etc/...`-style entry', async () => {
    const tgz = gzip(
      buildTar([
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: '/etc/sovecom-theme-evil', data: Buffer.from('x') },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/unsafe|outside|zip-slip/i);
    expect(fs.existsSync('/etc/sovecom-theme-evil')).toBe(false);
  });

  it('rejects a `..` segment even after the package/ strip', async () => {
    const tgz = gzip(
      buildTar([
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/../evil', data: Buffer.from('x') },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(ThemeIngestError);
    expect(fs.existsSync(path.join(path.dirname(baseDir), 'evil'))).toBe(false);
  });
});

describe('ThemeIngestService — symlink / hardlink entries', () => {
  it('rejects a symlink entry', async () => {
    const tgz = gzip(
      buildTar([
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/link', type: '2', linkname: '/etc/passwd' },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/link|type|disallowed/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('rejects a hardlink entry', async () => {
    const tgz = gzip(
      buildTar([
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/hard', type: '1', linkname: 'package/sovecom.theme.json' },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/link|type|disallowed/i);
  });
});

describe('ThemeIngestService — size caps (enforced DURING extraction)', () => {
  it('rejects when total uncompressed exceeds the cap', async () => {
    const small = new ThemeIngestService(baseDir, { maxTotalUncompressedBytes: 1024 });
    const tgz = gzip(
      buildTar([
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/big.bin', data: Buffer.alloc(4096, 0x61) },
      ]),
    );
    await expect(small.ingest(tgz)).rejects.toThrow(/too large|cap|exceed/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('rejects when a single file exceeds the per-file cap', async () => {
    const small = new ThemeIngestService(baseDir, {
      maxFileUncompressedBytes: 1024,
      maxTotalUncompressedBytes: 1024 * 1024,
    });
    const tgz = gzip(
      buildTar([
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/big.bin', data: Buffer.alloc(4096, 0x62) },
      ]),
    );
    await expect(small.ingest(tgz)).rejects.toThrow(/file too large|cap|exceed|size/i);
  });

  it('rejects when the file COUNT exceeds the cap', async () => {
    const small = new ThemeIngestService(baseDir, { maxEntries: 3 });
    const entries: TarEntry[] = [
      { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
    ];
    for (let i = 0; i < 10; i++)
      entries.push({ name: `package/f${i}.txt`, data: Buffer.from('x') });
    await expect(small.ingest(gzip(buildTar(entries)))).rejects.toThrow(/many entries|cap|exceed/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('rejects when the compressed tarball exceeds the cap (Buffer)', async () => {
    const small = new ThemeIngestService(baseDir, { maxCompressedBytes: 64 });
    await expect(small.ingest(validTgz())).rejects.toThrow(/too large|compressed|cap/i);
  });

  it('rejects when the compressed file on disk exceeds the cap (path)', async () => {
    const small = new ThemeIngestService(baseDir, { maxCompressedBytes: 64 });
    const tgzPath = path.join(baseDir, 'big.tgz');
    await fsp.writeFile(tgzPath, validTgz());
    await expect(small.ingest(tgzPath)).rejects.toThrow(/too large|compressed|cap/i);
  });

  it('rejects a header that DECLARES an oversized file (lying-size bomb guard)', async () => {
    const small = new ThemeIngestService(baseDir, { maxFileUncompressedBytes: 1024 });
    const tgz = gzip(
      buildTar([
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/lying.bin', data: Buffer.from('x'), declaredSize: 10_000_000 },
      ]),
    );
    await expect(small.ingest(tgz)).rejects.toThrow(/size cap|exceed|too large/i);
  });
});

describe('ThemeIngestService — no code execution', () => {
  it('never runs a package.json postinstall script', async () => {
    const marker = path.join(baseDir, 'PWNED_MARKER');
    const pkgJson = JSON.stringify({
      name: 'aurora',
      version: '1.0.0',
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','x')"` },
    });
    const tgz = validTgz([{ name: 'package/package.json', data: Buffer.from(pkgJson) }]);
    const { manifest } = await svc.ingest(tgz);
    expect(manifest.name).toBe('aurora');
    // The postinstall NEVER ran — themes execute no code, ever.
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('ThemeIngestService — manifest verification surfaces', () => {
  it('clear error when sovecom.theme.json is missing', async () => {
    const tgz = gzip(
      buildTar([
        { name: 'package/', type: '5' },
        { name: 'package/templates/product.html', data: Buffer.from('<main></main>') },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/manifest.*not found|not found.*manifest/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('rejects an oversized manifest (bounded read)', async () => {
    // > 64 KiB manifest. JSON-valid but blows the byte cap.
    const huge = manifestJson({ displayName: 'x'.repeat(70 * 1024) });
    const tgz = gzip(buildTar([{ name: `package/${THEME_MANIFEST_FILENAME}`, data: huge }]));
    await expect(svc.ingest(tgz)).rejects.toThrow(/too large|cap|exceed/i);
  });

  it('surfaces the invalid-manifest error (non-slug name)', async () => {
    const bad = manifestJson({ name: 'BAD_UPPER' });
    const tgz = gzip(buildTar([{ name: `package/${THEME_MANIFEST_FILENAME}`, data: bad }]));
    await expect(svc.ingest(tgz)).rejects.toThrow(/invalid theme manifest|name/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('surfaces the incompatible-core error', async () => {
    const incompat = manifestJson({ compatibleCore: '^2.0.0' });
    const tgz = gzip(buildTar([{ name: `package/${THEME_MANIFEST_FILENAME}`, data: incompat }]));
    await expect(svc.ingest(tgz)).rejects.toThrow(/compatible|major|version/i);
  });
});

describe('ThemeIngestService — cleanup on error', () => {
  it('cleans up the partial extraction dir on a mid-stream failure', async () => {
    const small = new ThemeIngestService(baseDir, { maxTotalUncompressedBytes: 512 });
    const tgz = gzip(
      buildTar([
        { name: `package/${THEME_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/a.bin', data: Buffer.alloc(2048, 0x63) },
      ]),
    );
    await expect(small.ingest(tgz)).rejects.toThrow();
    // No `.ingest-*` temp dir and no `aurora` dir left behind.
    expect(await tempIngestDirs(baseDir)).toEqual([]);
    const remaining = await fsp.readdir(baseDir);
    expect(remaining).toEqual([]);
  });

  it('rejects a non-existent local tarball path with a clear error', async () => {
    await expect(svc.ingest(path.join(baseDir, 'nope.tgz'))).rejects.toThrow(/not found/i);
  });
});

describe('ThemeIngestService — wire template capture + validation', () => {
  /** A valid `home` page template as raw JSON bytes. */
  function homeTemplate(over: Record<string, unknown> = {}): Buffer {
    return Buffer.from(JSON.stringify({ page: 'home', sections: [{ type: 'hero' }], ...over }));
  }

  /** A theme tarball that declares + ships templates. `declarations` = manifest `templates[]`. */
  function tgzWithTemplates(
    declarations: { page: string; path: string }[],
    files: TarEntry[],
  ): Buffer {
    return gzip(
      buildTar([
        { name: 'package/', type: '5' },
        {
          name: `package/${THEME_MANIFEST_FILENAME}`,
          data: manifestJson({ templates: declarations }),
        },
        ...files,
      ]),
    );
  }

  it('a tokens-only theme (no templates declared) yields an empty templates map', async () => {
    const { templates } = await svc.ingest(validTgz());
    expect(templates).toEqual({});
  });

  it('captures + validates a declared template, keyed by page type', async () => {
    const tgz = tgzWithTemplates(
      [
        { page: 'home', path: 'templates/home.json' },
        { page: 'product', path: 'product.json' },
      ],
      [
        { name: 'package/templates/home.json', data: homeTemplate() },
        {
          name: 'package/product.json',
          data: Buffer.from(JSON.stringify({ page: 'product', sections: [] })),
        },
      ],
    );
    const { templates } = await svc.ingest(tgz);
    expect(Object.keys(templates).sort()).toEqual(['home', 'product']);
    expect(templates.home).toEqual({ page: 'home', sections: [{ type: 'hero' }] });
    expect(templates.product).toEqual({ page: 'product', sections: [] });
  });

  it('REJECTS the install when a declared template file is missing', async () => {
    const tgz = tgzWithTemplates([{ page: 'home', path: 'templates/home.json' }], []);
    await expect(svc.ingest(tgz)).rejects.toThrow(/not found at the declared path/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]); // cleaned up, no orphan
  });

  it('REJECTS the install when a template is invalid JSON / fails parseTemplate', async () => {
    const tgz = tgzWithTemplates(
      [{ page: 'home', path: 'home.json' }],
      [{ name: 'package/home.json', data: Buffer.from('{not json') }],
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/template for page "home" is invalid/i);
  });

  it('REJECTS the install when a template has an unknown key (.strict) / over-deep regions', async () => {
    const tgz = tgzWithTemplates(
      [{ page: 'home', path: 'home.json' }],
      [
        {
          name: 'package/home.json',
          data: Buffer.from(
            JSON.stringify({ page: 'home', sections: [{ type: 'hero', rogue: 1 }] }),
          ),
        },
      ],
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/template for page "home" is invalid/i);
  });

  it('REJECTS the install when the template page does NOT match the declaration (page spoof)', async () => {
    const tgz = tgzWithTemplates(
      [{ page: 'home', path: 'home.json' }],
      // file claims page:"product" but the manifest declares it as "home"
      [
        {
          name: 'package/home.json',
          data: Buffer.from(JSON.stringify({ page: 'product', sections: [] })),
        },
      ],
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/template page mismatch/i);
  });

  it('REJECTS the install when a template breaches the per-template byte cap (oversize)', async () => {
    const padded = {
      page: 'home',
      sections: [{ type: 'hero', settings: { note: 'x'.repeat(MANIFEST_MAX_BYTES + 100) } }],
    };
    const json = JSON.stringify(padded);
    expect(Buffer.byteLength(json)).toBeGreaterThan(MANIFEST_MAX_BYTES);
    const tgz = tgzWithTemplates(
      [{ page: 'home', path: 'home.json' }],
      [{ name: 'package/home.json', data: Buffer.from(json) }],
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/too large/i);
  });

  it('REJECTS the install when the aggregate byte cap across templates is exceeded', async () => {
    // Shrink the aggregate cap so two valid-but-not-tiny templates exceed it (the default 6× cap is
    // unreachable given the ≤6-template count + per-file cap — it is defence-in-depth; this exercises
    // the guard directly).
    const tight = new ThemeIngestService(baseDir, { aggregateTemplateBytes: 1024 });
    const body = (page: string) =>
      Buffer.from(
        JSON.stringify({ page, sections: [{ type: 'hero', settings: { note: 'y'.repeat(700) } }] }),
      );
    const tgz = tgzWithTemplates(
      [
        { page: 'home', path: 'home.json' },
        { page: 'product', path: 'product.json' },
      ],
      [
        { name: 'package/home.json', data: body('home') },
        { name: 'package/product.json', data: body('product') },
      ],
    );
    await expect(tight.ingest(tgz)).rejects.toThrow(/aggregate/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('REJECTS a manifest that declares a traversal template path (schema gate, before any read)', async () => {
    const tgz = tgzWithTemplates(
      [{ page: 'home', path: '../../escape.json' }],
      [{ name: 'package/home.json', data: homeTemplate() }],
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(
      /invalid theme manifest|escaped the extraction root/i,
    );
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('inspect mode also validates templates and cleans up', async () => {
    const tgz = tgzWithTemplates(
      [{ page: 'home', path: 'home.json' }],
      [{ name: 'package/home.json', data: homeTemplate() }],
    );
    const { templates, extractedDir } = await svc.ingest(tgz, { mode: 'inspect' });
    expect(templates.home).toBeDefined();
    expect(fs.existsSync(extractedDir)).toBe(false);
  });
});

describe('ThemeIngestService — config / root', () => {
  it('uses the overridden root (tests never touch /data/themes)', () => {
    expect(svc.root).toBe(path.resolve(baseDir));
  });

  it('reads THEMES_DATA_PATH from env when no override is given', () => {
    const prev = process.env['THEMES_DATA_PATH'];
    process.env['THEMES_DATA_PATH'] = '/tmp/sovecom-themes-test';
    try {
      const s = new ThemeIngestService();
      expect(s.root).toBe(path.resolve('/tmp/sovecom-themes-test'));
    } finally {
      if (prev === undefined) delete process.env['THEMES_DATA_PATH'];
      else process.env['THEMES_DATA_PATH'] = prev;
    }
  });
});
