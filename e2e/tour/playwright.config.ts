/**
 * The mobile screenshot tour — a review aid, never a test gate: `*.tour.ts` (not `*.spec.ts`, so the main
 * config never picks it up). Each test boots its own play stack; run one at a time.
 *
 *   npx playwright test --config e2e/tour/playwright.config.ts -g shell
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.tour.ts',
  outputDir: '../.run/tour/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, actionTimeout: 15_000, navigationTimeout: 30_000 },
});
