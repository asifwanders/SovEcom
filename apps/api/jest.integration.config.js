/**
 * Integration tests — exercise real Postgres / Redis / Meilisearch.
 * Run via `pnpm test:integration` with DATABASE_URL / REDIS_URL / MEILISEARCH_URL
 * pointing at running services (CI service containers, or docker-compose.dev locally).
 * Kept separate from the unit config so `pnpm test` stays green without Docker.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
  transform: {
    // Compile tests + sources to CommonJS for Jest. isolatedModules: transpile-only
    // (Drizzle's query-builder types misbehave under nodenext but run fine).
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        isolatedModules: true,
        // allowJs so the auth integration suite can downlevel otplib's ESM-only
        // `.js` deps (`@scure/base`, `@noble/hashes`) it pulls in for TOTP.
        tsconfig: { module: 'commonjs', esModuleInterop: true, allowJs: true },
      },
    ],
  },
  // meilisearch, otplib's TOTP deps (`@scure/base`, `@noble/hashes`), and AWS SDK
  // v3 packages (`@aws-sdk/*`, `@smithy/*`) ship ESM-only dist or use dynamic
  // imports; carve them out so Jest transforms them for the CommonJS test runtime.
  // The substring match covers pnpm's `.pnpm/<pkg>@x/node_modules/...` layout.
  transformIgnorePatterns: [
    '/node_modules/(?!.*(meilisearch|otplib|@otplib|@scure|scure|@noble|noble|@aws-sdk|@smithy))',
  ],
  testEnvironment: 'node',
  // Pin MASTER_KEY/JWT_SECRET/NODE_ENV before any suite boots AppModule (the
  // health suite boots it without plumbing auth env itself).
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 30000,
  // Serial: these suites share ONE database and some TRUNCATE globally between
  // tests, so parallel workers would wipe each other's fixtures mid-test.
  maxWorkers: 1,
  moduleNameMapper: {
    '^@sovecom/module-sdk$': '<rootDir>/../../packages/module-sdk/src/index.ts',
    '^@sovecom/theme-sdk$': '<rootDir>/../../packages/theme-sdk/src/index.ts',
    // `@sovecom/module-sdk` source uses NodeNext-style `.js`-suffixed relative
    // imports (e.g. `./module.js` -> `module.ts`); Jest's CommonJS resolver does
    // not rewrite the extension, so strip `.js` from relative specifiers so it
    // finds the `.ts` source. api's own source uses extensionless relative
    // imports, so this is a no-op for it.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Route the bare `otplib` specifier to our v12-compat shim (otplib v13
    // dropped the `authenticator` singleton). The `otplib/functional` subpath
    // the shim itself imports is NOT matched by this anchored pattern.
    '^otplib$': '<rootDir>/src/auth/two-factor/otplib.shim.ts',
  },
};
