import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the recently-viewed module — pure handler/settings/identity logic against a
 * MOCKED SDK. No DB, no worker, no network. The real-runtime + real-Postgres path is covered by the
 * API integration suite (apps/api/test/integration/modules/recently-viewed.int-spec.ts).
 *
 * `@sovecom/module-sdk` resolves to its workspace source (TS), mirroring how apps/api maps it in its
 * Jest configs, so the unit tests build against the same single-source-of-truth contract.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
  },
});
