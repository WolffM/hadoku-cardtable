import { defineConfig } from 'vitest/config';

// Root config for the whole workspace. Individual packages may add their own
// vitest.config.ts; this one is what `pnpm test` runs from the repo root, and
// it deliberately passes with no tests so the gate is green on an empty tree.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'forge/**', '.claude/**'],
    passWithNoTests: true,
  },
});
