import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // The Playwright E2E specs live in `e2e/` and also use the `.spec.ts` suffix but
    // import `@playwright/test` — scope vitest to `src` and exclude the e2e tree (mirrors storefront).
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'e2e/**'],
    // Some form/route specs run close to ~5s and intermittently exceed the 5s vitest default
    // under parallel `turbo test` CI load (a ceiling, not a wait). Give headroom so they aren't
    // flaky — same rationale as apps/setup (commit 0fe9aea).
    testTimeout: 30000,
  },
});
