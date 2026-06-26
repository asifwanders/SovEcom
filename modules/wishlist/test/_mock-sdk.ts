/**
 * A tiny in-memory mock of the parts of the module SDK the wishlist handlers + digest use. Lets the
 * unit tests drive the real handler/digest/repository code against a fake `sdk.tables` (a JS-side
 * table store), a fake `sdk.store.products`, and a recording `sdk.email`.
 *
 * The tables fake is NOT a SQL engine — it understands exactly the parameterized statements the
 * repository issues (matched by stable substrings), which keeps the unit tests fast and DB-free
 * while the real SQL path is proven by the API integration suite against Postgres.
 *
 * It mirrors the real executor contract: `exec` reports a row in `rows` ONLY for the rows a
 * statement RETURNs (the repository uses `RETURNING id` on INSERT/DELETE whose effect it checks),
 * so a no-op `ON CONFLICT DO NOTHING` / a no-match DELETE yields an empty `rows`.
 */
import type {
  EmailClient,
  ModuleEmailMessage,
  ModuleCustomerEmailMessage,
  StoreClient,
  TablesClient,
  ModuleProductDto,
} from '@sovecom/module-sdk';

interface ItemRow {
  id: string;
  customer_id: string;
  product_variant_id: string;
  created_at: string;
}
interface DigestRow {
  id: string;
  customer_id: string;
  product_variant_id: string;
  digest_run_id: string;
}

export class FakeTables implements TablesClient {
  items: ItemRow[] = [];
  digestLog: DigestRow[] = [];
  private seq = 0;

  private id(): string {
    this.seq += 1;
    return `row-${this.seq}`;
  }

  query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<string | number | boolean | null> = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT COUNT(*)')) {
      const customerId = String(params[0]);
      const count = this.items.filter((r) => r.customer_id === customerId).length;
      return Promise.resolve({ rows: [{ count } as unknown as T], rowCount: 1 });
    }
    if (s.includes('WHERE customer_id = $1 AND product_variant_id = $2 LIMIT 1')) {
      const [cid, vid] = [String(params[0]), String(params[1])];
      const found = this.items.filter((r) => r.customer_id === cid && r.product_variant_id === vid);
      return Promise.resolve({ rows: found as unknown as T[], rowCount: found.length });
    }
    if (s.includes('WHERE customer_id = $1 ORDER BY')) {
      const cid = String(params[0]);
      const rows = this.items
        .filter((r) => r.customer_id === cid)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
    }
    if (s.includes('WHERE product_variant_id IN')) {
      const wanted = new Set(params.map(String));
      const rows = this.items.filter((r) => wanted.has(r.product_variant_id));
      return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
    }
    throw new Error(`FakeTables.query: unhandled SQL: ${s}`);
  }

  exec(
    sql: string,
    params: ReadonlyArray<string | number | boolean | null> = [],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (s.startsWith(`INSERT INTO mod_wishlist_items`)) {
      const [, cid, vid] = [String(params[0]), String(params[1]), String(params[2])];
      const exists = this.items.some((r) => r.customer_id === cid && r.product_variant_id === vid);
      if (exists) return Promise.resolve({ rows: [], rowCount: 0 }); // ON CONFLICT DO NOTHING
      this.items.push({
        id: this.id(),
        customer_id: cid,
        product_variant_id: vid,
        created_at: new Date(Date.now() + this.seq).toISOString(),
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (s.startsWith('DELETE FROM mod_wishlist_items')) {
      const [cid, vid] = [String(params[0]), String(params[1])];
      const removed = this.items.filter(
        (r) => r.customer_id === cid && r.product_variant_id === vid,
      );
      this.items = this.items.filter(
        (r) => !(r.customer_id === cid && r.product_variant_id === vid),
      );
      // RETURNING id → one returned row per deleted row.
      const rows = removed.map((r) => ({ id: r.id }));
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (s.startsWith('INSERT INTO mod_wishlist_digest_log')) {
      const [rowId, cid, vid, run] = [
        String(params[0]),
        String(params[1]),
        String(params[2]),
        String(params[3]),
      ];
      const exists = this.digestLog.some(
        (r) => r.customer_id === cid && r.product_variant_id === vid && r.digest_run_id === run,
      );
      if (exists) return Promise.resolve({ rows: [], rowCount: 0 }); // ON CONFLICT DO NOTHING
      this.digestLog.push({
        id: rowId,
        customer_id: cid,
        product_variant_id: vid,
        digest_run_id: run,
      });
      // RETURNING id → one returned row for the inserted mark.
      return Promise.resolve({ rows: [{ id: rowId }], rowCount: 1 });
    }
    if (s.startsWith('DELETE FROM mod_wishlist_digest_log')) {
      // unmarkDigested (B3 rollback): remove a (customer, variant, run) claim. RETURNING id → one
      // returned row per removed claim.
      const [cid, vid, run] = [String(params[0]), String(params[1]), String(params[2])];
      const removed = this.digestLog.filter(
        (r) => r.customer_id === cid && r.product_variant_id === vid && r.digest_run_id === run,
      );
      this.digestLog = this.digestLog.filter(
        (r) => !(r.customer_id === cid && r.product_variant_id === vid && r.digest_run_id === run),
      );
      return Promise.resolve({ rows: removed.map((r) => ({ id: r.id })), rowCount: removed.length });
    }
    throw new Error(`FakeTables.exec: unhandled SQL: ${s}`);
  }
}

export class FakeStore implements StoreClient {
  constructor(private readonly byId: Record<string, ModuleProductDto> = {}) {}
  products = {
    list: () => Promise.resolve({ items: [] as ModuleProductDto[] }),
    get: (id: string): Promise<ModuleProductDto | null> => Promise.resolve(this.byId[id] ?? null),
  };
  categories = {
    list: () => Promise.resolve({ items: [] }),
    get: () => Promise.resolve(null),
  };
}

/**
 * A recording fake of the email client. `send` records raw messages. `sendToCustomer` (B3) records
 * the customer-addressed messages and returns a configurable outcome PER customerId so a test can
 * model core's suppression (queued:false) or a thrown RpcError without ever exposing an email.
 */
/** Outcome a test scripts for one customerId on `sendToCustomer`. */
export type FakeEmailOutcome =
  | 'queued'
  | 'suppressed'
  /** Throw an RpcError-shaped object carrying `code` so the digest's S1 branch can be exercised. */
  | { throwCode: string };

/**
 * A recording fake of the email client. `send` records raw messages. `sendToCustomer` (B3) records
 * the customer-addressed messages and returns a configurable outcome PER customerId so a test can
 * model core's suppression (queued:false) or a thrown RpcError (with a code) without ever exposing
 * an email.
 */
export class FakeEmail implements EmailClient {
  sent: ModuleEmailMessage[] = [];
  toCustomer: ModuleCustomerEmailMessage[] = [];
  private outcomes = new Map<string, FakeEmailOutcome>();

  /** Configure the outcome for a given customerId (default is 'queued'). */
  setOutcome(customerId: string, outcome: FakeEmailOutcome): void {
    this.outcomes.set(customerId, outcome);
  }

  send(message: ModuleEmailMessage): Promise<{ queued: true }> {
    this.sent.push(message);
    return Promise.resolve({ queued: true });
  }

  sendToCustomer(message: ModuleCustomerEmailMessage): Promise<{ queued: boolean }> {
    const outcome = this.outcomes.get(message.customerId) ?? 'queued';
    if (typeof outcome === 'object') {
      // Mimic a broker RpcError carrying `{ code }` — the body is recorded ONLY on a queued/
      // suppressed path, never on a throw, so the caller's claim-handling can be asserted.
      return Promise.reject(Object.assign(new Error('rpc: send failed'), { code: outcome.throwCode }));
    }
    this.toCustomer.push(message);
    return Promise.resolve({ queued: outcome === 'queued' });
  }
}
