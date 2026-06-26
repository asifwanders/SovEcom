module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: {
    // Same transpile-to-CommonJS setup as the integration config: booting the
    // full AppModule pulls in AuthModule -> the otplib shim, whose ESM-only `.js`
    // deps must be downlevelled for the CommonJS jest runtime.
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
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  // AppModule -> AuthModule needs MASTER_KEY/JWT_SECRET at boot.
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleNameMapper: {
    '^@sovecom/module-sdk$': '<rootDir>/../../packages/module-sdk/src/index.ts',
    '^@sovecom/theme-sdk$': '<rootDir>/../../packages/theme-sdk/src/index.ts',
    // `@sovecom/module-sdk` source uses NodeNext-style `.js`-suffixed relative
    // imports (e.g. `./module.js` -> `module.ts`); Jest's CommonJS resolver does
    // not rewrite the extension, so strip `.js` from relative specifiers so it
    // finds the `.ts` source. api's own source uses extensionless relative
    // imports, so this is a no-op for it.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // otplib v13 dropped the v12 `authenticator` singleton — route to our shim.
    '^otplib$': '<rootDir>/src/auth/two-factor/otplib.shim.ts',
  },
};
