/** Shared ESLint config for SovEcom (legacy eslintrc format). */
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, es2022: true },
  rules: {
    // Allow intentionally-unused identifiers prefixed with `_` (e.g. compile-time
    // type-assertion vars, ignored callback args).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // Test files legitimately use `any` for partial mocks, captured payloads,
      // and runtime introspection casts.
      files: ['**/*.spec.ts', '**/*.int-spec.ts', '**/test/**/*.ts'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', '.next/', '*.config.js', '*.config.ts', '*.d.ts'],
};
