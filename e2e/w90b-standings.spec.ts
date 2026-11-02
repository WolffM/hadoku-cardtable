/**
 * Wave 90 lane B, standings — measured by the tracker: at 1440 the hub's standings table cuts its
 * last header ("Medi… Gam…"); at 390 its columns run off the card (shot 149, "Oppor…").
 *
 * Cause (`PodStandings.css`): seven columns (#, Player, Points, four spelled-out tiebreak headers)
 * never fit the standings card's own width (`PodScreen.css`'s `.pod__board`,
 * `minmax(280px, 420px)`), and nothing gave the table's own box a scroll — its content just
 * overflowed the card, uncontained.
 *
 * A Gauntlet tournament of two humans + two AI, round 1 paired: at 1440 every `th` shows in full
 * (`scrollWidth ≤ clientWidth`); at 390 the table scrolls sideways inside its own wrap
 * (`pod-standings-wrap`), the player column stays put while it does, and the page itself never
 * scrolls. Needs a Forge build (the Gauntlet's eras come from its decks); without one the test
 * SKIPS with a title that says why. `[w90b-standings]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { SESSION_COOKIE } from './identities.ts';
import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;

interface StandingsMeasure {
  found: boolean;
  headers: { text: string; scrollWidth: number; clientWidth: number }[];
  wrapScrollWidth: number;
  wrapClientWidth: number;
  pageScrollWidth: number;
  pageClientWidth: number;
}

async function measureStandings(page: Page): Promise<StandingsMeasure> {
  return page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>('[data-testid="pod-standings-wrap"]');
    const table = document.querySelector<HTMLTableElement>('[data-testid="pod-standings"]');
    const doc = document.scrollingElement ?? document.documentElement;
    if (table === null) {
      return { found: false, headers: [], wrapScrollWidth: 0, wrapClientWidth: 0, pageScrollWidth: doc.scrollWidth, pageClientWidth: doc.clientWidth };
    }
    // The wrap (`pod-standings-wrap`) is the fix's own box; its own width is reported as 0 (and
    // every header check below still runs) when it does not exist yet, so a RED run still shows
    // whether the headers themselves are cut, not only whether the wrap is missing.
    const headers = Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((th) => ({ text: (th.textContent ?? '').trim(), scrollWidth: th.scrollWidth, clientWidth: th.clientWidth }));
    return { found: true, headers, wrapScrollWidth: wrap?.scrollWidth ?? 0, wrapClientWidth: wrap?.clientWidth ?? 0, pageScrollWidth: doc.scrollWidth, pageClientWidth: doc.clientWidth };
  });
}

/** Scrolls the standings wrap fully right, reads the player column's own left edge before and after, then puts the scroll back. Before the fix there is no wrap at all: `maxScroll` reads `-1` rather than throwing. */
async function playerColumnStaysPinned(page: Page): Promise<{ maxScroll: number; before: number; after: number }> {
  return page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>('[data-testid="pod-standings-wrap"]');
    const cell = document.querySelector<HTMLElement>('[data-testid="pod-standings"] tbody tr:first-child td:nth-child(2)');
    if (wrap === null || cell === null) return { maxScroll: -1, before: -1, after: -1 };
    const prev = wrap.scrollLeft;
    const before = cell.getBoundingClientRect().left;
    const maxScroll = wrap.scrollWidth - wrap.clientWidth;
    wrap.scrollLeft = wrap.scrollWidth;
    const after = cell.getBoundingClientRect().left;
    wrap.scrollLeft = prev;
    return { maxScroll, before, after };
  });
}

test(titled('a tournament hub’s standings table: every header shows in full at 1440, and scrolls sideways inside its own box at phone width with the player column pinned and the page still'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  try {
    await resizeWindow(alice.page, { width: 1440, height: 900 });
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const api = async <T>(method: 'POST' | 'PATCH', path: string, data?: unknown): Promise<{ status: number; body: T }> => {
      const res = await alice.context.request.fetch(`${stack.origin}${PREFIX}/api${path}`, { method, data: data ?? {} });
      return { status: res.status(), body: (await res.json()) as T };
    };
    const created = await api<{ id: string }>('POST', '/rooms', { name: `e2e w90b standings ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    expect((await api('PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } })).status).toBe(200);
    expect((await api('POST', `/rooms/${roomId}/pod/sit`, { seat: 0 })).status).toBe(200);
    // A second human (never opens a page) keeps round 1's pairing deterministic: seats
    // [alice, bob, AI, AI] always pair alice-vs-AI and bob-vs-AI (`@hadoku/draft`'s `round1`, seat
    // `i` against `i + half`) — never AI-vs-AI, which would settle on the spot with no table.
    const bob = await alice.context.browser()?.newContext();
    if (bob === undefined) throw new Error('could not open a second context for bob');
    await bob.addCookies([{ name: SESSION_COOKIE, value: 'bob', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
    for (const [path, data] of [
      ['join', {}],
      ['pod/sit', { seat: 1 }],
      ['ready', { ready: true }],
    ] as const) {
      const res = await bob.request.post(`${stack.origin}${PREFIX}/api/rooms/${roomId}/${path}`, { data });
      expect(res.status(), `bob: ${path}`).toBe(200);
    }
    for (const seat of [2, 3]) expect((await api('POST', `/rooms/${roomId}/pod/ai`, { seat, on: true })).status).toBe(200);

    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(alice.page.getByTestId('pod-seat-3'), 'the lobby seats the second AI').toHaveAttribute('data-ai', '', { timeout: UI_TIMEOUT });
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('table-page'), 'paired: carried to my table').toBeVisible({ timeout: UI_TIMEOUT });
    await alice.page.getByTestId('table-hub').click();
    await expect(alice.page.getByTestId('pod-rounds'), 'the hub').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('pod-standings'), 'standings for round 1').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId(/^pod-standings-row-\d+$/)).toHaveCount(4);

    // 1440: every header shows in full.
    const at1440 = await measureStandings(alice.page);
    console.log(`[w90b-standings] 1440: page ${at1440.pageScrollWidth} vs ${at1440.pageClientWidth}; wrap ${at1440.wrapScrollWidth} vs ${at1440.wrapClientWidth}; ${JSON.stringify(at1440.headers)}`);
    expect(at1440.found, '1440: the standings table and its wrap are both there').toBe(true);
    const truncated1440 = at1440.headers.filter((h) => h.scrollWidth > h.clientWidth + 0.5);
    expect(truncated1440, `1440: headers cut off — ${JSON.stringify(truncated1440)}`).toEqual([]);
    expect(at1440.pageScrollWidth, '1440: the page itself does not scroll sideways').toBeLessThanOrEqual(at1440.pageClientWidth + 1);

    // 390: scrolls inside its own box, the page itself does not, and the player column stays put.
    await resizeWindow(alice.page, { width: 390, height: 844 });
    const at390 = await measureStandings(alice.page);
    console.log(`[w90b-standings] 390: wrap ${at390.wrapScrollWidth}x vs client ${at390.wrapClientWidth}; page ${at390.pageScrollWidth} vs ${at390.pageClientWidth}; headers ${JSON.stringify(at390.headers)}`);
    expect(at390.found, '390: the standings table and its wrap are both there').toBe(true);
    const truncated390 = at390.headers.filter((h) => h.scrollWidth > h.clientWidth + 0.5);
    expect(truncated390, `390: headers cut off — ${JSON.stringify(truncated390)}`).toEqual([]);
    expect(at390.pageScrollWidth, '390: the page itself does not scroll sideways').toBeLessThanOrEqual(at390.pageClientWidth + 1);

    const pin = await playerColumnStaysPinned(alice.page);
    console.log(`[w90b-standings] 390 pin check: maxScroll ${pin.maxScroll}, player column left ${pin.before} → ${pin.after}`);
    expect(pin.maxScroll, '390: there is something to scroll past (seven columns do not fit 390px)').toBeGreaterThan(0);
    expect(Math.abs(pin.after - pin.before), '390: the player column stayed at the same x while the wrap scrolled').toBeLessThanOrEqual(1);
  } finally {
    await alice.context.close();
    await stack.stop();
  }
});
