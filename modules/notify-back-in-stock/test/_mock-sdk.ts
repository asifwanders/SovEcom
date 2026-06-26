/**
 * A tiny in-memory mock of the parts of the module SDK the notify handlers + runner use. Lets the
 * unit tests drive the real handler/runner/repository code against a fake `sdk.tables` (a JS-side
 * table store), a fake `sdk.store.products`, and a recording `sdk.email`.
 *
 * The tables fake is NOT a SQL engine — it understands exactly the parameterized statements the
 * repository issues (matched by stable substrings), which keeps the unit tests fast and DB-free
 * while the real SQL path is proven by the API integration suite against Postgres.
 *
 * It mirrors the real executor contract: `exec` reports a row in `rows` ONLY for the rows a
 * statement RETURNs (the repository uses `RETURNING id` on the UPDATE/DELETE whose effect it checks),
 * so a no-op markNotified / a no-match DELETE yields an empty `rows`.
 */
import type {
  EmailClient,
  ModuleEmailMessage,
  ModuleCustomerEmailMessage,
  StoreClient,
  TablesClient,
  ModuleProductDto,
} from '@sovecom/module-sdk';

interface SubRow {
  id: string;
  customer_email: string;
  product_variant_id: string;
  customer_id: string | null;
  created_at: string;
  notified_at: string | null;
}

export class FakeTables implements TablesClient {
  subscriptions: SubRow[] = [];
  private seq = 0;

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<string | number | boolean | null> = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    // pendingForVariant: WHERE product_variant_id = $1 AND notified_at IS NULL ... LIMIT $2
    if (s.includes('WHERE product_variant_id = $1 AND notified_at IS NULL')) {
      const variantId = String(params[0]);
      const limit = Number(params[1]);
      const rows = this.subscriptions
        .filter((r) => r.product_variant_id === variantId && r.notified_at === null)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
        .slice(0, limit);
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

    // subscribe: INSERT ... ON CONFLICT (customer_email, product_variant_id) DO UPDATE SET
    // notified_at = NULL, customer_id = EXCLUDED.customer_id
    if (s.startsWith('INSERT INTO') && s.includes('ON CONFLICT')) {
      const [id, email, vid, cid] = [
        String(params[0]),
        String(params[1]),
        String(params[2]),
        params[3] === null ? null : String(params[3]),
      ];
      const existing = this.subscriptions.find(
        (r) => r.customer_email === email && r.product_variant_id === vid,
      );
      if (existing) {
        // DO UPDATE: reset notified_at, refresh customer_id (the re-subscribe behavior).
        existing.notified_at = null;
        existing.customer_id = cid;
      } else {
        this.subscriptions.push({
          id,
          customer_email: email,
          product_variant_id: vid,
          customer_id: cid,
          created_at: new Date(Date.now() + this.nextSeq()).toISOString(),
          notified_at: null,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // unsubscribe: DELETE ... WHERE customer_email = $1 AND product_variant_id = $2 RETURNING id
    if (s.startsWith('DELETE FROM')) {
      const [email, vid] = [String(params[0]), String(params[1])];
      const removed = this.subscriptions.filter(
        (r) => r.customer_email === email && r.product_variant_id === vid,
      );
      this.subscriptions = this.subscriptions.filter(
        (r) => !(r.customer_email === email && r.product_variant_id === vid),
      );
      const rows = removed.map((r) => ({ id: r.id }));
      return Promise.resolve({ rows, rowCount: rows.length });
    }

    // markNotified: UPDATE ... SET notified_at = now() WHERE id = $1 AND notified_at IS NULL
    // RETURNING id
    if (s.startsWith('UPDATE') && s.includes('SET notified_at = now()')) {
      const id = String(params[0]);
      const row = this.subscriptions.find((r) => r.id === id && r.notified_at === null);
      if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
      row.notified_at = new Date(Date.now() + this.nextSeq()).toISOString();
      return Promise.resolve({ rows: [{ id: row.id }], rowCount: 1 });
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

export class FakeEmail implements EmailClient {
  sent: ModuleEmailMessage[] = [];
  /** Recipients this fake should reject (to exercise the runner's per-send try/catch). */
  constructor(private readonly failOn: ReadonlySet<string> = new Set()) {}
  send(message: ModuleEmailMessage): Promise<{ queued: true }> {
    if (this.failOn.has(message.to)) {
      return Promise.reject(new Error(`transport refused ${message.to}`));
    }
    this.sent.push(message);
    return Promise.resolve({ queued: true });
  }

  // notify-back-in-stock emails via `send` (it captured the address at subscription time); this
  // stub exists only to satisfy the EmailClient interface (B3). Not exercised by this module.
  toCustomer: ModuleCustomerEmailMessage[] = [];
  sendToCustomer(message: ModuleCustomerEmailMessage): Promise<{ queued: boolean }> {
    this.toCustomer.push(message);
    return Promise.resolve({ queued: true });
  }
}
