/**
 * unit tests for the RGPD helpers (export / erase / saveJson / filename).
 *
 * Verifies that:
 *   - exportData/eraseAccount call client.request with the exact method + path and the password in the
 *     BODY (never embedded in the path/URL);
 *   - saveJson builds a pretty-printed application/json blob, fires an anchor download, and revokes the
 *     object URL afterwards (the saveBlob pattern);
 *   - exportFilename produces the dated `sovecom-data-export-YYYY-MM-DD.json` name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportData, eraseAccount, saveJson, exportFilename } from './rgpd';
import type { RgpdExport } from './rgpd';
import type { SovEcomClient } from '@sovecom/client-js';

let mockRequest: ReturnType<typeof vi.fn>;
let client: SovEcomClient;

const SAMPLE_EXPORT: RgpdExport = {
  exportedAt: '2026-06-19T00:00:00.000Z',
  profile: { id: 'c1', email: 'ada@example.com' },
  addresses: [],
  orders: [],
  invoices: [],
  emailLogs: [],
};

beforeEach(() => {
  mockRequest = vi.fn();
  client = { request: mockRequest } as unknown as SovEcomClient;
});

describe('exportData', () => {
  it('POSTs /rgpd/export with the password in the BODY (not the URL)', async () => {
    mockRequest.mockResolvedValue(SAMPLE_EXPORT);
    const result = await exportData(client, 's3cret');
    expect(mockRequest).toHaveBeenCalledWith(
      'post',
      '/store/v1/customers/me/rgpd/export',
      expect.objectContaining({ body: { password: 's3cret' } }),
    );
    // path must not carry the password
    const [, path] = mockRequest.mock.calls[0] as [string, string, unknown];
    expect(path).not.toContain('s3cret');
    expect(result).toBe(SAMPLE_EXPORT);
  });
});

describe('eraseAccount', () => {
  it('POSTs /rgpd/erase with the password in the BODY and returns void', async () => {
    mockRequest.mockResolvedValue(undefined);
    const result = await eraseAccount(client, 'p@ss');
    expect(mockRequest).toHaveBeenCalledWith(
      'post',
      '/store/v1/customers/me/rgpd/erase',
      expect.objectContaining({ body: { password: 'p@ss' } }),
    );
    const [, path] = mockRequest.mock.calls[0] as [string, string, unknown];
    expect(path).not.toContain('p@ss');
    expect(result).toBeUndefined();
  });
});

describe('exportFilename', () => {
  it('builds the dated filename in UTC', () => {
    const d = new Date('2026-06-19T23:30:00.000Z');
    expect(exportFilename(d)).toBe('sovecom-data-export-2026-06-19.json');
  });

  it('zero-pads month and day', () => {
    const d = new Date('2026-01-05T00:00:00.000Z');
    expect(exportFilename(d)).toBe('sovecom-data-export-2026-01-05.json');
  });
});

describe('saveJson', () => {
  let createdUrl: string;
  let revokedUrl: string | undefined;
  let blobArg: Blob | undefined;
  let anchorDownload: string | undefined;
  let anchorHref: string | undefined;
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createdUrl = 'blob:mock-json';
    revokedUrl = undefined;
    blobArg = undefined;
    anchorDownload = undefined;
    anchorHref = undefined;

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((b: Blob) => {
        blobArg = b;
        return createdUrl;
      }),
      revokeObjectURL: vi.fn((u: string) => {
        revokedUrl = u;
      }),
    });

    clickSpy = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === 'a') {
        const a = el as HTMLAnchorElement;
        Object.defineProperty(a, 'click', { value: clickSpy, writable: true });
        let dl = '';
        Object.defineProperty(a, 'download', {
          get: () => dl,
          set: (v: string) => {
            dl = v;
            anchorDownload = v;
          },
          configurable: true,
        });
        let hrefVal = '';
        Object.defineProperty(a, 'href', {
          get: () => hrefVal,
          set: (v: string) => {
            hrefVal = v;
            anchorHref = v;
          },
          configurable: true,
        });
      }
      return el;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a pretty-printed application/json blob and downloads it under the filename', async () => {
    saveJson({ a: 1 }, 'sovecom-data-export-2026-06-19.json');

    expect(blobArg?.type).toBe('application/json');
    const text = await blobArg!.text();
    // pretty-printed (2-space indent)
    expect(text).toBe('{\n  "a": 1\n}');

    expect(anchorHref).toBe('blob:mock-json');
    expect(anchorDownload).toBe('sovecom-data-export-2026-06-19.json');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // object URL revoked after the click
    expect(revokedUrl).toBe('blob:mock-json');
  });
});
