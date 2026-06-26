import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The built-bin test compiles the package (and the SDK) with tsc, which can take a few seconds.
    testTimeout: 120_000,
  },
});
