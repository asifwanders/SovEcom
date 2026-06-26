module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // isolatedModules + commonjs + allowJs lets ts-jest downlevel the ESM-only
    // `.js` of otplib's base32 codec (`@scure/base`) that the two-factor unit
    // test pulls in. Mirrors the integration config's transpile-only approach.
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: { module: 'commonjs', esModuleInterop: true, allowJs: true },
      },
    ],
  },
  // otplib (TOTP) and its base32 codec `@scure/base` ship ESM-only; carve them
  // out of the node_modules ignore so Jest transforms them for the CommonJS unit
  // runtime (mirrors the meilisearch carve-out in jest.integration.config.js).
  // The substring match covers pnpm's `.pnpm/@scure+base@x` / `.pnpm/otplib@x`
  // layout as well as the flat `node_modules/@scure` form.
  transformIgnorePatterns: ['/node_modules/(?!.*(otplib|@otplib|@scure|scure|@noble|noble))'],
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    // rootDir is `src`, so reaching the repo's `packages/` needs three `..`
    // segments (apps/api/src -> apps/api -> apps -> <repo root>).
    '^@sovecom/module-sdk$': '<rootDir>/../../../packages/module-sdk/src/index.ts',
    '^@sovecom/theme-sdk$': '<rootDir>/../../../packages/theme-sdk/src/index.ts',
    // `@sovecom/module-sdk` source uses NodeNext-style `.js`-suffixed relative
    // imports (e.g. `./module.js` -> `module.ts`). tsc/nodenext resolves these to
    // the `.ts` source, but Jest's CommonJS resolver does not rewrite the
    // extension, so strip `.js` from relative specifiers to let it find the `.ts`.
    // api's own source uses extensionless relative imports, so this is a no-op for it.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // otplib v13 dropped the v12 `authenticator` singleton; route the bare
    // specifier to our compat shim (which wraps otplib v13's functional API) so
    // secret-gen and verification share one engine. The `otplib/functional`
    // subpath the shim imports is NOT matched by this anchored pattern.
    '^otplib$': '<rootDir>/auth/two-factor/otplib.shim.ts',
  },
};
