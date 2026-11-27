/**
 * A tab whose session is gone stops asking and goes back through the edge's sign-in wall.
 *
 * 2026-11-23: one browser's session ended with cardtable open, and the tab sent 45k refused requests
 * in 22 hours, two sockets retrying every few seconds and every poller polling on, while its player
 * saw a page that did nothing. The page's session watch (`packages/ui-shell/src/session`) checks a
 * suspicion with one probe; the edge's 401 there stops every socket and request and reloads the page,
 * which the wall answers with a new guest account.
 *
 * Both tests sit behind the stand-in edge's own gate (`EDGE_GATE_COOKIE`, `edge.ts`'s `edgeGate`), and
 * lose the session the way that browser did: the cookie goes, and the sockets drop (a deploy's restart),
 * so every reconnect meets the edge's 401.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { RELOADED_KEY } from '../packages/ui-shell/src/session/index.ts';
import { EDGE_GATE_COOKIE, EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

// One test's dropped sockets are every gated browser's: the two never run at once.
test.describe.configure({ mode: 'serial' });

interface Sent {
  at: number;
  what: string;
}

/** Carol's lobby behind the edge's gate, with every request and socket under the prefix it sends. */
async function openBehindTheGate(browser: Browser): Promise<{ context: BrowserContext; page: Page; sent: Sent[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/' },
    { name: EDGE_GATE_COOKIE, value: '1', domain: '127.0.0.1', path: '/' },
  ]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  const sent: Sent[] = [];
  const note = (kind: string, url: string): void => {
    const { pathname } = new URL(url);
    if (pathname.startsWith(`${PREFIX}/`)) sent.push({ at: Date.now(), what: `${kind} ${pathname}` });
  };
  page.on('request', (req) => note(req.method(), req.url()));
  page.on('websocket', (ws) => note('WS', ws.url()));
  await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  await expect(page.getByTestId('lobby')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => sent.filter((s) => s.what.startsWith('WS')).length, { message: 'the lobby opens its sockets', timeout: 30_000 }).toBeGreaterThan(0);
  return { context, page, sent };
}

/** The session cookie goes, and the edge drops this browser's sockets. */
async function loseTheSession(context: BrowserContext): Promise<number> {
  await context.clearCookies({ name: SESSION_COOKIE });
  const res = await context.request.post(`${EDGE_ORIGIN}/__e2e/drop-gated-sockets`);
  const { dropped } = (await res.json()) as { dropped: number };
  expect(dropped, 'the browser had sockets open to drop').toBeGreaterThan(0);
  return Date.now();
}

/** Milliseconds since the page last sent anything under the prefix. */
const quietFor = (sent: Sent[]): number => Date.now() - (sent.at(-1)?.at ?? 0);

test('a lost session that this tab already reloaded for: every socket and request stops, and nothing more leaves the page', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const { context, page, sent } = await openBehindTheGate(browser);
  try {
    // As if this tab had just reloaded for a lost session: the watch stays stopped instead of reloading.
    await page.evaluate((key) => sessionStorage.setItem(key, String(Date.now())), RELOADED_KEY);
    let loads = 0;
    page.on('load', () => (loads += 1));
    const from = sent.length;
    const t0 = await loseTheSession(context);
    await expect.poll(() => quietFor(sent), { message: 'nothing leaves the page for 8 s', timeout: 45_000, intervals: [500] }).toBeGreaterThanOrEqual(8_000);
    const after = sent.slice(from);
    console.log(`[session-lost] after the loss, ${after.length} sent in ${Date.now() - t0} ms: ${after.map((s) => `+${s.at - t0} ${s.what}`).join(', ')}`);
    expect(after.map((s) => s.what), 'one probe confirmed it').toContain(`GET ${PREFIX}/api/whoami`);
    expect(after.length, 'a handful of reconnects before the probe answered, not a retry loop').toBeLessThanOrEqual(12);
    expect(loads, 'no reload inside the guard').toBe(0);
  } finally {
    await context.close();
  }
});

test('a lost session reloads the page through the sign-in wall, and it comes back as a new guest', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const { context, page, sent } = await openBehindTheGate(browser);
  try {
    const reloaded = page.waitForEvent('load', { timeout: 30_000 });
    const t0 = await loseTheSession(context);
    await reloaded;
    console.log(`[session-lost] reloaded after ${Date.now() - t0} ms`);
    await expect(page.getByTestId('lobby'), 'the page draws again').toBeVisible({ timeout: 30_000 });
    const who = await context.request.get(`${EDGE_ORIGIN}${PREFIX}/api/whoami`);
    expect(who.status()).toBe(200);
    expect(((await who.json()) as { userId: string }).userId, 'the wall made this browser a new guest').toMatch(/^e2e-guest-\d+-id$/);
    await expect.poll(() => sent.filter((s) => s.at > t0 && s.what.startsWith('WS')).length, { message: 'the new page opens its sockets', timeout: 30_000 }).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
