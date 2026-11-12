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
/** A line of JSX text that starts with `//` or `/*`: a comment written between tags, which renders as text. */
const JSX_COMMENT_TEXT = {
  selector: 'JSXText[value=/(^|\\n)\\s*(\\/\\/|\\/\\*)/]',
  message: 'This renders as text on the page. Write a comment between tags as {/* ... */}.',
};

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
    files: ['apps/server/src/**/*.ts', 'packages/*/src/**/*.ts', 'games/*/packages/*/src/**/*.ts'],
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

  // ── Architecture rules, checked on the source rather than by tests that grep it ──
  {
    files: ['games/magic/packages/forge-wire/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!zod$|vitest$|@hadoku/|node:|\\.\\.?/)',
              message: 'forge-wire imports only zod, @hadoku/*, node: and its own siblings.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/(^|\\/)forge\\//]',
          message: 'Nothing in forge-wire reaches into the vendored Forge tree; CI does not even fetch it.',
        },
      ],
    },
  },
  {
    files: ['apps/ui/src/draft/socket.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@hadoku/draft'],
          patterns: [{ regex: '^\\./live(\\.ts)?$', message: 'The socket source is a third source, not a wrapper of the in-process one.' }],
        },
      ],
    },
  },
  {
    // A `//` line between JSX tags is not a comment: it renders, as text, on the page. 7fdeea9d9
    // wrapped the stats popout's root in <OverPage> and its comment line became the popout's first line.
    files: ['apps/ui/src/**/*.tsx'],
    rules: { 'no-restricted-syntax': ['error', JSX_COMMENT_TEXT] },
  },
  {
    files: ['apps/ui/src/play/live/LiveBoard.tsx'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'react-dom', importNames: ['createPortal'] }] }],
      'no-restricted-syntax': [
        'error',
        { selector: 'JSXAttribute[name.name=/^onPointer(Down|Move|Up)$/]', message: "Pointer handling is ./gestures/'s; LiveBoard only installs it." },
        {
          selector: "CallExpression[callee.property.name='addEventListener'][arguments.0.value=/^pointer(move|up)$/]",
          message: "Pointer handling is ./gestures/'s; LiveBoard only installs it.",
        },
        {
          selector: "Property[key.name='motion'] Identifier[name='fastMode']",
          message: 'Motion is the reduced-motion setting, never Fast Mode.',
        },
        // Flat config replaces this rule's list per file rather than merging it, so the UI-wide one is repeated here.
        JSX_COMMENT_TEXT,
      ],
    },
  },

  {
    files: ['e2e/**/*.ts'],
    ignores: ['e2e/play/board.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='setViewportSize']",
          message: "Resize with resizeWindow (e2e/play/board.ts): it waits until the board has measured the new window, so a read after it never sees the old window's card size.",
        },
        {
          selector: "MemberExpression[computed=true][object.type='AwaitExpression'][object.argument.callee.name='offered']",
          message: 'Pick an offered card by name with offeredCard (e2e/play/board.ts): Forge also offers every untapped land at priority, so a position is not the card a spec means.',
        },
        {
          selector: "VariableDeclarator[id.type='ArrayPattern'][init.type='AwaitExpression'][init.argument.callee.name='offered']",
          message: 'Pick an offered card by name with offeredCard (e2e/play/board.ts): Forge also offers every untapped land at priority, so a position is not the card a spec means.',
        },
      ],
    },
  },

  // ── Unit tests: wait on state, assert behaviour ──────────────────────
  {
    files: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'games/*/packages/*/src/**/*.test.ts'],
    ignores: [
      '**/*.jvm.test.ts',
      // Files that still sleep on a wall clock, to be emptied rather than grown.
      'apps/server/src/index.test.ts',
      'apps/server/src/http/tables.test.ts',
      'apps/server/src/play/host.test.ts',
      'apps/server/src/play/socket.test.ts',
      'apps/server/src/room/watching.test.ts',
      'apps/server/src/room/lobby.test.ts',
      'apps/server/src/room/socket.test.ts',
      'apps/ui/src/play/live/LiveBoard.test.ts',
      'apps/ui/src/play/live/art-preload.test.ts',
      'apps/ui/src/play/live/gestures/gestures.test.ts',
      'apps/ui/src/play/live/placed.test.ts',
      'apps/ui/src/play/live/presence.test.ts',
      'packages/room-ask/src/registry.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout']",
          message: 'A test waits on state (vi.waitFor, findBy*, an awaited event) or advances fake timers; it never sleeps.',
        },
        {
          selector: "CallExpression[callee.property.name=/^(toBe|toEqual)$/] > Literal[value=/calc\\(|var\\(--/]",
          message: 'A stylesheet formula is not a behaviour: read the cascade on a rendered element and assert a keyword or a relation.',
        },
      ],
    },
  },

  prettierConfig,
];
