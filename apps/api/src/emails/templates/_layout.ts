/**
 * shared email template helpers.
 *
 * HTML-string templates, **inline styles only** — no external CSS, images, web fonts, or
 * tracking pixels (self-host assets, no tracking by default). Every interpolated
 * value is HTML-escaped ({@link esc}) — product titles, addresses and the like are
 * merchant/customer data and must never break out of the markup (stored-XSS-in-email).
 */

/** The shape every template returns. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** A postal address as snapshotted on the order (JSONB — fields are best-effort). */
export interface AddressLike {
  name?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  region?: string | null;
  country?: string | null;
}

/** HTML-escape a value for safe interpolation into the markup. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a localized intro sentence to HTML, bolding the order number occurrence.
 *
 * The whole sentence is HTML-escaped first (the intro is a static catalog string and the
 * order number is merchant-allocated, but we escape unconditionally for defence-in-depth),
 * then the escaped order number is wrapped in `<strong>`. If the number does not appear in
 * the sentence (defensive), the escaped sentence is returned unchanged — never throws.
 */
export function introHtml(sentence: string, orderNumber: string): string {
  const escSentence = esc(sentence);
  const escNumber = esc(orderNumber);
  return escSentence.replace(escNumber, `<strong>${escNumber}</strong>`);
}

/** The non-empty lines of an address, in display order. */
export function addressLines(addr: AddressLike | null | undefined): string[] {
  if (!addr) return [];
  const cityLine = [addr.postalCode, addr.city].filter(Boolean).join(' ');
  return [
    addr.name,
    addr.company,
    addr.line1,
    addr.line2,
    cityLine || null,
    addr.region,
    addr.country,
  ]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((v) => v.length > 0);
}

/**
 * Wrap a template body in a minimal, self-contained HTML document. Inline styles only; a fixed
 * neutral palette (no external brand assets in v1).
 */
export function wrapHtml(title: string, bodyHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f4f5;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" ` +
    `style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;` +
    `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">` +
    `<tr><td style="padding:32px;">${bodyHtml}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
