import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/database/schema';

const url = process.env.DATABASE_URL as string;
const MIGRATIONS = 'src/database/migrations';

describe('database (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    client = postgres(url, { max: 1 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it('applies migrations and creates the tenants table (idempotently)', async () => {
    // re-running migrations must be a no-op, not an error
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const rows = await client`select to_regclass('public.tenants') as t`;
    expect(rows[0].t).toBe('tenants');
  });

  it('inserts and reads back a tenant with an app-generated UUID v7 id', async () => {
    const slug = `int-${Date.now()}`;
    const [inserted] = await db
      .insert(schema.tenants)
      .values({ name: 'Test Store', slug })
      .returning();

    // UUID v7: the version nibble (15th hex digit) is 7
    expect(inserted.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const found = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Test Store');
    expect(found[0].createdAt).toBeInstanceOf(Date);

    await db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
  });

  it('enforces the unique slug constraint', async () => {
    const slug = `int-dup-${Date.now()}`;
    await db.insert(schema.tenants).values({ name: 'A', slug });
    await expect(db.insert(schema.tenants).values({ name: 'B', slug })).rejects.toThrow();
    await db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
  });
});
