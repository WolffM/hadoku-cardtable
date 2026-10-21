/**
 * `playwright install` for exactly the browsers `playwright.config.ts`'s projects name, so CI
 * never runs a spec in a browser it did not install. Extra arguments pass through (`--dry-run`).
 * Idempotent: a browser already in `~/.cache/ms-playwright` is not downloaded again.
 */
import { execFileSync } from 'node:child_process';

import config from './playwright.config.ts';

const browsers = [...new Set((config.projects ?? []).map((project) => project.use?.browserName))];
if (browsers.length === 0 || browsers.some((name) => name === undefined)) {
  throw new Error(`every project in playwright.config.ts must name its browserName; found ${JSON.stringify(browsers)}`);
}
const args = ['install', ...(browsers as string[]), ...process.argv.slice(2)];
console.log(`playwright ${args.join(' ')}`);
execFileSync('playwright', args, { stdio: 'inherit' });
