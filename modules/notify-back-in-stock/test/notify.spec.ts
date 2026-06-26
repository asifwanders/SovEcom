/**
 * Unit tests — the back-in-stock runner against a MOCKED SDK. Covers: sends only to notified_at
 * IS NULL subscriptions, one email per subscription, sets notified_at, a re-run sends nothing
 * (idempotent), the per-run batch cap, bounded + correct email content, product-title resolution
 * (and graceful degradation), the disabled-module short-circuit, and input de-duplication.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runBackInStockNotifications, renderSubject, renderText } from '../src/notify/notify';
import { NotifyRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { FakeTables, FakeStore, FakeEmail } from './_mock-sdk';

async function seed(
  tables: FakeTables,
  entries: Array<[string, string, string | null]>,
): Promise<void> {
  const repo = new NotifyRepository(tables);
  for (const [email, vid, cid] of entries) await repo.subscribe(email, vid, cid);
}

describe('runBackInStockNotifications', () => {
  let tables: FakeTables;
  let email: FakeEmail;
  let store: FakeStore;
  let repo: NotifyRepository;

  beforeEach(() => {
    tables = new FakeTables();
    email = new FakeEmail();
    store = new FakeStore({
      v1: { id: 'v1', slug: 'red-shirt', title: 'Red Shirt', status: 'active' },
    });
    repo = new NotifyRepository(tables);
  });

  const on = resolveSettings({ enabled: true });

  it('does nothing when the module is disabled', async () => {
    await seed(tables, [['a@example.com', 'v1', null]]);
    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email, settings: resolveSettings({ enabled: false }) },
    );
    expect(res.sent).toBe(0);
    expect(email.sent).toHaveLength(0);
  });

  it('emails every pending subscriber of a restocked variant (one email each)', async () => {
    await seed(tables, [
      ['a@example.com', 'v1', null],
      ['b@example.com', 'v1', 'cust-b'],
    ]);
    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email, settings: on },
    );
    expect(res.sent).toBe(2);
    expect(email.sent).toHaveLength(2);
    expect(email.sent.map((m) => m.to).sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('sets notified_at on the sent subscriptions', async () => {
    await seed(tables, [['a@example.com', 'v1', null]]);
    await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email, settings: on },
    );
    expect(tables.subscriptions[0]?.notified_at).not.toBeNull();
  });

  it('only notifies notified_at IS NULL — already-notified subs are skipped', async () => {
    await seed(tables, [
      ['fresh@example.com', 'v1', null],
      ['done@example.com', 'v1', null],
    ]);
    // Pre-mark one as already notified.
    tables.subscriptions.find((r) => r.customer_email === 'done@example.com')!.notified_at =
      new Date().toISOString();

    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email, settings: on },
    );
    expect(res.sent).toBe(1);
    expect(email.sent.map((m) => m.to)).toEqual(['fresh@example.com']);
  });

  it('is IDEMPOTENT — a re-run for the same variant sends nothing further', async () => {
    await seed(tables, [['a@example.com', 'v1', null]]);
    const first = await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email, settings: on },
    );
    const second = await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email, settings: on },
    );
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(email.sent).toHaveLength(1);
  });

  it('respects the per-run batch cap (across variants)', async () => {
    await seed(tables, [
      ['a@example.com', 'v1', null],
      ['b@example.com', 'v1', null],
      ['c@example.com', 'v2', null],
    ]);
    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['v1', 'v2'] },
      { repo, store, email, settings: resolveSettings({ batchSize: 2 }) },
    );
    expect(res.sent).toBe(2);
    expect(email.sent).toHaveLength(2);
    // The third pending subscription is NOT notified this run (and stays NULL → eligible next run).
    const cRow = tables.subscriptions.find((r) => r.customer_email === 'c@example.com');
    expect(cRow?.notified_at).toBeNull();
  });

  it('only notifies subscribers of the ACTUALLY restocked variant', async () => {
    await seed(tables, [
      ['a@example.com', 'v1', null],
      ['z@example.com', 'v9', null],
    ]);
    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email, settings: on },
    );
    expect(res.sent).toBe(1);
    expect(email.sent[0]?.to).toBe('a@example.com');
  });

  it('de-duplicates a variant passed twice (no double-send)', async () => {
    await seed(tables, [['a@example.com', 'v1', null]]);
    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['v1', 'v1'] },
      { repo, store, email, settings: on },
    );
    expect(res.sent).toBe(1);
  });

  it('composes correct + bounded email content (product title resolved)', async () => {
    await seed(tables, [['a@example.com', 'v1', null]]);
    await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email, settings: on },
    );
    const msg = email.sent[0]!;
    expect(msg.subject).toBe('Back in stock: Red Shirt');
    expect(msg.text).toContain('Red Shirt is back in stock');
    expect(msg.subject.length).toBeLessThanOrEqual(160);
    expect(msg.text.length).toBeLessThanOrEqual(2000);
    // No CR/LF smuggled into the subject.
    expect(msg.subject).not.toMatch(/[\r\n]/);
  });

  it('degrades gracefully when the product title cannot be resolved', async () => {
    await seed(tables, [['a@example.com', 'unknown-variant', null]]);
    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['unknown-variant'] },
      { repo, store, email, settings: on },
    );
    expect(res.sent).toBe(1);
    expect(email.sent[0]?.subject).toContain('Back in stock:');
  });

  it('a single send failure does NOT abort the batch — the others still send', async () => {
    await seed(tables, [
      ['boom@example.com', 'v1', null],
      ['ok1@example.com', 'v1', null],
      ['ok2@example.com', 'v1', null],
    ]);
    const failingEmail = new FakeEmail(new Set(['boom@example.com']));

    // Must NOT throw — the run completes and returns a RunResult.
    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email: failingEmail, settings: on },
    );

    expect(res.sent).toBe(2); // the two good recipients
    expect(res.failed).toBe(1); // the one that threw, counted not propagated
    expect(failingEmail.sent.map((m) => m.to).sort()).toEqual([
      'ok1@example.com',
      'ok2@example.com',
    ]);
    // The failed sub stays reserved (marked) — not retried this run ("no duplicate over no loss").
    const boomRow = tables.subscriptions.find((r) => r.customer_email === 'boom@example.com');
    expect(boomRow?.notified_at).not.toBeNull();
  });

  it('a failed send still consumes its batch slot (cap accounts for attempts)', async () => {
    await seed(tables, [
      ['boom@example.com', 'v1', null],
      ['queued@example.com', 'v1', null],
    ]);
    const failingEmail = new FakeEmail(new Set(['boom@example.com']));
    // Cap of 1: the first (failing) attempt consumes the only slot, so the second never sends.
    const res = await runBackInStockNotifications(
      { restockedVariantIds: ['v1'] },
      { repo, store, email: failingEmail, settings: resolveSettings({ batchSize: 1 }) },
    );
    expect(res.sent + res.failed).toBe(1);
    expect(failingEmail.sent).toHaveLength(0);
  });
});

describe('renderSubject / renderText', () => {
  it('substitutes {product} in the subject template', () => {
    expect(renderSubject('Back in stock: {product}', 'Blue Hat')).toBe('Back in stock: Blue Hat');
  });
  it('bounds a long subject to 160 chars', () => {
    expect(renderSubject('{product}', 'x'.repeat(500)).length).toBe(160);
  });
  it('renders a plaintext body mentioning the title', () => {
    expect(renderText('Blue Hat')).toContain('Blue Hat is back in stock');
  });
});
