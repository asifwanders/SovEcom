module.exports = {
  // Reuses the e2e ts-jest pipeline (otplib shim + ESM downlevel) because booting the
  // full AppModule to emit the OpenAPI spec pulls in otplib/meilisearch (ESM-only), which
  // plain ts-node cannot load.
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/tools/openapi-dump\\.e2e-spec\\.ts$',
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
    '/node_modules/(?!.*(meilisearch|otplib|@otplib|@scure|scure|@noble|noble))',
  ],
  testEnvironment: 'node',
  // AppModule -> AuthModule needs MASTER_KEY/JWT_SECRET at construction time.
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleNameMapper: {
    '^@sovecom/module-sdk$': '<rootDir>/../../packages/module-sdk/src/index.ts',
    '^@sovecom/theme-sdk$': '<rootDir>/../../packages/theme-sdk/src/index.ts',
    // `@sovecom/module-sdk` source uses NodeNext-style `.js`-suffixed relative
    // imports; Jest's CommonJS resolver does not rewrite the extension, so strip
    // `.js` from relative specifiers so it finds the `.ts` source. api's own
    // source uses extensionless relative imports, so this is a no-op for it.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^otplib$': '<rootDir>/src/auth/two-factor/otplib.shim.ts',
  },
};
