import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';

/**
 * Flat config, matching the hadoku ecosystem's shared shape (watchparty,
 * aggregator, contact-ui, jobplatform, task) so `pnpm lint` means the same
 * thing here as it does there.
 *
 * Deliberately UNTYPED for now: type-aware rules need a `project` per package,
 * and this repo has no package tsconfigs yet (the workspace is empty). Adding
 * `parserOptions.project` before those exist makes eslint crash the moment the
 * first source file lands. Turn typed rules on per-package as each one gets a
 * tsconfig — that is a real change, not a formatting one.
 */
export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      // Vendored Forge: a 392k-line GPL Java tree with a handful of stray JS.
      // Never ours to lint, and its per-file copyright headers stay untouched.
      'forge/**',
      // Agent worktrees live INSIDE the repo, so `eslint .` walks them and
      // reports every finding twice — once against the real file and once
      // against a copy on some other branch, at line numbers matching neither.
      '.claude/**',
    ],
  },

  // ── Root tooling: eslint.config.js, vitest.config.ts ────────────────
  {
    files: ['*.js', '*.mjs', '*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: globals.node,
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs['recommended'].rules,
      'no-undef': 'off', // tsc covers this; eslint cannot see ambient TS types
      'no-console': 'off',
    },
  },

  // ── Server + shared packages (node) ─────────────────────────────────
  {
    files: ['apps/server/src/**/*.ts', 'packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: globals.node,
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs['recommended'].rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: false }],
      // `== null` is the idiomatic null-OR-undefined check; forcing === would
      // change behaviour at every one of these sites.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': 'off',
      'no-undef': 'off', // tsc covers this
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },

  // ── UI (browser) ────────────────────────────────────────────────────
  {
    files: ['apps/ui/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      // `globals.browser` ships keys with stray whitespace, which eslint
      // rejects outright. Same filter as watchparty.
      globals: Object.fromEntries(
        Object.entries(globals.browser).filter(([k]) => k.trim() === k),
      ),
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs['recommended'].rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },

  // ── Tests and harness scripts (relaxed) ─────────────────────────────
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/__tests__/**/*.{ts,tsx}',
      '**/test/**/*.{ts,tsx}',
      'scripts/**/*.{ts,js,mjs,cjs}',
      'e2e/**/*.ts',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs['recommended'].rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },

  prettierConfig,
];
