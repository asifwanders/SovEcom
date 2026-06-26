/**
 * InvoiceDownloadButton tests. AUTH/IDOR-CRITICAL.
 *
 * The invoice PDF is an AUTHENTICATED BLOB, so it cannot ride the client-js transport (that JSON-
 * parses every response). This component issues a raw credentialed `fetch` with the access token in
 * the Authorization HEADER (never the URL/query) and streams the response as a Blob download.
 *
 * Security contract proven here:
 *   - token is sent in the Authorization header, NEVER appended to the request URL;
 *   - a 401 triggers exactly ONE silent `refresh()` + ONE retry (refresh failure → error state, no loop);
 *   - a 404 (not-owner OR no-invoice-yet — a UNIFORM server response) shows a calm "not available"
 *     message and NEVER oracles which of the two it was.
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

// --- Locale-aware navigation mock (mirrors sibling specs; component does not navigate but keep parity) ---
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import { InvoiceDownloadButton } from './InvoiceDownloadButton';

/** Build a Response-like stub with a Blob body and a (possibly absent) Content-Disposition header. */
function pdfResponse(opts: { contentDisposition?: string | null } = {}): Response {
  const headers = new Headers();
  if (opts.contentDisposition) headers.set('content-disposition', opts.contentDisposition);
  return {
    ok: true,
    status: 200,
    headers,
    blob: async () => new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }),
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    blob: async () => new Blob([]),
  } as unknown as Response;
}

// --- jsdom lacks blob URL + anchor download; stub them and capture the created anchor ---
let createdUrl: string;
let revokedUrl: string | undefined;
let anchorDownload: string | undefined;
let anchorHref: string | undefined;
let clickSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getAccessToken = () => 'token-abc';
  refresh = async () => 'token-abc';
  createdUrl = 'blob:mock-url';
  revokedUrl = undefined;
  anchorDownload = undefined;
  anchorHref = undefined;

  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => createdUrl),
    revokeObjectURL: vi.fn((u: string) => {
      revokedUrl = u;
    }),
  });

  // Intercept anchor creation so a real navigation never happens and we can assert download/href.
  clickSpy = vi.fn();
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = realCreate(tag) as HTMLElement;
    if (tag === 'a') {
      const a = el as HTMLAnchorElement;
      Object.defineProperty(a, 'click', { value: clickSpy, writable: true });
      const origSetAttr = a.setAttribute.bind(a);
      vi.spyOn(a, 'setAttribute').mockImplementation((name: string, value: string) => {
        if (name === 'download') anchorDownload = value;
        if (name === 'href') anchorHref = value;
        return origSetAttr(name, value);
      });
      // also capture direct property assignment
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

const PROPS = { orderId: 'order-1', orderNumber: 'ORD-0001', status: 'shipped' };

describe('InvoiceDownloadButton', () => {
  it('renders an idle download button with an accessible name', () => {
    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    expect(screen.getByRole('button', { name: /download invoice/i })).toBeInTheDocument();
  });

  it('is hidden when order status is pending_payment (no invoice yet)', () => {
    renderWithIntl(<InvoiceDownloadButton {...PROPS} status="pending_payment" />, 'en');
    expect(screen.queryByRole('button', { name: /download invoice/i })).not.toBeInTheDocument();
  });

  it('is hidden when order status is cancelled (cancelled/unpaid → no invoice)', () => {
    renderWithIntl(<InvoiceDownloadButton {...PROPS} status="cancelled" />, 'en');
    expect(screen.queryByRole('button', { name: /download invoice/i })).not.toBeInTheDocument();
  });

  it('is shown for a paid order', () => {
    renderWithIntl(<InvoiceDownloadButton {...PROPS} status="paid" />, 'en');
    expect(screen.getByRole('button', { name: /download invoice/i })).toBeInTheDocument();
  });

  it('is shown for a refunded order (the original invoice still exists)', () => {
    renderWithIntl(<InvoiceDownloadButton {...PROPS} status="refunded" />, 'en');
    expect(screen.getByRole('button', { name: /download invoice/i })).toBeInTheDocument();
  });

  it('HAPPY: fetches with the token in the Authorization HEADER (not the URL) and downloads the blob', async () => {
    const fetchMock = vi.fn(async () =>
      pdfResponse({ contentDisposition: 'inline; filename="invoice-A-42.pdf"' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Token must be in the header...
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
    // ...and NEVER in the URL/query.
    expect(url).toContain('/store/v1/orders/order-1/invoice');
    expect(url).not.toContain('token-abc');
    expect(url.toLowerCase()).not.toContain('authorization');
    expect(init.credentials).toBe('include');

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(anchorHref).toBe('blob:mock-url');
    // filename derived from Content-Disposition
    expect(anchorDownload).toBe('invoice-A-42.pdf');
    // blob URL revoked after download
    await waitFor(() => expect(revokedUrl).toBe('blob:mock-url'));
  });

  it('falls back to invoice-<orderNumber>.pdf when no Content-Disposition header', async () => {
    const fetchMock = vi.fn(async () => pdfResponse({ contentDisposition: null }));
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(anchorDownload).toBe('invoice-ORD-0001.pdf');
  });

  it("decodes the RFC 5987 filename*=UTF-8''... form (preferred over plain filename)", async () => {
    const fetchMock = vi.fn(async () =>
      pdfResponse({
        // Non-ASCII name "facture-é.pdf" percent-encoded; a plain filename= is also present to prove
        // the extended form wins.
        contentDisposition:
          'inline; filename="fallback.pdf"; filename*=UTF-8\'\'facture-%C3%A9.pdf',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(anchorDownload).toBe('facture-é.pdf');
  });

  it('401 → calls refresh() ONCE and retries the fetch, which then succeeds', async () => {
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1 ? errorResponse(401) : pdfResponse({ contentDisposition: null });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('401 then refresh() REJECTS → ends in the generic error state (no loop, no unhandled rejection)', async () => {
    refresh = vi.fn().mockRejectedValue(new Error('network down'));
    const fetchMock = vi.fn(async () => errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() =>
      expect(screen.getByText(/could not download the invoice/i)).toBeInTheDocument(),
    );
    // Only the original attempt fetched; the retry never ran because refresh failed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('404 → shows the calm "invoice not available yet" message (NOT the generic error)', async () => {
    const fetchMock = vi.fn(async () => errorResponse(404));
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() =>
      expect(screen.getByText(/invoice isn.t available yet/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/could not download the invoice/i)).not.toBeInTheDocument();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('500 → shows the generic "could not download" error', async () => {
    const fetchMock = vi.fn(async () => errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() =>
      expect(screen.getByText(/could not download the invoice/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/invoice isn.t available yet/i)).not.toBeInTheDocument();
  });

  it('network rejection → shows the generic error (no unhandled rejection)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network');
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() =>
      expect(screen.getByText(/could not download the invoice/i)).toBeInTheDocument(),
    );
  });

  it('shows the in-progress state (disabled, aria-busy) while downloading', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    const btn = screen.getByRole('button', { name: /download invoice/i });
    fireEvent.click(btn);

    await waitFor(() => {
      const busy = screen.getByRole('button');
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');
    });

    resolveFetch(pdfResponse({ contentDisposition: null }));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  });

  it('omits the Authorization header entirely when there is no token (still credentialed)', async () => {
    getAccessToken = () => null;
    const fetchMock = vi.fn(async () => pdfResponse({ contentDisposition: null }));
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'en');
    fireEvent.click(screen.getByRole('button', { name: /download invoice/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.credentials).toBe('include');
  });

  it('renders the FR label', () => {
    renderWithIntl(<InvoiceDownloadButton {...PROPS} />, 'fr');
    expect(screen.getByRole('button', { name: /télécharger la facture/i })).toBeInTheDocument();
  });
});
