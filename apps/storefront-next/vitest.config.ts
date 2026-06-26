import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // The Playwright E2E specs live in `e2e/` and also use the `*.spec.ts` suffix, but they import
    // `@playwright/test` (a different runner) and must NOT be collected by Vitest. Scope Vitest to
    // `src` and exclude the e2e tree explicitly.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', '.next', 'e2e/**'],
    // A few RSC/component specs legitimately run close to ~5s and intermittently exceed the 5s
    // vitest default under parallel `turbo test` CI load (a ceiling, not a wait). Give headroom
    // so they aren't flaky — same rationale as apps/setup (commit 0fe9aea).
    testTimeout: 30000,
    // next-intl's client navigation (`createNavigation`) is shipped as ESM that imports the bare
    // `next/navigation` specifier; inlining it lets Vitest transform it through this config's
    // resolver (with the `next/navigation` alias below) instead of choking on Next's package exports.
    server: {
      deps: {
        inline: ['next-intl'],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // next-intl imports `next/navigation` (no extension); Vitest can't resolve it from next-intl's
      // own node_modules, so point both Next navigation surfaces at the package's real entry files.
      'next/navigation': path.resolve(__dirname, './node_modules/next/navigation.js'),
      // @sovecom/client-js is source-first (package `main` → src/index.ts). Point Vitest at the
      // source entry so it resolves the workspace package the same way Next's transpilePackages
      // does, with no build step. Mirrors next.config.js transpilePackages.
      '@sovecom/client-js': path.resolve(__dirname, '../../packages/client-js/src/index.ts'),
      // `server-only` (the build-time client-import guard on the server-only `themes/active-theme.ts`)
      // resolves to its THROWING `browser` entry under Vitest's jsdom — but a unit test rendering an
      // RSC is the SERVER context, not a client bundle. Alias it to the package's own empty (server)
      // entry so the guard is the no-op it is on the server, while it still trips a real client build.
      'server-only': path.resolve(__dirname, './node_modules/server-only/empty.js'),
    },
  },
});
