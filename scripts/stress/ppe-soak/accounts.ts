/*
 * The soak's players: real guest accounts made the way a visitor's are, by a
 * signed-out browser arriving at PPE's door (hadoku_site's edge signs it up as
 * "Player NNNNN"), and deleted through the account's own route afterwards.
 *
 *   node scripts/stress/ppe-soak/accounts.ts mint <n> <file>
 *   node scripts/stress/ppe-soak/accounts.ts delete <file>
 *
 * The edge's sign-up throttle is 5 a minute per IP and an arrival spends 2 of it,
 * so one account is made every 31 s (the member battletest's own pacing), and a
 * 429 waits a minute and tries again. The file holds session cookies: it lives
 * under ~/.cache, never in the repo.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { ORIGIN, PPE_DOOR, UA, type Account } from '../../../games/magic/server/src/play/monkey/soak/edge.ts';

const require = createRequire(fileURLToPath(new URL('../../../e2e/package.json', import.meta.url)));
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');

const PACE_MS = 31_000;

async function mint(n: number, file: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const made: Account[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const started = Date.now();
      for (let attempt = 0; ; attempt++) {
        const context = await browser.newContext({ userAgent: UA });
        try {
          const page = await context.newPage();
          await page.goto(PPE_DOOR);
          await page.waitForFunction(() => !document.getElementById('auth-form'), null, { timeout: 45_000 });
          const session = (await context.cookies(ORIGIN)).find((c) => c.name === 'hadoku_session')?.value;
          const me = (await page.evaluate(async () => (await fetch('/session/whoami')).json())) as { valid?: boolean; name?: string; userId?: string };
          if (session === undefined || me.valid !== true || me.userId === undefined) throw new Error(`no account: ${JSON.stringify(me)}`);
          made.push({ name: String(me.name), userId: me.userId, session });
          writeFileSync(file, JSON.stringify(made, null, 1), { mode: 0o600 });
          console.log(`made ${String(me.name)} (${String(made.length)}/${String(n)})`);
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          console.log(`arrival failed (${(err as Error).message.slice(0, 120)}); waiting out the throttle`);
          await new Promise((r) => setTimeout(r, 61_000));
        } finally {
          await context.close();
        }
      }
      const wait = PACE_MS - (Date.now() - started);
      if (i < n - 1 && wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  } finally {
    await browser.close();
  }
}

async function remove(file: string): Promise<void> {
  const accounts = JSON.parse(readFileSync(file, 'utf8')) as Account[];
  for (const a of accounts) {
    const res = await fetch(`${ORIGIN}/session/account/delete`, {
      method: 'POST',
      headers: { cookie: `hadoku_session=${a.session}`, 'user-agent': UA, 'content-type': 'application/json', origin: ORIGIN },
      body: '{}',
    });
    console.log(`delete ${a.name}: ${String(res.status)}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'mint') await mint(Number(rest[0]), String(rest[1]));
else if (cmd === 'delete') await remove(String(rest[0]));
else {
  console.error('usage: accounts.ts mint <n> <file> | delete <file>');
  process.exit(2);
}
