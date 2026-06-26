const createNextIntlPlugin = require('next-intl/plugin');

// Point the plugin at the next-intl request config. The plugin only WRAPS the
// returned config object below — it adds the i18n request hook and leaves the existing
// `transpilePackages` + custom `webpack(extensionAlias)` (source-first @sovecom/client-js resolution)
// fully intact (they're composed, not replaced).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  images: {
    unoptimized: true,
  },
  // @sovecom/client-js is source-first (package `main` → src/index.ts, TS, no build step),
  // so Next must transpile it through its own pipeline. It has no transitive WORKSPACE
  // runtime deps, so this single entry is sufficient.
  transpilePackages: ['@sovecom/client-js'],
  // client-js's source uses NodeNext-style `.js` import specifiers that actually point at `.ts`
  // files (e.g. `export … from './client.js'`). webpack must be told a `.js` request may resolve
  // to a `.ts`/`.tsx` source, or transpiling the source-first package fails with "Can't resolve
  // './client.js'". This mirrors Vite's built-in `.js`→`.ts` resolution used by the Vitest config.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

module.exports = withNextIntl(nextConfig);
