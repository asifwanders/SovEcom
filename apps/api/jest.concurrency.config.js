/**
 * Concurrency tests — race/no-data-loss suites that
 * exercise real Postgres / Redis. Kept in their OWN config + CI job so the
 * flake-prone races are isolated from the main integration job and show as a
 * separate, merge-blocking check.
 *
 * Mirrors jest.integration.config.js (same transforms, ESM carve-outs, setup-env,
 * serial workers) but matches only `test/concurrency/**`.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/test/concurrency/**/*.test.ts'],
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: { module: 'commonjs', esModuleInterop: true, allowJs: true },
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!.*(meilisearch|otplib|@otplib|@scure|scure|@noble|noble|@aws-sdk|@smithy))',
  ],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 60000,
  // Serial: these suites share ONE database and TRUNCATE globally between tests,
  // so parallel workers would wipe each other's fixtures mid-test.
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
    '^otplib$': '<rootDir>/src/auth/two-factor/otplib.shim.ts',
  },
};
