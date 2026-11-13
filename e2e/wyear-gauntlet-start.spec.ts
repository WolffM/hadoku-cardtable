/**
 * A Gauntlet room readied over the API never asks for a match during its ban/pick.
 *
 * A Gauntlet seat's Ready is its table seat's (`games/magic/server/src/http/routes.ts`'s `seated`), so the
 * table reads both players ready from the moment both seats ready, long before the Gauntlet deals.
 * The room screen starts a match off that readiness in every mode but the Gauntlet, and until its
 * room record lands it knew no mode at all: a page whose table read came back first asked
 * `POST /api/play/matches`, the server refused it (409), and the room showed Try again over the
 * ban/pick.
 *
 * Two pages left to the feed did it in 2 runs of 5: a feed ping dropped one page's first room read,
 * and its table read landed before the next. Here Alice's room record is held until the table her
 * page keeps says both seats are ready, so the order is the bad one every run. Then it lands; the
 * Gauntlet's board is drawn, and nothing asked for a match. No Forge: no match starts.
 * `[wyear-gauntlet-start]` lines are the evidence.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';
import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

interface Seat {
  context: BrowserContext;
  page: Page;
  call: <T>(method: 'GET' | 'POST', path: string, data?: unknown) => Promise<{ status: number; body: T }>;
}

async function send<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = method === 'GET' ? await request.get(`${EDGE_ORIGIN}${PREFIX}/api${path}`) : await request.post(`${EDGE_ORIGIN}${PREFIX}/api${path}`, { data: data ?? {} });
  return { status: res.status(), body: (await res.json()) as T };
}

async function seatFor(browser: Browser, name: string): Promise<Seat> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const page = await context.newPage();
  return { context, page, call: (method, path, data) => send(context.request, method, path, data) };
}

test('a Gauntlet readied over the API: a page that reads its table before its room asks for no match', async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await seatFor(browser, 'alice');
  const bob = await seatFor(browser, 'bob');
  try {
    await alice.page.goto(`${PREFIX}/`);
    const created = await alice.call<{ id: string }>('POST', '/rooms', {
      name: `e2e gauntlet start ${Date.now()}`,
      gameType: 'constructed-1v1',
      mode: 'gauntlet',
      modeOptions: { family: 'modern', year: 2012 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    expect((await bob.call('POST', `/rooms/${roomId}/join`)).status).toBe(200);
    for (const seat of [alice, bob]) expect((await seat.call('POST', `/tables/rooms/${roomId}/sit`)).status).toBe(200);

    const asked: string[] = [];
    alice.page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/play/matches')) asked.push(req.postData() ?? '');
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    await alice.page.route(
      (url) => url.pathname.endsWith(`/api/rooms/${roomId}`),
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        held += 1;
        await released;
        return route.fallback();
      },
    );
    // Her table reads in the order the page sent them. The page keeps only the newest one's answer
    // (`apps/ui/src/rooms/latest.ts`), so that is the one that must say both seats are ready.
    const tableReads: { request: Request; bothReady?: boolean }[] = [];
    const isTableRead = (request: Request): boolean => request.method() === 'GET' && new URL(request.url()).pathname.endsWith(`/api/tables/rooms/${roomId}`);
    alice.page.on('request', (request) => {
      if (isTableRead(request)) tableReads.push({ request });
    });
    alice.page.on('response', async (res) => {
      const read = tableReads.find((r) => r.request === res.request());
      if (read === undefined) return;
      const table = (await res.json()) as { players?: { ready?: boolean }[] };
      read.bothReady = table.players?.length === 2 && table.players.every((p) => p.ready === true);
    });

    await alice.page.goto(`${PREFIX}/#/room/${roomId}`);
    for (const seat of [alice, bob]) expect((await seat.call<GauntletView>('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true })).status).toBe(200);
    await expect.poll(() => tableReads.at(-1)?.bothReady, { timeout: 20_000, message: 'her newest table read answers with both seats ready' }).toBe(true);
    // Two frames and a task: the page has drawn that table and run what it does about it.
    await alice.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
    console.log(`[wyear-gauntlet-start] alice's table: ${tableReads.length} read(s), the newest with both seats ready; ${held} room read(s) held; asked so far ${JSON.stringify(asked)}`);
    release();

    // Her room record lands: the Gauntlet's own board is drawn, and it is the Gauntlet's to start.
    await expect(alice.page.getByTestId('gauntlet-pool').getByTestId('gauntlet-deck')).toHaveCount(10, { timeout: 20_000 });
    const phase = (await alice.call<GauntletView>('GET', `/tables/rooms/${roomId}/gauntlet`)).body.phase;
    console.log(`[wyear-gauntlet-start] gauntlet phase ${phase}; match asks ${JSON.stringify(asked)}`);
    expect(['reveal', 'banpick'], 'still before the Gauntlet deals').toContain(phase);
    expect(asked, 'nothing asked for a match before the Gauntlet dealt').toEqual([]);
    await expect(alice.page.getByTestId('start-retry')).toHaveCount(0);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
