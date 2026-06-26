/**
 * A tiny in-memory mock of the parts of the module SDK the recently-viewed handlers + repository
 * use. Lets the unit tests drive the REAL handler/repository/identity/category code against a fake
 * `sdk.tables` (a JS-side table store) and a fake `sdk.store.products` read surface.
 *
 * The tables fake is NOT a SQL engine — it understands exactly the parameterized statements the
 * repository issues (matched by stable substrings), which keeps the unit tests fast and DB-free
 * while the real SQL path is proven by the API integration suite against Postgres.
 *
 * It mirrors the real executor contract: the `recordView` upsert RETURNs the row it wrote (insert OR
 * conflict-update), so `exec` always reports that one row. The merge statements (upsert into customer
 * key + delete guest row) are also handled here.
 */
import type { StoreClient, ModuleProductDto, TablesClient, ListResult } from '@sovecom/module-sdk';
import type { ProductCategoryResolver } from '../src/category/category-filter';

interface ViewRow {
  id: string;
  viewer_key: string;
  product_id: string;
  viewed_at: string;
}

/** An in-memory fake of `sdk.tables` understanding exactly the recently-viewed repository's SQL. */
export class FakeTables implements TablesClient {
  views: ViewRow[] = [];
  private seq = 0;

  /** A monotonic timestamp so newest-first ordering is deterministic without real clock skew. */
  private nextTs(): string {
    this.seq += 1;
    return new Date(Date.UTC(2020, 0, 1) + this.seq * 1000).toISOString();
  }

  query<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<string | number | boolean | null> = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    // recent (with exclude): WHERE viewer_key = $1 AND product_id <> $2 ORDER BY viewed_at DESC LIMIT $3
    if (s.includes('product_id <> $2')) {
      const viewerKey = String(params[0]);
      const exclude = String(params[1]);
      const limit = Number(params[2]);
      const rows = this.views
        .filter((r) => r.viewer_key === viewerKey && r.product_id !== exclude)
        .sort((a, b) => cmpRecent(a, b))
        .slice(0, limit);
      return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
    }

    // recent (no exclude): WHERE viewer_key = $1 ORDER BY viewed_at DESC LIMIT $2
    // Also used by mergeGuestToCustomer to fetch all guest rows (LIMIT 200).
    if (s.includes('WHERE viewer_key = $1') && s.startsWith('SELECT')) {
      const viewerKey = String(params[0]);
      const limit = Number(params[1]);
      const rows = this.views
        .filter((r) => r.viewer_key === viewerKey)
        .sort((a, b) => cmpRecent(a, b))
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

    if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX') || s.startsWith('TRUNCATE')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // mergeGuestToCustomer delete: DELETE FROM ... WHERE viewer_key = $1 AND product_id = $2 RETURNING id
    if (s.startsWith('DELETE') && s.includes('viewer_key = $1') && s.includes('product_id = $2')) {
      const viewerKey = String(params[0]);
      const productId = String(params[1]);
      const before = this.views.length;
      this.views = this.views.filter(
        (r) => !(r.viewer_key === viewerKey && r.product_id === productId),
      );
      const deleted = before - this.views.length;
      return Promise.resolve({
        rows: deleted > 0 ? [{ id: 'deleted' }] : [],
        rowCount: deleted,
      });
    }

    // recordView / mergeGuestToCustomer upsert: INSERT ... ON CONFLICT (viewer_key, product_id) DO UPDATE ...
    if (s.startsWith('INSERT INTO') && s.includes('ON CONFLICT')) {
      const [id, viewerKey, productId] = [String(params[0]), String(params[1]), String(params[2])];
      const providedViewedAt = params[3] !== undefined ? String(params[3]) : undefined;
      const existing = this.views.find(
        (r) => r.viewer_key === viewerKey && r.product_id === productId,
      );
      if (existing) {
        // Conflict → DO UPDATE. For recordView: bump to now(). For merge: keep GREATEST(viewed_at).
        const newTs = providedViewedAt
          ? existing.viewed_at > providedViewedAt
            ? existing.viewed_at
            : providedViewedAt
          : this.nextTs();
        existing.viewed_at = newTs;
        return Promise.resolve({ rows: [{ ...existing }], rowCount: 1 });
      }
      const row: ViewRow = {
        id,
        viewer_key: viewerKey,
        product_id: productId,
        viewed_at: providedViewedAt ?? this.nextTs(),
      };
      this.views.push(row);
      return Promise.resolve({ rows: [{ ...row }], rowCount: 1 });
    }

    throw new Error(`FakeTables.exec: unhandled SQL: ${s}`);
  }
}

/** Newest-first ordering: viewed_at DESC, then id DESC (a stable tiebreak). */
function cmpRecent(a: ViewRow, b: ViewRow): number {
  if (a.viewed_at !== b.viewed_at) return a.viewed_at < b.viewed_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * A fake `sdk.store` catalog read. By default every product id resolves to a stub product (so the
 * existence guard passes + enrichment populates); pass `knownIds` to restrict which ids exist, or
 * `failGet` to exercise the degrade path. Counts `get` calls so a test can assert enrichment ran.
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

/**
 * A fake category resolver driving the `excludeCategories` seam: maps each productId to a set of
 * category ids per the provided map. Unknown products resolve to an empty set (never excluded).
 */
export class FakeCategoryResolver implements ProductCategoryResolver {
  calls = 0;
  constructor(private readonly map: ReadonlyMap<string, readonly string[]> = new Map()) {}
  categoriesOf(productId: string): Promise<ReadonlySet<string>> {
    this.calls += 1;
    return Promise.resolve(new Set(this.map.get(productId) ?? []));
  }
}
