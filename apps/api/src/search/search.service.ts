import { Injectable } from '@nestjs/common';
import type { Meilisearch } from 'meilisearch';

/** Well-known dev/test Meilisearch master key (matches docker-compose.dev). */
export const MEILI_MASTER_KEY_DEV_DEFAULT = 'devkey';

/** Known-default / weak Meilisearch keys rejected in production (compared lower-cased). */
const MEILI_KNOWN_DEFAULTS = new Set([MEILI_MASTER_KEY_DEV_DEFAULT, 'changeme', 'masterkey']);

/** Minimum prod key length, mirroring the 256-bit floor used by the other secret guards. */
const MEILI_MIN_KEY_LENGTH = 32;

/**
 * Resolve + validate `MEILI_MASTER_KEY` (H3). In production an unset or
 * known-default key is a HARD boot failure (a default key lets anyone read/write
 * every tenant index). In dev/test the well-known default is allowed so local
 * setup needs no env. Mirrors TokenService.getSigningKey / STORAGE_SIGNING_SECRET.
 */
export function resolveMeiliMasterKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env['MEILI_MASTER_KEY'];
  const isProd = env['NODE_ENV'] === 'production';

  if (isProd) {
    if (!key || key.length === 0) {
      throw new Error('MEILI_MASTER_KEY must be set in production');
    }
    if (MEILI_KNOWN_DEFAULTS.has(key.toLowerCase())) {
      throw new Error('MEILI_MASTER_KEY must not be a known default in production');
    }
    if (key.length < MEILI_MIN_KEY_LENGTH) {
      throw new Error('MEILI_MASTER_KEY must be at least 32 characters in production');
    }
    return key;
  }

  return key ?? MEILI_MASTER_KEY_DEV_DEFAULT;
}

/**
 * Meilisearch client wrapper.
 *
 * meilisearch v0.58 is ESM-only, while this API compiles to CommonJS, so the
 * client is loaded via a dynamic `import()` (valid CJS→ESM interop that
 * `nodenext` preserves). The client is created lazily and memoised.
 */
@Injectable()
export class SearchService {
  private clientPromise?: Promise<Meilisearch>;

  async getClient(): Promise<Meilisearch> {
    if (!this.clientPromise) {
      this.clientPromise = import('meilisearch').then(
        ({ Meilisearch }) =>
          new Meilisearch({
            host: process.env.MEILISEARCH_URL ?? 'http://localhost:7700',
            apiKey: resolveMeiliMasterKey(),
          }),
      );
    }
    return this.clientPromise;
  }

  async ping(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const health = await client.health();
      return health.status === 'available';
    } catch {
      return false;
    }
  }

  indexName(tenantId: string, resource: 'products' | 'categories'): string {
    return `${tenantId}_${resource}`;
  }

  productsIndex(tenantId: string): string {
    return this.indexName(tenantId, 'products');
  }

  categoriesIndex(tenantId: string): string {
    return this.indexName(tenantId, 'categories');
  }
}
