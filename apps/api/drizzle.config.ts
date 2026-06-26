import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config. `generate` reads the schema and emits SQL migrations
 * (offline, no DB needed). `migrate` applies them and needs DATABASE_URL.
 */
export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://sovecom:devpassword@localhost:5432/sovecom_dev',
  },
  strict: true,
  verbose: true,
});
