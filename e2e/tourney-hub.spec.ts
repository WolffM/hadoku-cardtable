/**
 * A tournament room's hub, repaired (the operator, 2026-11-02: *"the actual state of tournament rooms is
 * pretty awful"*), against the two seeded eight-player rooms (`room/testing-rooms.ts`) and a leader's own
 * tournament, on the plain harness (no Forge: a Gauntlet tournament locks on Ready, and nothing here
 * starts a game).
 *
 * - The finished room: the podium names the first three; the bracket has a column per round and a FINAL;
 *   no card is narrower than the bracket's width or overlaps another in its column, and no name on one is
 *   cut; a press on a player in the final column lights their path and dims the rest; the standings are
 *   rank, player, record and points, whole, at 1440 and at phone width, their tie-breakers one press
 *   away, and the page never scrolls sideways; nobody watching is named under the matches.
 * - The room mid-rounds: the live match is the way into its table, for a spectator too.
 * - A leader's tournament in its rounds: what the room plays, its event, its pool and its rules are all
 *   disabled — the server would refuse each (`roomLocks`).
 * - Reduced motion: the podium stands still.
 */
import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX } from './identities.ts';
import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';

const UI_TIMEOUT = 30_000;
const DONE = 'Testing: Tournament — finished (8 players)';
const MID = 'Testing: Tournament — round 2 of 3 (8 players)';

async function openSeeded(page: Page, name: string): Promise<void> {
  await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  const row = page.getByTestId('room-row').filter({ has: page.getByTestId('room-name').getByText(name, { exact: true }) });
  await expect(row, `${name} is listed for an admin`).toBeVisible({ timeout: UI_TIMEOUT });
  await row.getByTestId('room-enter').click();
  await page.waitForURL(/\/room\/r-[0-9a-f]{12}$/, { timeout: UI_TIMEOUT });
}

interface Geometry {
  cards: { x: number; y: number; w: number; h: number }[];
  cutNames: string[];
  overlaps: number;
  headers: string[];
  cutHeaders: string[];
  wrap: [number, number];
  page: [number, number];
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-testid="pod-tables-row"]')].map((el) => {
      const r = rect(el);
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    let overlaps = 0;
    for (const a of cards) for (const b of cards) if (a !== b && a.x === b.x && a.y < b.y && a.y + a.h > b.y) overlaps++;
    const cutNames = [...document.querySelectorAll<HTMLElement>('[data-testid="pod-tables"] .swiss__name')].filter((n) => n.scrollWidth > n.clientWidth + 0.5).map((n) => n.textContent ?? '');
    const ths = [...document.querySelectorAll<HTMLElement>('[data-testid="pod-standings"] thead th')];
    const wrap = document.querySelector<HTMLElement>('[data-testid="pod-standings-wrap"]')!;
    const doc = document.scrollingElement ?? document.documentElement;
    return {
      cards,
      cutNames,
      overlaps,
      headers: ths.map((th) => (th.textContent ?? '').trim()),
      cutHeaders: ths.filter((th) => th.scrollWidth > th.clientWidth + 0.5).map((th) => th.textContent ?? ''),
      wrap: [wrap.scrollWidth, wrap.clientWidth],
      page: [doc.scrollWidth, doc.clientWidth],
    };
  });
}

test('the finished room: podium, a Swiss bracket that never squishes, the path on a press, plain standings, at 1440 and phone width', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const admin = await openFriend(browser, 'admin');
  try {
    for (const width of [1440, 390]) {
      await resizeWindow(admin.page, { width, height: 900 });
      await openSeeded(admin.page, DONE);
      await expect(admin.page.getByTestId('pod-podium'), `${width}: the podium`).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(admin.page.getByTestId('pod-podium-1')).toContainText('3–0');
      await expect(admin.page.getByTestId('pod-bracket-round')).toHaveCount(3);
      await expect(admin.page.getByTestId('pod-bracket-final')).toHaveCount(1);
      await expect(admin.page.getByTestId('pod-final-row')).toHaveCount(8);
      await expect(admin.page.getByTestId('pod-tables-row')).toHaveCount(12);
      await expect(admin.page.getByTestId('pod-spectators'), 'nobody watching is named under the matches').toHaveCount(0);

      const g = await geometry(admin.page);
      console.log(`[tourney-hub] ${width}: cards ${JSON.stringify(g.cards.slice(0, 3))}… overlaps ${g.overlaps}; cut names ${JSON.stringify(g.cutNames)}; headers ${JSON.stringify(g.headers)}; wrap ${g.wrap}; page ${g.page}`);
      expect(Math.min(...g.cards.map((c) => c.w)), `${width}: no card squished`).toBeGreaterThanOrEqual(200);
      expect(g.overlaps, `${width}: no two cards of a column overlap`).toBe(0);
      expect(g.cutNames, `${width}: every name on a card whole`).toEqual([]);
      expect(g.headers, `${width}: the standings are rank, player, record, points`).toEqual(['#', 'Player', 'Record', 'Points']);
      expect(g.cutHeaders, `${width}: no header cut`).toEqual([]);
      expect(g.wrap[0], `${width}: the standings fit their box`).toBeLessThanOrEqual(g.wrap[1] + 1);
      expect(g.page[0], `${width}: the page never scrolls sideways`).toBeLessThanOrEqual(g.page[1] + 1);

      // The tie-breakers, one press away: their columns open inside the standings' own box.
      await admin.page.getByTestId('pod-standings-tiebreaks').click();
      await expect(admin.page.locator('[data-testid="pod-standings"] thead th')).toHaveCount(8);
      const open = await geometry(admin.page);
      expect(open.cutHeaders, `${width}: no tie-breaker header cut`).toEqual([]);
      expect(open.page[0], `${width}: opened, the page still never scrolls sideways`).toBeLessThanOrEqual(open.page[1] + 1);
      await admin.page.getByTestId('pod-standings-tiebreaks').click();
      await expect(admin.page.locator('[data-testid="pod-standings"] thead th')).toHaveCount(4);

      // A press on the last-placed player lights their path; the rest dim; a second press lets it go.
      const last = admin.page.locator('[data-testid="pod-final-row"][data-place="8"]');
      await last.scrollIntoViewIfNeeded();
      await last.click();
      await expect(last).toHaveAttribute('aria-pressed', 'true');
      await expect(admin.page.locator('[data-testid="pod-tables-row"]:not([data-dim])'), `${width}: their three matches stay lit`).toHaveCount(3);
      expect(await admin.page.locator('.swiss__edge[data-on]').count(), `${width}: their path is drawn`).toBe(3);
      await last.click();
      await expect(admin.page.locator('[data-testid="pod-tables-row"][data-dim]')).toHaveCount(0);
    }
  } finally {
    await admin.context.close();
  }
});

test('the room mid-rounds: the live match is the way into its table, for a spectator too', async ({ browser }) => {
  const admin = await openFriend(browser, 'admin');
  try {
    await openSeeded(admin.page, MID);
    await expect(admin.page.getByTestId('pod-round')).toHaveText('Round 2 of 3', { timeout: UI_TIMEOUT });
    await expect(admin.page.locator('[data-testid="pod-bracket-round"]').nth(2)).toHaveAttribute('data-state', 'next');
    await admin.page.getByTestId('pod-tables-watch').click();
    await expect(admin.page.getByTestId('table-page')).toBeVisible({ timeout: UI_TIMEOUT });
  } finally {
    await admin.context.close();
  }
});

test('a leader’s tournament in its rounds offers no control the server would refuse', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  try {
    const api = async <T>(method: 'POST' | 'PATCH', path: string, data?: unknown): Promise<{ status: number; body: T }> => {
      const res = await alice.context.request.fetch(`${EDGE_ORIGIN}${PREFIX}/api${path}`, { method, data: data ?? {} });
      return { status: res.status(), body: (await res.json()) as T };
    };
    const created = await api<{ id: string }>('POST', '/rooms', { name: `e2e tourney locks ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    // Tournament on carries the leader from the table into the pod's first seat (`#carryPlayers`).
    expect((await api('PATCH', `/rooms/${roomId}`, { settings: { tournament: true } })).status).toBe(200);
    // Three AI entrants: round 1 pairs me against one, live, and settles the other two at once, their card
    // drawn in my group just under mine.
    for (const seat of [1, 2, 3]) expect((await api('POST', `/rooms/${roomId}/pod/ai`, { seat, on: true })).status).toBe(200);
    expect((await api('POST', `/rooms/${roomId}/ready`, { ready: true })).status).toBe(200);

    await alice.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`);
    await expect(alice.page.locator('[data-testid="pod-rounds"], [data-testid="table-page"]').first()).toBeVisible({ timeout: UI_TIMEOUT });
    // What the server says now: every control locked, the tournament having been dealt.
    const refused = await api<{ reason?: string; error: string }>('PATCH', `/rooms/${roomId}`, { mode: 'classic', modeOptions: {} });
    expect(refused.status, 'the server refuses a mode change in the rounds').toBe(409);

    const disabled = (sel: string) => alice.page.locator(sel).evaluateAll((els) => els.map((el) => (el as HTMLInputElement | HTMLButtonElement).disabled));
    for (const group of ['room-game-type', 'room-event', 'constructed-mode']) {
      const states = await disabled(`[data-testid="${group}"] input`);
      console.log(`[tourney-hub] ${group}: ${JSON.stringify(states)}`);
      expect(states.length, `${group} is drawn`).toBeGreaterThan(0);
      expect(states.every(Boolean), `${group}: every option disabled`).toBe(true);
    }
    await alice.page.getByTestId('match-rules').click();
    const rules = await disabled('[data-testid="match-rules-popover"] button.ct-toggle');
    console.log(`[tourney-hub] match rules: ${JSON.stringify(rules)}`);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every(Boolean), 'every match rule read-only').toBe(true);
    await alice.page.keyboard.press('Escape');

    // My live match's ⋯: its tools open in a modal over the bracket, and take the press.
    if (await alice.page.getByTestId('table-hub').isVisible()) await alice.page.getByTestId('table-hub').click();
    const live = alice.page.locator('[data-testid="pod-tables-row"][data-live]');
    await expect(alice.page.locator('[data-testid="pod-tables-row"]'), 'my live match and the settled one under it').toHaveCount(2, { timeout: UI_TIMEOUT });
    await live.getByTestId('pod-tables-row-more').click();
    const items = alice.page.getByTestId('pod-tables-row-tools').getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    for (const item of await items.all()) {
      const topmost = await item.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === el || el.contains(hit);
      });
      expect(topmost, `${await item.textContent()}: the menu item is what a press there hits`).toBe(true);
    }
  } finally {
    await alice.context.close();
  }
});

// The operator's own room was a Classic tournament: its pool (the format tabs and the year) and its Room
// settings answered a press with "this room is drafting; the format cannot change now".
test('a Classic tournament in its rounds: the pool, the year and the room settings are all read-only for its leader', async ({ browser }) => {
  const admin = await openFriend(browser, 'admin');
  try {
    await openSeeded(admin.page, 'Testing: Constructed tournament — round 2');
    await expect(admin.page.getByTestId('pod-rounds'), 'the hub').toBeVisible({ timeout: UI_TIMEOUT });
    // The seed left: the first admin in leads the room.
    await expect(admin.page.getByTestId('format-tabs'), 'the leader’s pool controls are drawn').toBeVisible({ timeout: UI_TIMEOUT });
    const states = await admin.page
      .locator('[data-testid="format-tabs"] button, [data-testid^="format-"][data-testid$="-year"], [data-testid="format-earlier"], [data-testid="format-later"], [data-testid="room-event"] input')
      .evaluateAll((els) => els.map((el) => `${el.getAttribute('data-testid') ?? el.tagName}:${(el as HTMLButtonElement).disabled}`));
    console.log(`[tourney-hub] classic pool: ${JSON.stringify(states)}`);
    expect(states.length).toBeGreaterThan(3);
    expect(states.filter((s) => s.endsWith(':false')), 'nothing the server would refuse is enabled').toEqual([]);
    await admin.page.getByTestId('match-rules').click();
    const rules = await admin.page.locator('[data-testid="match-rules-popover"] button.ct-toggle').evaluateAll((els) => els.map((el) => (el as HTMLButtonElement).disabled));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every(Boolean), 'every match rule read-only').toBe(true);
  } finally {
    await admin.context.close();
  }
});

test('reduced motion: the podium stands still', async ({ browser }) => {
  const admin = await openFriend(browser, 'admin');
  try {
    await admin.page.emulateMedia({ reducedMotion: 'reduce' });
    await openSeeded(admin.page, DONE);
    await expect(admin.page.getByTestId('pod-podium')).toBeVisible({ timeout: UI_TIMEOUT });
    const moving = await admin.page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="pod-podium"] *')].filter((el) => el.checkVisibility() && getComputedStyle(el).animationName !== 'none').length,
    );
    expect(moving, 'nothing on the podium animates').toBe(0);
  } finally {
    await admin.context.close();
  }
});
