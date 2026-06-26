/**
 * RgpdExport tests. SECURITY-CRITICAL (PII export + password step-up).
 *
 * Proven here:
 *   - submit with the password → POST export called with { password } in the BODY (never the URL);
 *   - on success a JSON blob is built and an anchor download fires with the dated filename;
 *   - the raw export JSON is NEVER rendered to the DOM (it is PII);
 *   - the password field is cleared after the request (success or error), and never logged;
 *   - 401 → refresh() ONCE → retry ONCE → still 401 → the single "password incorrect / too many
 *     attempts" message (no infinite loop, no oracle); refresh() throwing → same message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// --- Auth mock ---
let getAccessToken: () => string | null = () => 'token-abc';
let refresh: () => Promise<string | null> = async () => 'token-abc';
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ getAccessToken, refresh }),
}));

// --- Browser client mock ---
let mockRequest: (method: string, path: string, opts?: unknown) => Promise<unknown>;
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({
    request: (...args: unknown[]) => mockRequest(...(args as [string, string, unknown])),
  }),
}));

import { RgpdExport } from './RgpdExport';

const SAMPLE_EXPORT = {
  exportedAt: '2026-06-19T00:00:00.000Z',
  profile: { id: 'c1', email: 'ada@example.com', name: 'Ada Lovelace' },
  addresses: [{ id: 'a1', line1: '123 Secret Street' }],
  orders: [],
  invoices: [],
  emailLogs: [],
};

// --- download stubs (jsdom lacks blob URL + anchor click) ---
let createdUrl: string;
let revokedUrl: string | undefined;
let anchorDownload: string | undefined;
let clickSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getAccessToken = () => 'token-abc';
  refresh = async () => 'token-abc';
  createdUrl = 'blob:mock-url';
  revokedUrl = undefined;
  anchorDownload = undefined;

  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => createdUrl),
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
    }
    return el;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function unauthorized(): Error {
  return Object.assign(new Error('Unauthorized'), { status: 401 });
}

function submitWithPassword(password: string): void {
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /export my data/i }));
}

describe('RgpdExport — happy path', () => {
  it('POSTs the password in the BODY and downloads a dated JSON file', async () => {
    const calls: Array<[string, string, unknown]> = [];
    mockRequest = async (method, path, opts) => {
      calls.push([method, path, opts]);
      return SAMPLE_EXPORT;
    };

    renderWithIntl(<RgpdExport />, 'en');
    submitWithPassword('hunter2');

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());

    // exactly one POST to the export endpoint with the password in the BODY (not the path/URL)
    expect(calls).toHaveLength(1);
    const [method, path, opts] = calls[0]!;
    expect(method).toBe('post');
    expect(path).toBe('/store/v1/customers/me/rgpd/export');
    expect((opts as { body: { password: string } }).body).toEqual({ password: 'hunter2' });
    expect(path).not.toContain('hunter2');

    // dated filename + URL revoked afterwards
    expect(anchorDownload).toMatch(/^sovecom-data-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(revokedUrl).toBe('blob:mock-url');

    // success message shown, raw PII NOT rendered
    expect(screen.getByText(/your download has started/i)).toBeInTheDocument();
  });

  it('NEVER renders the raw export JSON (PII) to the DOM', async () => {
    mockRequest = async () => SAMPLE_EXPORT;
    renderWithIntl(<RgpdExport />, 'en');
    submitWithPassword('hunter2');

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    // none of the sensitive payload values leak into the document
    expect(screen.queryByText(/123 Secret Street/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ada@example\.com/)).not.toBeInTheDocument();
  });

  it('clears the password field after a successful export', async () => {
    mockRequest = async () => SAMPLE_EXPORT;
    renderWithIntl(<RgpdExport />, 'en');
    submitWithPassword('hunter2');

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(screen.getByLabelText(/current password/i)).toHaveValue('');
  });
});

describe('RgpdExport — step-up 401 handling', () => {
  it('401 → refresh once → retry once → still 401 → shows the step-up message (no loop)', async () => {
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;
    const requestFn = vi.fn(async () => {
      throw unauthorized();
    });
    mockRequest = requestFn;

    renderWithIntl(<RgpdExport />, 'en');
    submitWithPassword('wrongpass');

    await waitFor(() =>
      expect(screen.getByText(/password incorrect or too many attempts/i)).toBeInTheDocument(),
    );
    // refresh tried exactly once; request attempted exactly twice (original + single retry) — no loop
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(requestFn).toHaveBeenCalledTimes(2);
    // no download happened
    expect(clickSpy).not.toHaveBeenCalled();
    // password cleared even on error
    expect(screen.getByLabelText(/current password/i)).toHaveValue('');
  });

  it('401 then refresh() THROWS → step-up message, retry never runs', async () => {
    refresh = vi.fn().mockRejectedValue(new Error('network down'));
    const requestFn = vi.fn(async () => {
      throw unauthorized();
    });
    mockRequest = requestFn;

    renderWithIntl(<RgpdExport />, 'en');
    submitWithPassword('wrongpass');

    await waitFor(() =>
      expect(screen.getByText(/password incorrect or too many attempts/i)).toBeInTheDocument(),
    );
    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('non-401 error → generic export error', async () => {
    mockRequest = async () => {
      throw new Error('500 Internal Server Error');
    };
    renderWithIntl(<RgpdExport />, 'en');
    submitWithPassword('hunter2');

    await waitFor(() =>
      expect(screen.getByText(/could not export your data/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/password incorrect/i)).not.toBeInTheDocument();
  });

  it('moves focus to the error alert on failure (WCAG 3.3.1)', async () => {
    mockRequest = async () => {
      throw new Error('500 Internal Server Error');
    };
    renderWithIntl(<RgpdExport />, 'en');
    submitWithPassword('hunter2');

    await waitFor(() =>
      expect(screen.getByText(/could not export your data/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/could not export your data/i)).toHaveFocus();
  });
});

describe('RgpdExport — i18n', () => {
  it('renders the FR labels', () => {
    mockRequest = async () => SAMPLE_EXPORT;
    renderWithIntl(<RgpdExport />, 'fr');
    expect(screen.getByRole('button', { name: /exporter mes données/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/mot de passe actuel/i)).toBeInTheDocument();
  });
});
