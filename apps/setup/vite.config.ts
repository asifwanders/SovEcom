import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * setup-SPA E2E (scenario 1, fresh-install). The wizard calls the
 * API from the browser. To avoid a core CORS change (CORS only allows the admin/store
 * origins, never the setup origin), the E2E builds the SPA with `VITE_API_BASE_URL=""` so it
 * hits `/setup/v1/*` + `/health` RELATIVE, then `vite preview` proxies those SAME-ORIGIN to
 * the API on :3000. `SETUP_API_TARGET` overrides the target (CI passes the API host).
 */
const apiTarget = process.env.SETUP_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Match the preview proxy: with VITE_API_BASE_URL="" the SPA hits /setup/v1/* + /health
      // relative, so the dev server must forward them same-origin to the API too (otherwise the
      // wizard's status/token calls 404 in `vite dev`).
      '/setup': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
    },
  },
  // `vite preview` serves the built SPA (the E2E harness previews on :4174). With the API
  // base baked in as "" the SPA's calls are relative, so the preview server must forward the
  // API surface it touches (`/setup/v1/*` and the `/health` boot check) to the real API —
  // same-origin, so the browser never makes a cross-origin (CORS-gated) request.
  preview: {
    port: 4174,
    proxy: {
      '/setup': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
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
    // import `@playwright/test` — scope vitest to `src` and exclude the e2e tree (mirrors admin).
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'e2e/**'],
    // The 11-step full-flow happy-path spec legitimately runs ~5s and intermittently exceeds the
    // 5s vitest default under parallel `turbo test` CI load (a ceiling, not a wait — fast tests
    // are unaffected). Give it headroom so it's not flaky on CI.
    testTimeout: 30000,
  },
});
