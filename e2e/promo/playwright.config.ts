/**
 * Trailer footage, never a test gate: `*.promo.ts` (not `*.spec.ts`, so the main config's glob never
 * picks these up). Each driver starts its own play stack and films through `rig.ts`. Run one at a time —
 * every clip boots Forge and an Xvfb display.
 *
 *   npx playwright test --config e2e/promo/playwright.config.ts valakut
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.promo.ts',
  outputDir: '../.run/promo/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, actionTimeout: 20_000, navigationTimeout: 20_000 },
});
