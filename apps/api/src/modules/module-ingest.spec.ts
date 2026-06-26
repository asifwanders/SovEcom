/**
 * ModuleIngestService unit tests.
 *
 * THE single riskiest path: supply-chain / zip-slip / zip-bomb. These tests fabricate
 * tarballs in-process — including MALICIOUS ones (traversal, absolute paths, symlinks,
 * hardlinks, oversized, postinstall scripts) — and assert the service rejects them WITHOUT
 * writing anything outside the dest root, WITHOUT executing any code, and cleans up partial
 * extractions. We hand-roll a tiny USTAR writer so we can craft entries node-tar's packer
 * would refuse to produce (`..`, `/etc/...`, symlink/hardlink type flags, lying sizes).
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  ModuleIngestService,
  ModuleIngestError,
  MODULE_MANIFEST_FILENAME,
} from './module-ingest.service';
import * as moduleIngestModule from './module-ingest.service';

// ── minimal USTAR tar writer ───────────────────────────────────────────────────
// Just enough of the tar format to forge arbitrary entries. typeflag: '0' file,
// '5' dir, '2' symlink, '1' hardlink. Each block is 512 bytes; the archive ends
// with two zero blocks.

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
  // len includes the trailing space+NUL convention; tar uses `width-1` octal digits
  // then a NUL (or space). We emit `len-1` zero-padded octal digits + NUL.
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
  // checksum field [148..156) — fill with spaces while computing.
  buf.write('        ', 148, 'ascii');
  buf.write(entry.type ?? '0', 156, 'ascii'); // typeflag [156]
  if (entry.linkname) buf.write(entry.linkname.slice(0, 100), 157, 'utf8'); // linkname [157..257)
  buf.write('ustar\0', 257, 'ascii'); // magic [257..263)
  buf.write('00', 263, 'ascii'); // version [263..265)

  // checksum = sum of all bytes with the checksum field as spaces.
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
  // two trailing zero blocks
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

function gzip(buf: Buffer): Buffer {
  return zlib.gzipSync(buf);
}

/** A minimal valid manifest as raw JSON bytes. */
function manifestJson(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      name: 'wishlist',
      displayName: 'Wishlist',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: ['read:products'],
      tables: ['mod_wishlist_items'],
      ...overrides,
    }),
  );
}

/** A standard npm-style tarball: everything under `package/`. */
function validTgz(extra: TarEntry[] = []): Buffer {
  return gzip(
    buildTar([
      { name: 'package/', type: '5' },
      { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
      { name: 'package/index.js', data: Buffer.from('module.exports = {};\n') },
      ...extra,
    ]),
  );
}

// ── harness ────────────────────────────────────────────────────────────────────

let baseDir: string;
let svc: ModuleIngestService;

beforeEach(async () => {
  baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modroot-'));
  svc = new ModuleIngestService(baseDir);
});

afterEach(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true });
});

/** All files (relative paths) currently present under the modules root. */
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

describe('ModuleIngestService — happy path', () => {
  it('extracts a valid npm-style tarball and returns the verified manifest in an ISOLATED temp dir', async () => {
    const { manifest, extractedDir } = await svc.ingest(validTgz());
    expect(manifest.name).toBe('wishlist');
    expect(manifest.permissions).toEqual(['read:products']);
    // Install mode does NOT place the tree at modules/<name> — it leaves it in an isolated
    // `.ingest-*` temp dir for the caller to commit (after claiming the DB row) or discard.
    expect(path.dirname(extractedDir)).toBe(path.resolve(baseDir));
    expect(path.basename(extractedDir).startsWith('.ingest-')).toBe(true);
    expect(extractedDir).not.toBe(path.join(baseDir, 'wishlist'));
    expect(fs.existsSync(path.join(extractedDir, MODULE_MANIFEST_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(extractedDir, 'index.js'))).toBe(true);
    // The per-module dir is created only by an explicit commit.
    expect(fs.existsSync(path.join(baseDir, 'wishlist'))).toBe(false);
  });

  it('commitExtraction places a verified temp dir at modules/<name>; discardExtraction removes it', async () => {
    const { extractedDir } = await svc.ingest(validTgz());
    const moduleDir = await svc.commitExtraction(extractedDir, 'wishlist');
    expect(moduleDir).toBe(path.join(baseDir, 'wishlist'));
    expect(fs.existsSync(path.join(moduleDir, MODULE_MANIFEST_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, 'index.js'))).toBe(true);
    // the temp dir was consumed by the rename — no orphan
    expect(await tempIngestDirs(baseDir)).toEqual([]);

    // discardExtraction removes a temp dir without touching modules/<name>
    const second = await svc.ingest(validTgz());
    await svc.discardExtraction(second.extractedDir);
    expect(fs.existsSync(second.extractedDir)).toBe(false);
    expect(fs.existsSync(moduleDir)).toBe(true); // the committed module is untouched
  });

  it('discardExtraction REFUSES to remove a real module dir (only .ingest-* temps)', async () => {
    const { extractedDir } = await svc.ingest(validTgz());
    const moduleDir = await svc.commitExtraction(extractedDir, 'wishlist');
    // Passing the real module dir (not an .ingest-* temp) must be a no-op, not an rmrf.
    await svc.discardExtraction(moduleDir);
    expect(fs.existsSync(moduleDir)).toBe(true);
    expect(fs.existsSync(path.join(moduleDir, MODULE_MANIFEST_FILENAME))).toBe(true);
  });

  it('accepts a local file path as well as a Buffer', async () => {
    const tgzPath = path.join(baseDir, 'mod.tgz');
    await fsp.writeFile(tgzPath, validTgz());
    const { manifest } = await svc.ingest(tgzPath);
    expect(manifest.name).toBe('wishlist');
  });

  it('inspect mode cleans up the extraction dir (verify-only)', async () => {
    const { manifest, extractedDir } = await svc.ingest(validTgz(), { mode: 'inspect' });
    expect(manifest.name).toBe('wishlist');
    expect(fs.existsSync(extractedDir)).toBe(false);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
    expect(fs.existsSync(path.join(baseDir, 'wishlist'))).toBe(false);
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

describe('ModuleIngestService — zip-slip / traversal', () => {
  it('rejects a `../evil.txt` entry and writes nothing outside the root', async () => {
    const tgz = gzip(
      buildTar([
        { name: 'package/', type: '5' },
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/../../evil.txt', data: Buffer.from('pwned') },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(ModuleIngestError);
    // nothing escaped: no evil.txt anywhere above the root, and no module dir kept.
    expect(fs.existsSync(path.join(path.dirname(baseDir), 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'evil.txt'))).toBe(false);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
    expect(fs.existsSync(path.join(baseDir, 'wishlist'))).toBe(false);
  });

  it('rejects an absolute `/etc/passwd`-style entry', async () => {
    const tgz = gzip(
      buildTar([
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: '/etc/sovecom-evil', data: Buffer.from('x') },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/unsafe|outside|zip-slip/i);
    expect(fs.existsSync('/etc/sovecom-evil')).toBe(false);
  });

  it('rejects a `..` segment even after the package/ strip', async () => {
    // `package/../evil` -> strip drops `package`, leaving `../evil`. The guard rejects the
    // raw `..` BEFORE stripping, so the strip can never be abused to climb out.
    const tgz = gzip(
      buildTar([
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/../evil', data: Buffer.from('x') },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(ModuleIngestError);
    expect(fs.existsSync(path.join(path.dirname(baseDir), 'evil'))).toBe(false);
  });
});

describe('ModuleIngestService — symlink / hardlink / device entries', () => {
  it('rejects a symlink entry', async () => {
    const tgz = gzip(
      buildTar([
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/link', type: '2', linkname: '/etc/passwd' },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/link|type|disallowed/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('rejects a hardlink entry', async () => {
    const tgz = gzip(
      buildTar([
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/hard', type: '1', linkname: 'package/sovecom.module.json' },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/link|type|disallowed/i);
  });
});

describe('ModuleIngestService — size caps (enforced DURING extraction)', () => {
  it('rejects when total uncompressed exceeds the cap', async () => {
    const small = new ModuleIngestService(baseDir, {
      maxTotalUncompressedBytes: 1024,
    });
    const big = Buffer.alloc(4096, 0x61);
    const tgz = gzip(
      buildTar([
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/big.bin', data: big },
      ]),
    );
    await expect(small.ingest(tgz)).rejects.toThrow(/too large|cap|exceed/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('rejects when a single file exceeds the per-file cap', async () => {
    const small = new ModuleIngestService(baseDir, {
      maxFileUncompressedBytes: 1024,
      maxTotalUncompressedBytes: 1024 * 1024,
    });
    const tgz = gzip(
      buildTar([
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/big.bin', data: Buffer.alloc(4096, 0x62) },
      ]),
    );
    await expect(small.ingest(tgz)).rejects.toThrow(/file too large|cap|exceed/i);
  });

  it('rejects when the file COUNT exceeds the cap', async () => {
    const small = new ModuleIngestService(baseDir, { maxEntries: 3 });
    const entries: TarEntry[] = [
      { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
    ];
    for (let i = 0; i < 10; i++) {
      entries.push({ name: `package/f${i}.txt`, data: Buffer.from('x') });
    }
    await expect(small.ingest(gzip(buildTar(entries)))).rejects.toThrow(/many entries|cap|exceed/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('rejects when the compressed tarball exceeds the cap (Buffer)', async () => {
    const small = new ModuleIngestService(baseDir, { maxCompressedBytes: 64 });
    await expect(small.ingest(validTgz())).rejects.toThrow(/too large|compressed|cap/i);
  });

  it('rejects when the compressed file on disk exceeds the cap (path)', async () => {
    const small = new ModuleIngestService(baseDir, { maxCompressedBytes: 64 });
    const tgzPath = path.join(baseDir, 'big.tgz');
    await fsp.writeFile(tgzPath, validTgz());
    await expect(small.ingest(tgzPath)).rejects.toThrow(/too large|compressed|cap/i);
  });

  it('rejects a header that DECLARES an oversized file (lying-size bomb guard)', async () => {
    const small = new ModuleIngestService(baseDir, { maxFileUncompressedBytes: 1024 });
    // declaredSize huge, but only a few real bytes follow — the header pre-check catches it.
    const tgz = gzip(
      buildTar([
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/lying.bin', data: Buffer.from('x'), declaredSize: 10_000_000 },
      ]),
    );
    await expect(small.ingest(tgz)).rejects.toThrow(/size cap|exceed|too large/i);
  });
});

describe('ModuleIngestService — no code execution', () => {
  it('never runs a package.json postinstall script', async () => {
    const marker = path.join(baseDir, 'PWNED_MARKER');
    const pkgJson = JSON.stringify({
      name: 'wishlist',
      version: '1.0.0',
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','x')"` },
    });
    const tgz = validTgz([{ name: 'package/package.json', data: Buffer.from(pkgJson) }]);
    const { manifest } = await svc.ingest(tgz);
    // The manifest is what matters and verifies fine...
    expect(manifest.name).toBe('wishlist');
    // ...and the postinstall NEVER ran — no marker, ever.
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('ModuleIngestService — manifest verification surfaces', () => {
  it('clear error when sovecom.module.json is missing', async () => {
    const tgz = gzip(
      buildTar([
        { name: 'package/', type: '5' },
        { name: 'package/index.js', data: Buffer.from('//') },
      ]),
    );
    await expect(svc.ingest(tgz)).rejects.toThrow(/manifest.*not found|not found.*manifest/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('rejects an oversized manifest (bounded read)', async () => {
    // > 64 KiB manifest. JSON-valid but blows the byte cap.
    const huge = manifestJson({ displayName: 'x'.repeat(70 * 1024) });
    const tgz = gzip(buildTar([{ name: `package/${MODULE_MANIFEST_FILENAME}`, data: huge }]));
    await expect(svc.ingest(tgz)).rejects.toThrow(/too large|cap|exceed/i);
  });

  it('surfaces the chunk-A invalid-manifest error', async () => {
    const bad = manifestJson({ name: 'BAD_UPPER' });
    const tgz = gzip(buildTar([{ name: `package/${MODULE_MANIFEST_FILENAME}`, data: bad }]));
    await expect(svc.ingest(tgz)).rejects.toThrow(/invalid module manifest|name/i);
    expect(await tempIngestDirs(baseDir)).toEqual([]);
  });

  it('surfaces the chunk-A incompatible-core error', async () => {
    const incompat = manifestJson({ compatibleCore: '^2.0.0' });
    const tgz = gzip(buildTar([{ name: `package/${MODULE_MANIFEST_FILENAME}`, data: incompat }]));
    await expect(svc.ingest(tgz)).rejects.toThrow(/compatible|major|version/i);
  });
});

describe('ModuleIngestService — cleanup on error', () => {
  it('cleans up the partial extraction dir on a mid-stream failure', async () => {
    const small = new ModuleIngestService(baseDir, { maxTotalUncompressedBytes: 512 });
    const tgz = gzip(
      buildTar([
        { name: `package/${MODULE_MANIFEST_FILENAME}`, data: manifestJson() },
        { name: 'package/a.bin', data: Buffer.alloc(2048, 0x63) },
      ]),
    );
    await expect(small.ingest(tgz)).rejects.toThrow();
    // No `.ingest-*` temp dir and no `wishlist` dir left behind.
    expect(await tempIngestDirs(baseDir)).toEqual([]);
    const remaining = await fsp.readdir(baseDir);
    expect(remaining).toEqual([]);
  });

  it('rejects a non-existent local tarball path with a clear error', async () => {
    await expect(svc.ingest(path.join(baseDir, 'nope.tgz'))).rejects.toThrow(/not found/i);
  });
});

describe('Z3 dead-code: inspectTarball must NOT be exported', () => {
  it('module-ingest.service does not export inspectTarball', () => {
    expect((moduleIngestModule as Record<string, unknown>)['inspectTarball']).toBeUndefined();
  });
});

describe('ModuleIngestService — config / root', () => {
  it('uses the overridden root (tests never touch /data/modules)', () => {
    expect(svc.root).toBe(path.resolve(baseDir));
  });

  it('reads MODULES_DATA_PATH from env when no override is given', () => {
    const prev = process.env['MODULES_DATA_PATH'];
    process.env['MODULES_DATA_PATH'] = '/tmp/sovecom-modules-test';
    try {
      const s = new ModuleIngestService();
      expect(s.root).toBe(path.resolve('/tmp/sovecom-modules-test'));
    } finally {
      if (prev === undefined) delete process.env['MODULES_DATA_PATH'];
      else process.env['MODULES_DATA_PATH'] = prev;
    }
  });
});
