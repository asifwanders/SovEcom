/**
 * GuardedTarExtractor unit tests.
 *
 * The shared, security-critical extraction core was, until now, only exercised INDIRECTLY through
 * `module-ingest.spec.ts`. This spec drives `GuardedTarExtractor` DIRECTLY against a caller-supplied
 * `destRoot`, so the guards are pinned independent of any one consumer (modules / themes) and the
 * pure static helpers (`toSafeRelative` / `isContained`) get exhaustive table-style coverage that an
 * end-to-end ingest test cannot reach (e.g. NUL bytes and the sibling-prefix containment case).
 *
 * Like the module spec, we hand-roll a tiny USTAR writer so we can forge entries node-tar's packer
 * would refuse to produce: `..` segments, absolute / drive / UNC paths, lying sizes, and the full
 * spread of non-file/dir typeflags (symlink `2`, hardlink `1`, char-device `3`, block-device `4`,
 * fifo `6`). Every malicious case must reject WITHOUT writing anything outside `destRoot` and WITHOUT
 * executing any code.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { GuardedTarExtractor } from './guarded-tar';

// ── minimal USTAR tar writer ───────────────────────────────────────────────────
// Just enough of the tar format to forge arbitrary entries. typeflag: '0' file,
// '5' dir, '2' symlink, '1' hardlink, '3' char-device, '4' block-device, '6' fifo.
// Each block is 512 bytes; the archive ends with two zero blocks.

const BLOCK = 512;

interface TarEntry {
  name: string;
  type?: '0' | '5' | '2' | '1' | '3' | '4' | '6';
  data?: Buffer;
  /** Override the declared size in the header (to forge a "lying" size). */
  declaredSize?: number;
  linkname?: string;
}

/** Types that carry no data body (dirs, links, devices, fifos). */
const BODYLESS = new Set(['5', '2', '1', '3', '4', '6']);

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
    if (e.type && BODYLESS.has(e.type)) continue;
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

/** A standard npm-style tarball: everything under `package/`. */
function validTgz(extra: TarEntry[] = []): Buffer {
  return gzip(
    buildTar([
      { name: 'package/', type: '5' },
      { name: 'package/index.js', data: Buffer.from('module.exports = {};\n') },
      ...extra,
    ]),
  );
}

// ── harness ────────────────────────────────────────────────────────────────────

/** The caller's typed error — asserts the `makeError` factory is actually used. */
class TestIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestIngestError';
  }
}
const makeError = (m: string): Error => new TestIngestError(m);

let baseTmp: string;
let destRoot: string;
let extractor: GuardedTarExtractor;

beforeEach(async () => {
  baseTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtar-'));
  destRoot = path.join(baseTmp, 'dest');
  await fsp.mkdir(destRoot, { recursive: true });
  extractor = new GuardedTarExtractor(makeError);
});

afterEach(async () => {
  await fsp.rm(baseTmp, { recursive: true, force: true });
});

/** All files (relative paths) currently present under `root`. */
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
  return out.sort();
}

// ── static helper: toSafeRelative ───────────────────────────────────────────────

describe('GuardedTarExtractor.toSafeRelative — package/ strip + path safety', () => {
  it('strips exactly one leading segment (the npm package/ root)', () => {
    expect(GuardedTarExtractor.toSafeRelative('package/index.js')).toBe('index.js');
    expect(GuardedTarExtractor.toSafeRelative('package/a/b.js')).toBe(path.join('a', 'b.js'));
  });

  it('collapses `.` segments but keeps real nesting', () => {
    expect(GuardedTarExtractor.toSafeRelative('package/./a/./b')).toBe(path.join('a', 'b'));
  });

  it('returns "" for a single-segment entry (the stripped package root itself)', () => {
    // Both the bare `package` file entry and the `package/` dir entry strip to nothing — the
    // caller skips a '' result rather than writing a file named ''.
    expect(GuardedTarExtractor.toSafeRelative('package')).toBe('');
    expect(GuardedTarExtractor.toSafeRelative('package/')).toBe('');
  });

  it('returns null for an empty path', () => {
    expect(GuardedTarExtractor.toSafeRelative('')).toBeNull();
  });

  it('rejects a `..` segment anywhere (never normalised away)', () => {
    expect(GuardedTarExtractor.toSafeRelative('package/../evil')).toBeNull();
    expect(GuardedTarExtractor.toSafeRelative('package/a/../../evil')).toBeNull();
    expect(GuardedTarExtractor.toSafeRelative('..')).toBeNull();
  });

  it('rejects absolute POSIX paths', () => {
    expect(GuardedTarExtractor.toSafeRelative('/etc/passwd')).toBeNull();
  });

  it('rejects Windows drive paths (C:\\...)', () => {
    expect(GuardedTarExtractor.toSafeRelative('C:\\Windows\\system32')).toBeNull();
    expect(GuardedTarExtractor.toSafeRelative('c:/windows')).toBeNull();
  });

  it('rejects UNC paths (//host and backslash \\\\host forms)', () => {
    expect(GuardedTarExtractor.toSafeRelative('//host/share/x')).toBeNull();
    expect(GuardedTarExtractor.toSafeRelative('\\\\host\\share\\x')).toBeNull();
  });

  it('rejects an embedded NUL byte (path-truncation trick)', () => {
    expect(GuardedTarExtractor.toSafeRelative('package/a\0b')).toBeNull();
    expect(GuardedTarExtractor.toSafeRelative('package/safe.js\0/../../etc/passwd')).toBeNull();
  });

  it('does NOT collapse a `....//` dotted run into a traversal', () => {
    // The classic naive-normaliser bug turns `....//` into `../`. Here `....` is NOT `..`, so it
    // is a LITERAL segment: the result stays relative + contained, never escaping upward.
    const rel = GuardedTarExtractor.toSafeRelative('package/....//evil.txt');
    expect(rel).not.toBeNull();
    expect(rel!.split(path.sep)).not.toContain('..');
    expect(GuardedTarExtractor.isContained('/root', path.resolve('/root', rel!))).toBe(true);
  });
});

// ── static helper: isContained ──────────────────────────────────────────────────

describe('GuardedTarExtractor.isContained', () => {
  it('accepts the root itself and strictly nested children', () => {
    expect(GuardedTarExtractor.isContained('/a/modules', '/a/modules')).toBe(true);
    expect(GuardedTarExtractor.isContained('/a/modules', '/a/modules/x')).toBe(true);
    expect(GuardedTarExtractor.isContained('/a/modules', '/a/modules/x/y.txt')).toBe(true);
  });

  it('rejects a SIBLING with a shared name prefix (the prefix-string pitfall)', () => {
    // `'/a/modules-evil'.startsWith('/a/modules')` is true as a raw string — the guard MUST add the
    // separator so a sibling directory cannot masquerade as a child.
    expect(GuardedTarExtractor.isContained('/a/modules', '/a/modules-evil')).toBe(false);
    expect(GuardedTarExtractor.isContained('/a/modules', '/a/modules-evil/secret')).toBe(false);
  });

  it('rejects a parent / outside path', () => {
    expect(GuardedTarExtractor.isContained('/a/modules', '/a')).toBe(false);
    expect(GuardedTarExtractor.isContained('/a/modules', '/etc/passwd')).toBe(false);
  });

  it('resolves `..` in the child before comparing', () => {
    expect(GuardedTarExtractor.isContained('/a/modules', '/a/modules/sub/../ok')).toBe(true);
    expect(GuardedTarExtractor.isContained('/a/modules', '/a/modules/../escape')).toBe(false);
  });
});

// ── extract: happy path ─────────────────────────────────────────────────────────

describe('GuardedTarExtractor.extract — happy path', () => {
  it('extracts a valid tarball with the package/ prefix stripped, all under destRoot', async () => {
    await extractor.extract(
      validTgz([
        { name: 'package/readme.txt', data: Buffer.from('hi') },
        { name: 'package/sub/', type: '5' },
        { name: 'package/sub/nested.txt', data: Buffer.from('deep') },
      ]),
      destRoot,
    );
    const files = await listFiles(destRoot);
    expect(files).toEqual([path.join('sub', 'nested.txt'), 'index.js', 'readme.txt'].sort());
    expect(fs.readFileSync(path.join(destRoot, 'index.js'), 'utf8')).toContain('module.exports');
    // Every written path stays strictly under destRoot.
    for (const rel of files) {
      expect(path.resolve(destRoot, rel).startsWith(destRoot + path.sep)).toBe(true);
    }
  });

  it('accepts a local file path (the streaming branch) as well as a Buffer', async () => {
    const tgzPath = path.join(baseTmp, 'src.tgz');
    await fsp.writeFile(tgzPath, validTgz());
    await extractor.extract(tgzPath, destRoot);
    expect(fs.existsSync(path.join(destRoot, 'index.js'))).toBe(true);
  });

  it('skips single-segment entries that strip to "" and writes only the real file', async () => {
    // A bare `package` file entry and the `package/` dir entry both strip to '' and are skipped;
    // only the genuinely-nested file is written. No file named '' or 'package' appears.
    await extractor.extract(
      gzip(
        buildTar([
          { name: 'package', type: '0', data: Buffer.from('ROOT-FILE-SHOULD-BE-SKIPPED') },
          { name: 'package/', type: '5' },
          { name: 'package/real.txt', data: Buffer.from('kept') },
        ]),
      ),
      destRoot,
    );
    expect(await listFiles(destRoot)).toEqual(['real.txt']);
    expect(fs.readFileSync(path.join(destRoot, 'real.txt'), 'utf8')).toBe('kept');
  });
});

// ── extract: zip-slip / traversal ───────────────────────────────────────────────

describe('GuardedTarExtractor.extract — zip-slip / traversal', () => {
  /** Resolve a name that should NEVER exist after a rejected extraction. */
  const outside = (rel: string): string => path.join(baseTmp, rel);

  it('rejects a `../../evil.txt` entry and writes nothing outside destRoot', async () => {
    const tgz = gzip(
      buildTar([
        { name: 'package/', type: '5' },
        { name: 'package/../../evil.txt', data: Buffer.from('pwned') },
      ]),
    );
    await expect(extractor.extract(tgz, destRoot)).rejects.toThrow(TestIngestError);
    expect(fs.existsSync(outside('evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(baseTmp), 'evil.txt'))).toBe(false);
  });

  it('rejects an absolute `/etc/...`-style entry', async () => {
    const tgz = gzip(buildTar([{ name: '/etc/sovecom-gtar-evil', data: Buffer.from('x') }]));
    await expect(extractor.extract(tgz, destRoot)).rejects.toThrow(/unsafe|outside|zip-slip/i);
    expect(fs.existsSync('/etc/sovecom-gtar-evil')).toBe(false);
  });

  it('rejects a `..` that only appears AFTER the package/ strip', async () => {
    // `package/../evil` -> strip would leave `../evil`; the guard rejects the raw `..` first.
    const tgz = gzip(buildTar([{ name: 'package/../evil', data: Buffer.from('x') }]));
    await expect(extractor.extract(tgz, destRoot)).rejects.toThrow(TestIngestError);
    expect(fs.existsSync(outside('evil'))).toBe(false);
  });
});

// ── extract: type guard (symlink / hardlink / device / fifo) ─────────────────────

describe('GuardedTarExtractor.extract — type guard', () => {
  const cases: Array<{ label: string; type: TarEntry['type']; linkname?: string }> = [
    { label: 'symlink', type: '2', linkname: '/etc/passwd' },
    { label: 'hardlink', type: '1', linkname: 'package/index.js' },
    { label: 'char device', type: '3' },
    { label: 'block device', type: '4' },
    { label: 'fifo', type: '6' },
  ];

  for (const c of cases) {
    it(`rejects a ${c.label} entry and writes nothing`, async () => {
      const tgz = gzip(
        buildTar([
          {
            name: `package/evil-${c.label.replace(/\s/g, '-')}`,
            type: c.type,
            linkname: c.linkname,
          },
        ]),
      );
      await expect(extractor.extract(tgz, destRoot)).rejects.toThrow(TestIngestError);
      // The disallowed entry never produced a file (and no symlink escaped the root).
      expect(await listFiles(destRoot)).toEqual([]);
    });
  }
});

// ── extract: size + count caps ───────────────────────────────────────────────────

describe('GuardedTarExtractor.extract — caps', () => {
  it('rejects when TOTAL uncompressed exceeds the cap', async () => {
    const small = new GuardedTarExtractor(makeError, { maxTotalUncompressedBytes: 1024 });
    const tgz = gzip(buildTar([{ name: 'package/big.bin', data: Buffer.alloc(4096, 0x61) }]));
    await expect(small.extract(tgz, destRoot)).rejects.toThrow(/too large|cap|exceed|size/i);
  });

  it('rejects when a SINGLE file exceeds the per-file cap', async () => {
    const small = new GuardedTarExtractor(makeError, {
      maxFileUncompressedBytes: 1024,
      maxTotalUncompressedBytes: 1024 * 1024,
    });
    const tgz = gzip(buildTar([{ name: 'package/big.bin', data: Buffer.alloc(4096, 0x62) }]));
    await expect(small.extract(tgz, destRoot)).rejects.toThrow(/too large|cap|exceed|size/i);
  });

  it('rejects when the entry COUNT exceeds the cap (enforced as entries arrive)', async () => {
    const small = new GuardedTarExtractor(makeError, { maxEntries: 3 });
    const entries: TarEntry[] = [];
    for (let i = 0; i < 10; i++)
      entries.push({ name: `package/f${i}.txt`, data: Buffer.from('x') });
    await expect(small.extract(gzip(buildTar(entries)), destRoot)).rejects.toThrow(
      /many entries|cap|exceed/i,
    );
  });

  it('rejects a header that DECLARES an oversized file before streaming a byte (lying-size bomb)', async () => {
    const small = new GuardedTarExtractor(makeError, { maxFileUncompressedBytes: 1024 });
    // declaredSize huge, but only a few real bytes follow — the header pre-check catches it.
    const tgz = gzip(
      buildTar([{ name: 'package/lying.bin', data: Buffer.from('x'), declaredSize: 10_000_000 }]),
    );
    await expect(small.extract(tgz, destRoot)).rejects.toThrow(/size cap|exceed|too large/i);
  });

  it('aborts a compressed stream mid-read when it exceeds maxCompressedBytes (path branch)', async () => {
    // The compressed-byte cap is enforced ONLY on the streaming (path) branch — a Buffer caller
    // is expected to have capped length up front. We feed an over-cap .tgz from disk.
    const small = new GuardedTarExtractor(makeError, { maxCompressedBytes: 64 });
    const tgzPath = path.join(baseTmp, 'big.tgz');
    await fsp.writeFile(
      tgzPath,
      validTgz([{ name: 'package/pad.bin', data: Buffer.alloc(4096, 0x63) }]),
    );
    await expect(small.extract(tgzPath, destRoot)).rejects.toThrow(/compressed|too large|cap/i);
  });
});

// ── extract: wx duplicate + file/dir collisions ──────────────────────────────────

describe('GuardedTarExtractor.extract — exclusive create + collisions', () => {
  it('rejects a duplicate path (wx exclusive create refuses overwrite-based smuggling)', async () => {
    const tgz = gzip(
      buildTar([
        { name: 'package/dup.txt', data: Buffer.from('first') },
        { name: 'package/dup.txt', data: Buffer.from('second-overwrite-attempt') },
      ]),
    );
    await expect(extractor.extract(tgz, destRoot)).rejects.toThrow(TestIngestError);
  });

  it('rejects a file entry colliding with an already-created directory', async () => {
    // `package/x/` makes `x` a dir; then `package/x` as a file collides — the exclusive create
    // (on an existing directory path) fails rather than clobbering the tree.
    const tgz = gzip(
      buildTar([
        { name: 'package/x/', type: '5' },
        { name: 'package/x/inside.txt', data: Buffer.from('child') },
        { name: 'package/x', type: '0', data: Buffer.from('collide') },
      ]),
    );
    await expect(extractor.extract(tgz, destRoot)).rejects.toThrow(TestIngestError);
  });
});

// ── extract: error factory wiring ────────────────────────────────────────────────

describe('GuardedTarExtractor.extract — error factory', () => {
  it('rejects with the caller-supplied error type', async () => {
    const tgz = gzip(buildTar([{ name: 'package/../../escape', data: Buffer.from('x') }]));
    await expect(extractor.extract(tgz, destRoot)).rejects.toBeInstanceOf(TestIngestError);
  });
});
