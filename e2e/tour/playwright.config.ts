/**
 * The mobile screenshot tour — a review aid, never a test gate: `*.tour.ts` (not `*.spec.ts`, so the main
 * config never picks it up). Each test boots its own play stack; run one at a time.
 *
 *   npx playwright test --config e2e/tour/playwright.config.ts -g shell
 */
import { defineConfig } from '@playwright/test';

/**
 * `TOUR_ENGINE` (chromium, webkit, firefox) picks the browser; chromium by default. A host without WebKit's
 * libraries runs it from Playwright's own image and connects (`PW_TEST_CONNECT_WS_ENDPOINT`).
 */
const ENGINE = process.env.TOUR_ENGINE ?? 'chromium';
if (ENGINE !== 'chromium' && ENGINE !== 'webkit' && ENGINE !== 'firefox') throw new Error(`tour: TOUR_ENGINE ${ENGINE} is not chromium, webkit or firefox`);

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
  use: { browserName: ENGINE, headless: true, actionTimeout: 15_000, navigationTimeout: 30_000 },
});
