/**
 * the GENERALIZED hardened tarball extractor.
 *
 * This is the SECURITY-CRITICAL extraction core, hoisted VERBATIM out of `ModuleIngestService`
 * so the EXACT same audited guards extract BOTH module and
 * theme tarballs — one path, no duplicated security code. Nothing about the guards changed in
 * the move: it still drives node-tar's low-level `tar.Parser` by hand, enforces every cap
 * DURING extraction (aborting the parser the moment a cap trips, before a bomb fills disk),
 * writes files itself with `wx` exclusive creates, and executes NO code / `require()`s nothing.
 *
 * What is PARAMETERIZED (and ONLY this):
 *   - `destRoot` — the isolated per-call directory to extract into (the caller owns mkdtemp);
 *   - `limits`   — the byte / file-count caps;
 *   - `makeError(msg)` — the caller's typed error class (so modules keep throwing
 *     `ModuleIngestError` and themes throw `ThemeIngestError`; the guard messages are identical).
 *
 * Guards:
 *   1. Traversal / zip-slip: reject absolute paths, `..` segments, drive/UNC forms, NUL bytes;
 *      resolve every target and assert it stays under `destRoot`. First bad entry aborts.
 *   2. TYPE guard: only regular files + directories (reject symlink/hardlink/device/fifo).
 *   3. Size caps enforced mid-stream: compressed bytes, total uncompressed, per-file, file count
 *      — plus a HEADER pre-check that refuses a lying-size bomb before streaming a byte.
 *   4. `package/` strip: drop exactly one leading segment AFTER the traversal guard, then
 *      re-assert containment — the strip can never widen the escape surface.
 * On ANY error the caller removes the partial extraction dir (no orphaned files).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';

/**
 * Watchdog: how long the settle logic waits for a destroyed/ended WriteStream to emit its
 * `close` event before forcing the extraction promise to settle anyway. Node's stream
 * contract guarantees `close` (emitClose defaults true), so this NEVER fires in practice — it
 * exists purely so a pathological fd that never closes can't hang an ingest request forever
 * (DoS defence-in-depth on a security-critical endpoint).
 */
const CLOSE_WATCHDOG_MS = 10_000;

/**
 * Watchdog: hard ceiling on the WHOLE extraction. If the tar `Parser` somehow neither emits
 * `end` nor `error` (a malformed stream that stalls without tripping a byte cap), the
 * extraction promise would otherwise never settle and hang the admin request. Generous —
 * a legitimate ≤32 MiB archive extracts in well under a second — purely a DoS backstop.
 */
const EXTRACT_WATCHDOG_MS = 30_000;

/**
 * Ingestion caps. Generous for real archives, hard ceilings against bombs.
 * All are enforced DURING extraction.
 */
export interface GuardedTarLimits {
  /** Max compressed `.tgz` bytes. */
  readonly maxCompressedBytes: number;
  /** Max TOTAL uncompressed bytes across all entries. */
  readonly maxTotalUncompressedBytes: number;
  /** Max uncompressed bytes for any SINGLE file. */
  readonly maxFileUncompressedBytes: number;
  /** Max number of entries (files + dirs). */
  readonly maxEntries: number;
}

export const DEFAULT_GUARDED_TAR_LIMITS: GuardedTarLimits = {
  maxCompressedBytes: 8 * 1024 * 1024, // 8 MiB
  maxTotalUncompressedBytes: 32 * 1024 * 1024, // 32 MiB
  maxFileUncompressedBytes: 8 * 1024 * 1024, // 8 MiB
  maxEntries: 2000,
};

/** Factory for the caller's typed extraction error (ModuleIngestError / ThemeIngestError). */
export type GuardedTarErrorFactory = (message: string) => Error;

/**
 * The reusable, hardened tarball extractor. Stateless across calls — every {@link extract} runs
 * against a caller-supplied isolated `destRoot`. The caller is responsible for creating the
 * `destRoot` (an unpredictable mkdtemp), capping the compressed size up front, and cleaning up
 * `destRoot` on failure.
 */
export class GuardedTarExtractor {
  private readonly limits: GuardedTarLimits;
  private readonly makeError: GuardedTarErrorFactory;

  constructor(makeError: GuardedTarErrorFactory, limits?: Partial<GuardedTarLimits>) {
    this.makeError = makeError;
    this.limits = { ...DEFAULT_GUARDED_TAR_LIMITS, ...limits };
  }

  /** The configured caps (absolute). */
  get caps(): GuardedTarLimits {
    return this.limits;
  }

  /**
   * Drive node-tar's `Parser` (an EventEmitter that gunzips internally) by hand, validating
   * + writing each entry ourselves. The caps are checked as bytes arrive; tripping one aborts
   * the parser so a bomb cannot inflate to disk. We write files ourselves (never `tar.x`'s
   * auto-unpack) so the path + type guards are the ONLY thing that ever creates a file.
   *
   * Control flow: `fail(msg)` latches `aborted`, tears down open file handles, aborts the
   * parser, and rejects. Every entry handler bails early once aborted (draining the entry so
   * the parser doesn't stall). Success resolves only after all file handles have flushed.
   */
  async extract(tarball: Buffer | string, destRoot: string): Promise<void> {
    const limits = this.limits;
    const makeError = this.makeError;
    let entryCount = 0;
    let totalBytes = 0;
    let compressedBytes = 0;

    // Compressed bytes: for a Buffer we already capped its length; for a path we stream it so
    // we can abort mid-read before the whole file is even gunzipped.
    const compressedChunks: AsyncIterable<Buffer> | Buffer = Buffer.isBuffer(tarball)
      ? tarball
      : fs.createReadStream(tarball);

    await new Promise<void>((resolve, reject) => {
      let aborted = false;
      let settled = false;
      const open = new Set<fs.WriteStream>();

      // node-tar v7's `Parser` is an EventEmitter (NOT a Minipass): no `destroy`/`resume` —
      // it exposes `abort(err)` and auto-detects+gunzips the gzip magic. `strict` surfaces
      // header warnings as errors.
      const parser = new tar.Parser({ strict: true });

      // Wait until every open WriteStream's fd has ACTUALLY closed, then run `after` exactly
      // once. We wait for `close` (the fd is released) — NOT `writableFinished`/`destroyed`,
      // which only mean the data flushed while the fd close is still pending. Both settle
      // paths (success + failure) go through here so the caller's `rmrf`/`rename` can never
      // race a late fd flush that re-creates a partial file (an orphaned `.ingest-*` dir).
      // A watchdog forces progress if a stream somehow never emits `close` (never observed —
      // Node guarantees it — but a security endpoint must not hang). `optDestroy` tears the
      // streams down first (the failure path); the success path lets ended streams close.
      const closeAllThen = (after: () => void, optDestroy: boolean): void => {
        const pending = [...open];
        open.clear();
        if (pending.length === 0) {
          after();
          return;
        }
        let remaining = pending.length;
        let fired = false;
        const run = (): void => {
          if (fired) return;
          fired = true;
          clearTimeout(watchdog);
          after();
        };
        const tick = (): void => {
          if (--remaining === 0) run();
        };
        const watchdog = setTimeout(run, CLOSE_WATCHDOG_MS);
        if (typeof watchdog.unref === 'function') watchdog.unref();
        for (const w of pending) {
          if (w.closed) {
            tick();
          } else {
            w.once('close', tick);
            if (optDestroy && !w.destroyed) w.destroy();
          }
        }
      };

      // Overall extraction watchdog (cleared on first settle). Guards against a parser that
      // stalls without ever emitting `end`/`error` — see EXTRACT_WATCHDOG_MS. Held on a const
      // object so the settle closures (defined first) can clear the timer (assigned below).
      const wd: { overall?: ReturnType<typeof setTimeout> } = {};

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (wd.overall) clearTimeout(wd.overall);
        resolve();
      };

      const fail = (message: string): void => {
        if (settled || aborted) return;
        aborted = true;
        const err = makeError(message);
        try {
          parser.abort(err);
        } catch {
          /* parser may already be torn down */
        }
        // Destroy in-flight writes and reject ONLY after every fd has fully closed.
        closeAllThen(() => {
          if (settled) return;
          settled = true;
          if (wd.overall) clearTimeout(wd.overall);
          reject(err);
        }, true);
      };

      wd.overall = setTimeout(() => fail('archive extraction timed out'), EXTRACT_WATCHDOG_MS);
      if (typeof wd.overall.unref === 'function') wd.overall.unref();

      parser.on('entry', (entry: tar.ReadEntry) => {
        if (aborted) {
          entry.resume();
          return;
        }

        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          entry.resume();
          fail(`too many entries: exceeded the ${limits.maxEntries}-entry cap`);
          return;
        }

        // ── HEADER-size pre-check: refuse before streaming a byte when the declared size
        // already blows the per-file or total cap (cheap early bomb guard; the byte-level
        // checks below remain authoritative for headers that lie). ──
        if (
          entry.size > limits.maxFileUncompressedBytes ||
          totalBytes + entry.size > limits.maxTotalUncompressedBytes
        ) {
          entry.resume();
          fail(`entry "${entry.path}" declares ${entry.size} bytes, exceeding a size cap`);
          return;
        }

        // ── TYPE guard: only regular files and directories. Reject symlinks, hardlinks,
        // char/block devices, fifos, and anything exotic. ──
        const type = entry.type;
        if (type !== 'File' && type !== 'Directory') {
          entry.resume();
          fail(`disallowed tar entry type "${type}" for "${entry.path}" (only File/Directory)`);
          return;
        }
        // node-tar surfaces hard/symlinks via `linkpath`; refuse defensively even if the
        // type ever slips through.
        if (entry.linkpath) {
          entry.resume();
          fail(`disallowed link entry "${entry.path}" -> "${entry.linkpath}"`);
          return;
        }

        // ── PATH guard + package/ strip ──
        const safeRel = GuardedTarExtractor.toSafeRelative(String(entry.path));
        if (safeRel === null) {
          entry.resume();
          fail(`unsafe tar entry path rejected: "${entry.path}"`);
          return;
        }
        // Drop the package root itself (an empty path after the strip).
        if (safeRel === '') {
          entry.resume();
          return;
        }

        const target = path.resolve(destRoot, safeRel);
        // Final containment assertion — the resolved path MUST stay under destRoot.
        if (!GuardedTarExtractor.isContained(destRoot, target)) {
          entry.resume();
          fail(`zip-slip rejected: "${entry.path}" resolves outside the extraction root`);
          return;
        }

        if (type === 'Directory') {
          fs.mkdirSync(target, { recursive: true, mode: 0o700 });
          entry.resume();
          return;
        }

        // Regular file: ensure its parent exists, then stream bytes with per-file + total
        // caps enforced as they arrive. Dirs `0o700` to match the `0o600` files (owner-only).
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        // `wx` — exclusive create. A duplicate entry targeting an existing path is refused
        // (no overwrite-based smuggling).
        let out: fs.WriteStream;
        try {
          out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
        } catch (e) {
          entry.resume();
          fail(`failed to create "${entry.path}": ${(e as Error).message}`);
          return;
        }
        open.add(out);
        out.on('error', (e: Error) => fail(`write error for "${entry.path}": ${e.message}`));
        let fileBytes = 0;

        entry.on('data', (chunk: Buffer) => {
          if (aborted) return;
          fileBytes += chunk.length;
          totalBytes += chunk.length;
          if (fileBytes > limits.maxFileUncompressedBytes) {
            fail(
              `file too large: "${entry.path}" exceeded the per-file ` +
                `${limits.maxFileUncompressedBytes}-byte cap`,
            );
            return;
          }
          if (totalBytes > limits.maxTotalUncompressedBytes) {
            fail(
              `tarball expands too large: exceeded the total ` +
                `${limits.maxTotalUncompressedBytes}-byte uncompressed cap`,
            );
            return;
          }
          out.write(chunk);
        });
        entry.on('end', () => {
          if (!aborted) out.end();
        });
      });

      parser.on('error', (e: Error) => {
        // `abort()` re-emits our own typed error; don't double-wrap it. Once we've called
        // `fail()` (which sets `aborted` BEFORE `parser.abort`), this returns early — so the
        // re-emit of our own error never reaches the wrapping branch. A raw parser error
        // (malformed/non-gzip stream) is wrapped as a clear `tar parse error`.
        if (aborted) return;
        fail(`tar parse error: ${e.message}`);
      });

      parser.on('end', () => {
        if (aborted || settled) return;
        // Resolve only after every open file handle has flushed AND closed (the streams were
        // `end()`-ed in each entry's 'end' handler; here we wait for the fd to actually close
        // so a follow-on inspect-mode `rmrf` / install-mode `rename` never races a late flush).
        closeAllThen(finish, false);
      });

      // Feed the (compressed) bytes into the parser, counting compressed bytes as we go so a
      // huge .tgz on disk aborts mid-read rather than after a full gunzip.
      const feed = async (): Promise<void> => {
        if (Buffer.isBuffer(compressedChunks)) {
          parser.write(compressedChunks);
          parser.end();
          return;
        }
        for await (const chunk of compressedChunks) {
          if (aborted) return;
          compressedBytes += chunk.length;
          if (compressedBytes > limits.maxCompressedBytes) {
            fail(
              `tarball too large: compressed bytes exceeded the ` +
                `${limits.maxCompressedBytes}-byte cap`,
            );
            return;
          }
          parser.write(chunk);
        }
        if (!aborted) parser.end();
      };
      feed().catch((e: Error) => fail(`tarball read error: ${e.message}`));
    });
  }

  /**
   * Normalise a raw tar entry path to a SAFE relative path under the dest root, applying the
   * npm `package/` strip. Returns `null` for anything unsafe (absolute, traversal, drive/UNC,
   * NUL byte). Returns `''` when the entry IS the stripped root dir (caller skips it).
   *
   * The strip removes exactly ONE leading segment AFTER the raw path is confirmed relative
   * and `..`-free, so it cannot be used to climb out of the root.
   */
  static toSafeRelative(rawPath: string): string | null {
    if (rawPath.length === 0) return null;
    // Reject embedded NUL (path-truncation tricks).
    if (rawPath.includes('\0')) return null;
    // Normalise separators; tar uses POSIX `/` but be defensive about `\`.
    const unified = rawPath.replace(/\\/g, '/');

    // Reject absolute (POSIX `/...`) and Windows drive (`C:`) / UNC (`//host`) forms.
    if (unified.startsWith('/')) return null;
    if (/^[a-zA-Z]:/.test(unified)) return null;

    const segments = unified.split('/').filter((s) => s.length > 0 && s !== '.');
    // Any `..` anywhere is a hard reject — never normalise it away.
    if (segments.some((s) => s === '..')) return null;
    if (segments.length === 0) return null;

    // npm `package/` strip: drop exactly the FIRST segment. The remaining segments are
    // already `..`-free and relative, so the stripped path is still confined.
    const stripped = segments.slice(1);
    if (stripped.length === 0) return ''; // the `package/` root entry itself

    // Re-assert no `..` survived (defensive; slice can't introduce one).
    if (stripped.some((s) => s === '..')) return null;
    return stripped.join(path.sep);
  }

  /** True iff `child` is the root itself or strictly nested under it. */
  static isContained(root: string, child: string): boolean {
    const r = path.resolve(root);
    const c = path.resolve(child);
    return c === r || c.startsWith(r + path.sep);
  }
}
