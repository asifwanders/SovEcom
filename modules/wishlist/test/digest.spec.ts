/**
 * Unit tests — the price-drop digest against a MOCKED SDK (B3). Covers idempotency across re-runs,
 * real-drop detection, email content, consolidation per customer, and the `sendToCustomer` wiring:
 * a queued send counts as sent; a core SUPPRESSION (queued:false) consumes the run's idempotency
 * claim (so an opted-out customer is not retried every run); a THROWN RpcError rolls the claim back.
 * The module supplies ONLY the customerId — it never sees an email (no `resolveEmail` seam).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  runPriceDropDigest,
  buildDigestEmail,
  type PriceDropCandidate,
} from '../src/digest/digest';
import { WishlistRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { FakeTables, FakeEmail } from './_mock-sdk';

const RUN = 'run-2026-w25';

async function seedWishlist(tables: FakeTables, entries: Array<[string, string]>): Promise<void> {
  const repo = new WishlistRepository(tables);
  for (const [cid, vid] of entries) await repo.add(cid, vid);
}

function drop(over: Partial<PriceDropCandidate> = {}): PriceDropCandidate {
  return {
    productVariantId: 'v1',
    title: 'Red Shirt',
    oldPriceMinor: 2000,
    newPriceMinor: 1500,
    currency: 'EUR',
    ...over,
  };
}

describe('runPriceDropDigest', () => {
  let tables: FakeTables;
  let email: FakeEmail;
  let repo: WishlistRepository;

  beforeEach(() => {
    tables = new FakeTables();
    email = new FakeEmail();
    repo = new WishlistRepository(tables);
  });

  const digestOn = resolveSettings({ enabled: true, weeklyDigest: true });

  it('does nothing when the module-level weeklyDigest is off', async () => {
    await seedWishlist(tables, [['cust-a', 'v1']]);
    const res = await runPriceDropDigest(
      { digestRunId: RUN, candidates: [drop()] },
      { repo, email, settings: resolveSettings({ enabled: true, weeklyDigest: false }) },
    );
    expect(res.sent).toBe(0);
    expect(email.toCustomer).toHaveLength(0);
  });

  it('emails a customer who wishlisted a dropped variant via sendToCustomer (by id, no address)', async () => {
    await seedWishlist(tables, [['cust-a', 'v1']]);
    const res = await runPriceDropDigest(
      { digestRunId: RUN, candidates: [drop()] },
      { repo, email, settings: digestOn },
    );
    expect(res.sent).toBe(1);
    expect(email.toCustomer).toHaveLength(1);
    // The module supplies the customerId — NOT an email (there is no `to` on a customer message).
    expect(email.toCustomer[0]?.customerId).toBe('cust-a');
    expect((email.toCustomer[0] as { to?: unknown }).to).toBeUndefined();
    expect(email.toCustomer[0]?.subject).toMatch(/price drop/i);
    expect(email.toCustomer[0]?.text).toContain('Red Shirt');
    expect(email.toCustomer[0]?.text).toContain('20.00 EUR');
    expect(email.toCustomer[0]?.text).toContain('15.00 EUR');
  });

  it('SUPPRESSED by core (queued:false) → counted as skipped, claim CONSUMED (not retried next run)', async () => {
    await seedWishlist(tables, [['cust-a', 'v1']]);
    email.setOutcome('cust-a', 'suppressed');
    const first = await runPriceDropDigest(
      { digestRunId: RUN, candidates: [drop()] },
      { repo, email, settings: digestOn },
    );
    expect(first.sent).toBe(0);
    expect(first.skipped).toBe(1);
    // A second run with the SAME id finds the claim already consumed → no re-attempt.
    const second = await runPriceDropDigest(
      { digestRunId: RUN, candidates: [drop()] },
      { repo, email, settings: digestOn },
    );
    expect(second.sent).toBe(0);
    // Only the first run reached sendToCustomer; the suppressed customer is NOT re-attempted.
    expect(email.toCustomer).toHaveLength(1);
  });

  // S1: a definitely-not-delivered throw (PROTOCOL/RATE_LIMITED/FORBIDDEN) rolls the claim back.
  it.each(['protocol', 'rate_limited', 'forbidden'])(
    'a THROWN %s (definitely-not-delivered) rolls the claim back → the next run retries',
    async (code) => {
      await seedWishlist(tables, [['cust-a', 'v1']]);
      email.setOutcome('cust-a', { throwCode: code });
      await expect(
        runPriceDropDigest(
          { digestRunId: RUN, candidates: [drop()] },
          { repo, email, settings: digestOn },
        ),
      ).rejects.toThrow();
      // The claim was rolled back, so a retry (now succeeding) actually sends.
      email.setOutcome('cust-a', 'queued');
      const retry = await runPriceDropDigest(
        { digestRunId: RUN, candidates: [drop()] },
        { repo, email, settings: digestOn },
      );
      expect(retry.sent).toBe(1);
      expect(email.toCustomer).toHaveLength(1);
    },
  );

  // S1: a HANDLER_ERROR is POSSIBLY-DELIVERED → KEEP the claim (no re-send on a later run/redelivery).
  it('a THROWN handler_error (possibly delivered) KEEPS the claim → no re-send on the next run', async () => {
    await seedWishlist(tables, [['cust-a', 'v1']]);
    email.setOutcome('cust-a', { throwCode: 'handler_error' });
    await expect(
      runPriceDropDigest(
        { digestRunId: RUN, candidates: [drop()] },
        { repo, email, settings: digestOn },
      ),
    ).rejects.toThrow();
    // The claim was RETAINED. A retry (even if it would now succeed) finds the claim consumed → no
    // second promotional send for a mail that may already have gone out.
    email.setOutcome('cust-a', 'queued');
    const retry = await runPriceDropDigest(
      { digestRunId: RUN, candidates: [drop()] },
      { repo, email, settings: digestOn },
    );
    expect(retry.sent).toBe(0);
    expect(email.toCustomer).toHaveLength(0); // never re-attempted
  });

  // A non-RpcError (no code) is treated like a possibly-delivered failure → KEEP the claim.
  it('a THROWN error with NO code KEEPS the claim (bias to no-duplicate)', async () => {
    await seedWishlist(tables, [['cust-a', 'v1']]);
    // setOutcome with an object whose code is empty → errorCode() returns '' → not in rollback set.
    email.setOutcome('cust-a', { throwCode: '' });
    await expect(
      runPriceDropDigest(
        { digestRunId: RUN, candidates: [drop()] },
        { repo, email, settings: digestOn },
      ),
    ).rejects.toThrow();
    email.setOutcome('cust-a', 'queued');
    const retry = await runPriceDropDigest(
      { digestRunId: RUN, candidates: [drop()] },
      { repo, email, settings: digestOn },
    );
    expect(retry.sent).toBe(0);
  });

  it('is IDEMPOTENT — re-running the same digestRunId sends nothing further', async () => {
    await seedWishlist(tables, [['cust-a', 'v1']]);
    const input = { digestRunId: RUN, candidates: [drop()] };
    const first = await runPriceDropDigest(input, { repo, email, settings: digestOn });
    const second = await runPriceDropDigest(input, { repo, email, settings: digestOn });
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(email.toCustomer).toHaveLength(1);
  });

  it('ignores non-drops (price up / equal / non-integer)', async () => {
    await seedWishlist(tables, [['cust-a', 'v1']]);
    const res = await runPriceDropDigest(
      { digestRunId: RUN, candidates: [drop({ oldPriceMinor: 1000, newPriceMinor: 1500 })] },
      { repo, email, settings: digestOn },
    );
    expect(res.sent).toBe(0);
  });

  it('consolidates multiple dropped items into ONE email per customer', async () => {
    await seedWishlist(tables, [
      ['cust-a', 'v1'],
      ['cust-a', 'v2'],
    ]);
    const res = await runPriceDropDigest(
      {
        digestRunId: RUN,
        candidates: [
          drop({ productVariantId: 'v1', title: 'Shirt' }),
          drop({ productVariantId: 'v2', title: 'Hat', oldPriceMinor: 999, newPriceMinor: 499 }),
        ],
      },
      { repo, email, settings: digestOn },
    );
    expect(res.sent).toBe(1);
    expect(email.toCustomer).toHaveLength(1);
    expect(email.toCustomer[0]?.text).toContain('Shirt');
    expect(email.toCustomer[0]?.text).toContain('Hat');
    expect(email.toCustomer[0]?.subject).toMatch(/2 items/i);
  });

  it('only emails customers who actually wishlisted the dropped variant', async () => {
    await seedWishlist(tables, [
      ['cust-a', 'v1'],
      ['cust-b', 'v9'],
    ]); // B watches a different variant
    const res = await runPriceDropDigest(
      { digestRunId: RUN, candidates: [drop({ productVariantId: 'v1' })] },
      { repo, email, settings: digestOn },
    );
    expect(res.sent).toBe(1); // only A
    expect(email.toCustomer.map((m) => m.customerId)).toEqual(['cust-a']);
  });
});

describe('buildDigestEmail', () => {
  it('singular subject for one drop', () => {
    const { subject } = buildDigestEmail([drop()]);
    expect(subject).toMatch(/an item/i);
  });
  it('plural subject + count for multiple', () => {
    const { subject } = buildDigestEmail([
      drop({ productVariantId: 'a' }),
      drop({ productVariantId: 'b' }),
    ]);
    expect(subject).toMatch(/2 items/i);
  });
});
