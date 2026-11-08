/*
 * The wildcard's tournament page (the operator, 2026-11-08): while a finished tournament holds the
 * front page's seat (`GET /api/tournaments/featured`), the wildcard always opens on its top three,
 * whatever the draw would have picked; with nobody in the seat there is no such page.
 *
 * The seated tournament is served by the test (the seat rule itself is `featured-tournament.test.ts`);
 * the empty case reads the real server's answer. `[front-podium]` lines are the evidence.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const row = (id: string, rank: number, matchPoints: number) => ({ id, matchPoints, opponentMatchWinPct: 0, gameWinPct: 0, opponentGameWinPct: 0, medianGameMs: null, rank, decidedBy: null });

const SEATED = {
  id: 'room-1-1',
  name: 'Friday Cube Night',
  startedAt: Date.now() - 4 * 3_600_000,
  endedAt: Date.now() - 3_600_000,
  closed: false,
  rounds: 2,
  names: { a: 'Ari', b: 'Bo', c: 'Cy', d: 'Di' },
  faces: {},
  standings: [row('a', 1, 6), row('b', 2, 3), row('c', 3, 3), row('d', 4, 0)],
  results: [
    { round: 1, playerA: 'a', playerB: 'd', gamesA: 2, gamesB: 0 },
    { round: 1, playerA: 'b', playerB: 'c', gamesA: 2, gamesB: 1 },
    { round: 2, playerA: 'a', playerB: 'b', gamesA: 2, gamesB: 1 },
    { round: 2, playerA: 'c', playerB: 'd', gamesA: 2, gamesB: 0 },
  ],
};

async function open(browser: Browser, seated: typeof SEATED | null): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  if (seated !== null) await context.route('**/api/tournaments/featured', (route) => route.fulfill({ json: { tournament: seated } }));
  // The draw would open on the last kind there is: only the pin puts the tournament first.
  await context.addInitScript(() => {
    Math.random = () => 0.999;
  });
  const page = await context.newPage();
  await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  await expect(page.locator('[data-reveal="wildcard"]')).toHaveAttribute('data-phase', 'shown', { timeout: 30_000 });
  return page;
}

test('a seated tournament is the page the wildcard opens on: its top three, second-first-third, and its standings', async ({ browser }) => {
  const page = await open(browser, SEATED);
  await expect(page.getByTestId('front-wildcard-page')).toHaveAttribute('data-page', 'tournament');
  const podium = page.getByTestId('front-podium');
  await expect(podium).toContainText('Friday Cube Night');
  await expect(podium.locator('.front-podium__meta')).toHaveText('4 players');
  const places = await Promise.all(
    ([1, 2, 3] as const).map(async (place) => {
      const stand = page.getByTestId(`front-podium-${String(place)}`);
      return { place, text: (await stand.innerText()).replace(/\s+/g, ' '), x: (await stand.boundingBox())?.x ?? NaN };
    }),
  );
  console.log(`[front-podium] ${JSON.stringify(places)}`);
  expect(places.map((p) => p.text)).toEqual([expect.stringContaining('Ari'), expect.stringContaining('Bo'), expect.stringContaining('Cy')]);
  expect(places[0]!.text).toContain('2–0');
  expect(places[0]!.text).not.toContain('pts');
  // Left to right: second, first, third.
  expect(places[1]!.x).toBeLessThan(places[0]!.x);
  expect(places[0]!.x).toBeLessThan(places[2]!.x);
  await expect(page.getByTestId('front-wildcard-action')).toHaveText('Full standings');
  await page.getByTestId('front-wildcard-action').click();
  await expect(page).toHaveURL(/#\/tournaments$/);
});

test('with nobody in the seat, the wildcard has no tournament page', async ({ browser }) => {
  const page = await open(browser, null);
  const answer = await page.evaluate(async (url) => (await fetch(url, { credentials: 'same-origin' })).json(), `${EDGE_ORIGIN}${PREFIX}/api/tournaments/featured`);
  console.log(`[front-podium] the server's own answer: ${JSON.stringify(answer)}`);
  expect(answer).toEqual({ tournament: null });
  await expect(page.locator('[data-testid="front-wildcard-dot"][data-page="tournament"]')).toHaveCount(0);
  await expect(page.getByTestId('front-wildcard-page')).not.toHaveAttribute('data-page', 'tournament');
});
