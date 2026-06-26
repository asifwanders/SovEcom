/**
 * A tiny in-memory mock of the parts of the module SDK the reviews handlers + repository use. Lets
 * the unit tests drive the real handler/repository/purchase-gate code against a fake `sdk.tables` (a
 * JS-side table store) and a fake `sdk.commerce` purchase probe.
 *
 * The tables fake is NOT a SQL engine — it understands exactly the parameterized statements the
 * repository issues (matched by stable substrings), which keeps the unit tests fast and DB-free
 * while the real SQL path is proven by the API integration suite against Postgres.
 *
 * It mirrors the real executor contract: `exec` reports a row in `rows` ONLY for the rows a
 * statement RETURNs (the repository uses `RETURNING id` on INSERT/UPDATE whose effect it checks), so
 * a duplicate INSERT (ON CONFLICT DO NOTHING) and a no-match UPDATE yield an empty `rows`.
 */
import type {
  CommerceClient,
  StoreClient,
  ModuleProductDto,
  TablesClient,
  ListResult,
} from '@sovecom/module-sdk';
import type { ReviewStatus } from '../src/db/repository';

interface ReviewRow {
  id: string;
  customer_id: string;
  product_id: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  created_at: string;
}

/** An in-memory fake of `sdk.tables` understanding exactly the reviews repository's SQL. */
export class FakeTables implements TablesClient {
  reviews: ReviewRow[] = [];
  private seq = 0;

  private nextTs(): string {
    this.seq += 1;
    return new Date(Date.UTC(2020, 0, 1) + this.seq * 1000).toISOString();
  }

  query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<string | number | boolean | null> = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    // approvedWithSummary: SELECT ..., COUNT(*) OVER ()::int, AVG(rating) OVER ()::float8 ... approved
    if (s.includes('OVER ()') && s.includes("status = 'approved'")) {
      const productId = String(params[0]);
      const approved = this.reviews
        .filter((r) => r.product_id === productId && r.status === 'approved')
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      const count = approved.length;
      const avg = count > 0 ? approved.reduce((a, r) => a + r.rating, 0) / count : null;
      // The window aggregate repeats on every approved row (none when there are zero rows).
      const rows = approved.map((r) => ({ ...r, total_count: count, avg_rating: avg }));
      return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
    }

    // listPending: SELECT ... WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1 OFFSET $2
    if (s.includes("status = 'pending'")) {
      const limit = Number(params[0]);
      const offset = Number(params[1]);
      const all = this.reviews
        .filter((r) => r.status === 'pending')
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
      const rows = all.slice(offset, offset + limit);
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

    // create: INSERT ... ON CONFLICT (customer_id, product_id) DO NOTHING RETURNING ...
    if (s.startsWith('INSERT INTO') && s.includes('ON CONFLICT')) {
      const [id, customerId, productId, rating, body, status] = [
        String(params[0]),
        String(params[1]),
        String(params[2]),
        Number(params[3]),
        String(params[4]),
        String(params[5]) as ReviewStatus,
      ];
      const existing = this.reviews.find(
        (r) => r.customer_id === customerId && r.product_id === productId,
      );
      if (existing) {
        // ON CONFLICT DO NOTHING → no RETURNING row.
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const row: ReviewRow = {
        id,
        customer_id: customerId,
        product_id: productId,
        rating,
        body,
        status,
        created_at: this.nextTs(),
      };
      this.reviews.push(row);
      return Promise.resolve({ rows: [{ ...row }], rowCount: 1 });
    }

    // setStatus: UPDATE ... SET status = $2 WHERE id = $1 RETURNING id
    if (s.startsWith('UPDATE') && s.includes('SET status = $2')) {
      const [id, status] = [String(params[0]), String(params[1]) as ReviewStatus];
      const row = this.reviews.find((r) => r.id === id);
      if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
      row.status = status;
      return Promise.resolve({ rows: [{ id: row.id }], rowCount: 1 });
    }

    throw new Error(`FakeTables.exec: unhandled SQL: ${s}`);
  }
}

/**
 * A fake `sdk.commerce` purchase probe (B1). Records every (customerId, productId) it was asked
 * about (so a test can assert the gate genuinely consulted the read:orders surface) and returns a
 * verdict from an injected predicate (default: deny everything). `failsWith` injects a throw to
 * exercise the verifier's degrade-to-deny path.
 */
export class FakeCommerce implements CommerceClient {
  calls: Array<{ customerId: string; productId: string }> = [];
  constructor(
    private readonly verdict: (customerId: string, productId: string) => boolean = () => false,
    private readonly failsWith: Error | null = null,
  ) {}
  hasPurchased(customerId: string, productId: string): Promise<boolean> {
    this.calls.push({ customerId, productId });
    if (this.failsWith) return Promise.reject(this.failsWith);
    return Promise.resolve(this.verdict(customerId, productId));
  }
}

/**
 * A fake `sdk.store` catalog read. By default every product id resolves to a stub product (so the
 * existence guard passes); pass `knownIds` to restrict which ids exist, or `failGet` to exercise the
 * degrade-to-404 path.
 */
export class FakeStore implements StoreClient {
  productsGetCalls = 0;
  constructor(
    private readonly knownIds: ReadonlySet<string> | null = null,
    private readonly failGet = false,
  ) {}
  products = {
    list: (): Promise<ListResult<ModuleProductDto>> => Promise.resolve({ items: [] }),
    get: (id: string): Promise<ModuleProductDto | null> => {
      this.productsGetCalls += 1;
      if (this.failGet) return Promise.reject(new Error('catalog unavailable'));
      const exists = this.knownIds === null || this.knownIds.has(id);
      return Promise.resolve(
        exists ? { id, slug: `slug-${id}`, title: `Product ${id}`, status: 'published' } : null,
      );
    },
  };
  categories = {
    list: () => Promise.resolve({ items: [] }),
    get: () => Promise.resolve(null),
  };
}
