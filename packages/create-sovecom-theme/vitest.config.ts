import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The end-to-end test builds the generated theme's tsconfig, which can take a few seconds.
    testTimeout: 120_000,
  },
});
