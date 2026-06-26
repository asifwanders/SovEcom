/**
 * StorageController UNIT tests.
 *
 * Defense-in-depth against stored-XSS via served upload assets. Even with
 * the brand path now raster-only, ANY asset served inline from the app origin
 * is an XSS risk if a script-bearing file ever lands in storage. So `serveFile` MUST:
 *   - send `Content-Disposition: attachment` (browser downloads, never renders inline),
 *   - send a restrictive `Content-Security-Policy: sandbox` (a served document cannot
 *     execute script in the app origin).
 * These hold for an SVG specifically and for raster assets too.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import type { Response } from 'express';
import { StorageController } from './storage.controller';
import { LocalAdapter } from './adapters/local.adapter';
import type { StorageService } from './storage.service';

/**
 * A fake Express Response backed by a real Writable sink so `createReadStream().pipe(res)`
 * drains cleanly (no unhandled stream error vs. temp-dir cleanup). Captures headers/status;
 * `done` resolves when the piped stream finishes.
 */
function makeResponse(): {
  res: Response;
  headers: Record<string, string>;
  status: number[];
  done: Promise<void>;
} {
  const headers: Record<string, string> = {};
  const status: number[] = [];
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const done = new Promise<void>((resolve) => sink.on('finish', () => resolve()));
  const res = Object.assign(sink, {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status: (code: number) => {
      status.push(code);
      return res;
    },
    json: () => res,
  }) as unknown as Response;
  return { res, headers, status, done };
}

describe('StorageController.serveFile — inline-XSS hardening', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovecom-uploads-'));
    process.env['LOCAL_STORAGE_PATH'] = root;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env['LOCAL_STORAGE_PATH'];
  });

  function controller(): StorageController {
    const adapter = new LocalAdapter();
    return new StorageController(adapter, {} as unknown as StorageService);
  }

  function writeFile(key: string, contents: string): void {
    const full = path.join(root, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  it('serves an SVG with attachment disposition + sandbox CSP (never inline-executable)', async () => {
    writeFile(
      'brand/logo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const { res, headers, done } = makeResponse();
    controller().serveFile('brand/logo.svg', undefined, undefined, res);
    await done;

    expect(headers['Content-Disposition']).toMatch(/^attachment/);
    expect(headers['Content-Security-Policy']).toBe('sandbox');
  });

  it('serves a raster asset with the same hardening headers', async () => {
    writeFile('img/pic.png', 'not-a-real-png-but-bytes');
    const { res, headers, done } = makeResponse();
    controller().serveFile('img/pic.png', undefined, undefined, res);
    await done;

    expect(headers['Content-Disposition']).toMatch(/^attachment/);
    expect(headers['Content-Security-Policy']).toBe('sandbox');
    expect(headers['Content-Type']).toBe('image/png');
  });
});

describe('StorageController — signing-secret production guard', () => {
  const prevNodeEnv = process.env['NODE_ENV'];
  const prevSecret = process.env['STORAGE_SIGNING_SECRET'];

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prevNodeEnv;
    if (prevSecret === undefined) delete process.env['STORAGE_SIGNING_SECRET'];
    else process.env['STORAGE_SIGNING_SECRET'] = prevSecret;
  });

  it('throws at construction in production when STORAGE_SIGNING_SECRET is unset', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['STORAGE_SIGNING_SECRET'];
    // A non-LocalAdapter object so the controller (not the adapter) is the thrower.
    expect(() => new StorageController({}, {} as unknown as StorageService)).toThrow(
      /STORAGE_SIGNING_SECRET/,
    );
  });

  it('throws at construction in production when STORAGE_SIGNING_SECRET is the dev default', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['STORAGE_SIGNING_SECRET'] = 'dev-signing-secret';
    expect(() => new LocalAdapter()).toThrow(/STORAGE_SIGNING_SECRET/);
  });

  it('constructs fine in dev with no STORAGE_SIGNING_SECRET set', () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['STORAGE_SIGNING_SECRET'];
    expect(() => new LocalAdapter()).not.toThrow();
  });
});
