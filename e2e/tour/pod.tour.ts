/**
 * Sunday's tournament, every screen of it, at 1440×900 and 390×844, dark and light: a Bloomburrow
 * set-cube pod of one person and seven bots (Bots play on, the pick timer on) from the empty lobby
 * to the podium, with a second person who arrives once the draft has started and watches: the
 * draft, the hub, a bots' table and its match, and the person's own match. The person concedes
 * every game, so a round lasts as long as the bots' own matches. A review aid, never a gate
 * (`*.tour.ts`); `phone.ts` measures and screenshots.
 *
 *   npx playwright test --config e2e/tour/playwright.config.ts pod.tour.ts
 */
import { test, type Page } from '@playwright/test';

import type { PodView } from '../../packages/shared/src/index.ts';

import { PREFIX } from '../identities.ts';
import { roomIdFromAddress } from '../play/board.ts';
import type { Friend } from '../play/browser.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { submitCreateRoom } from '../play/rooms.ts';
import { readyPod } from '../podSeats.ts';
import { attempt, expect, openPhone, shotBoth, type ShotMeta } from './phone.ts';

const forge = forgeAvailability();
const UI = 30_000;
const isAi = (id: string): boolean => id === 'ai' || /^ai:\d+$/.test(id);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (line: string): void => console.log(`[pod-tour] ${line}`);

interface RoomBody {
  game: { pod: PodView | null };
}

async function roomOf(f: Friend, stack: PlayStack, roomId: string): Promise<RoomBody> {
  for (let attempt = 1; ; attempt++) {
    const res = await f.context.request.get(`${stack.origin}${PREFIX}/api/rooms/${roomId}`).catch((err: unknown) => {
      if (attempt >= 3) throw err;
      return null;
    });
    if (res !== null && res.ok()) return (await res.json()) as RoomBody;
    if (attempt >= 3) throw new Error(`GET room ${res?.status() ?? 'reset'}`);
    await sleep(500);
  }
}

async function go(page: Page, url: string, settle = 1_500): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(settle);
}

test('pod: a BLB set-cube pod from the lobby to the podium, as a player and as a spectator', async ({ browser }) => {
  test.setTimeout(75 * 60_000);
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  const seen = new Set<string>();
  /** Each kind of screen once: the first time the loop meets it. */
  const once = async (key: string, pages: readonly Page[], meta: ShotMeta, opts: { full?: boolean } = {}): Promise<void> => {
    if (seen.has(key)) return;
    seen.add(key);
    await shotBoth(pages, key, meta, opts);
  };
  try {
    const alice = await openPhone(browser, 'alice', 'desktop');
    const bob = await openPhone(browser, 'bob', 'desktop');
    const a = alice.page;
    const b = bob.page;
    const S = (area: string, route: string, state: string): ShotMeta => ({ area, route, state });

    await go(a, `${stack.origin}${PREFIX}/`);
    await shotBoth([a], 'front', S('front', '#/', 'the front page before the tournament'), { full: true });

    /* the lobby */
    await submitCreateRoom(a, { name: `Bloomburrow Major ${Date.now() % 1000}`, gameType: 'draft' });
    const roomId = await roomIdFromAddress(a);
    const roomUrl = `${stack.origin}${PREFIX}/#/room/${roomId}`;
    await a.getByTestId('draft-lobby').waitFor({ timeout: UI });
    await shotBoth([a], 'lobby-empty', S('lobby', '#/room/<id>', 'the leader alone in a new draft room'), { full: true });
    await a.getByTestId('pool-picker-tab-set').click();
    await a.getByTestId('pool-picker-sets-BLB').click();
    await a.getByTestId('pool-picker-style-set-cube').click();
    await expect(a.getByTestId('pool-picker-verdict')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
    await shotBoth([a], 'lobby-blb', S('lobby', '#/room/<id>', 'BLB · Set-cube chosen, its verdict ready'), { full: true });
    await a.getByTestId('match-rules').click();
    const botsPlay = a.getByTestId('bots-play');
    if ((await botsPlay.getAttribute('aria-pressed')) !== 'true') await botsPlay.click();
    await expect(botsPlay).toHaveAttribute('aria-pressed', 'true', { timeout: UI });
    const timer = a.getByTestId('pick-timer');
    if ((await timer.getAttribute('aria-pressed')) !== 'true') await timer.click();
    await expect(timer).toHaveAttribute('aria-pressed', 'true', { timeout: UI });
    await shotBoth([a], 'lobby-rules', S('lobby', '#/room/<id>', 'Match rules: Bots play on, pick timer on'), { full: true });
    await a.getByTestId('match-rules-popover-close').click();
    await expect(a.locator('[data-testid^="pod-seat-"][data-mine]')).toHaveCount(1, { timeout: UI });
    for (let i = 0; i < 7; i++) {
      const seats = (await roomOf(alice, stack, roomId)).game.pod?.seats ?? [];
      const open = seats.indexOf(null);
      const ai = a.locator(`[data-testid="pod-seat-ai"][data-seat="${open}"]`);
      await ai.click({ timeout: UI });
      await expect(ai).toHaveCount(0, { timeout: UI });
      if (i === 2) await shotBoth([a], 'lobby-filling', S('lobby', '#/room/<id>', 'three bots seated, four seats open'), { full: true });
    }
    await shotBoth([a], 'lobby-full', S('lobby', '#/room/<id>', 'eight seated: one person, seven bots, not ready'), { full: true });

    /* the draft */
    await readyPod(a, 90_000);
    await a.getByTestId('pod').waitFor({ timeout: 90_000 });
    await a.locator('[data-testid="pack"] button[data-testid="card"]').first().waitFor({ timeout: UI });
    await a.waitForTimeout(1_500);
    await shotBoth([a], 'draft-pack', S('draft', '#/room/<id>', 'pack 1 pick 1, the default layout'), { full: true });
    const grid = a.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
    if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
    await a.waitForTimeout(600);
    await shotBoth([a], 'draft-grid', S('draft', '#/room/<id>', 'pack 1 pick 1 as a grid'), { full: true });

    await go(b, roomUrl, 3_000);
    await shotBoth([b], 'draft-watcher', S('draft', '#/room/<id>', 'a second person arrives mid-draft: a watcher'), { full: true });

    const enabled = '[data-testid="pack"] button[data-testid="card"]:not([disabled])';
    let picks = 0;
    for (;;) {
      const next = await a.waitForFunction(
        (sel) => (window.location.hash.startsWith('#/deck/') ? 'done' : document.querySelector(sel) !== null ? 'pick' : null),
        enabled,
        { timeout: 3 * 60_000, polling: 100 },
      );
      if ((await next.jsonValue()) === 'done') break;
      if (picks === 4) await once('draft-picks', [a], S('draft', '#/room/<id>', 'four picks in: the pool column growing'), { full: true });
      if (picks === 16) await once('draft-pack2', [a], S('draft', '#/room/<id>', 'pack 2, passed the other way'), { full: true });
      if (picks === 6 && (await a.getByTestId('pick-rope').count()) === 0) {
        // The rope shows in a pick's last third: wait for it once.
        await attempt('rope', async () => {
          await a.getByTestId('pick-rope').waitFor({ timeout: 60_000 });
          await once('draft-rope', [a], S('draft', '#/room/<id>', 'the pick timer’s rope'));
        }, a);
        if (a.url().includes('#/deck/')) break;
      }
      await a.locator(enabled).first().click({ timeout: 5_000 }).then(
        () => (picks += 1),
        () => undefined,
      );
      await a.waitForTimeout(450);
    }
    say(`drafted ${picks} picks`);

    /* building */
    await a.getByTestId('deck-editor').waitFor({ timeout: 60_000 });
    await a.waitForTimeout(2_000);
    await shotBoth([a], 'deck-built', S('deck', '#/deck/<id>', 'the builder as the draft ends'), { full: true });
    await shotBoth([b], 'build-watcher', S('deck', '#/room/<id>', 'the watcher while the field builds'), { full: true });
    await a.getByTestId('basics-auto').click();
    await a.waitForTimeout(1_500);
    await shotBoth([a], 'deck-auto', S('deck', '#/deck/<id>', 'Auto lands pressed'), { full: true });
    await a.getByTestId('play-deck').click();
    await a.waitForURL(/\/room\/[^/#]+/, { timeout: UI });

    /* the rounds: the person concedes every game; the watcher looks around each round */
    let lastRound = 0;
    const deadline = Date.now() + 60 * 60_000;
    let pod: PodView | null = null;
    while (Date.now() < deadline) {
      pod = (await roomOf(alice, stack, roomId)).game.pod;
      if (pod?.phase === 'done') break;
      const round = pod?.round ?? 0;
      if (pod?.phase === 'rounds' && round !== lastRound) {
        lastRound = round;
        say(`round ${round} of ${pod.rounds}: ${pod.pairings.map((x) => x.players.map((id) => (isAi(id) ? 'AI' : 'alice')).join('-')).join(' ')}`);
        await attempt(`hub round ${round}`, async () => {
          await go(b, roomUrl, 2_500);
          await b.getByTestId('pod-tables').waitFor({ timeout: UI });
          await shotBoth([b], `hub-r${round}`, S('hub', '#/room/<id>', `the hub in round ${round}, as a watcher`), { full: true });
        }, b);
        if (round === 1 || round === pod.rounds) {
          await attempt(`spectate a bots' table, round ${round}`, async () => {
            const bots = pod!.pairings.find((x) => x.players.every(isAi));
            if (bots === undefined) throw new Error('no bots-only table this round');
            await go(b, `${roomUrl}/table/${bots.tableId}`, 2_500);
            await b.getByTestId('table-page').waitFor({ timeout: UI });
            await shotBoth([b], `table-bots-r${round}`, S('spectate', '#/room/<id>/table/<t>', `a bots’ table page, round ${round}`), { full: true });
            const watch = b.locator('a[data-door], [data-testid="pod-tables-watch"]').first();
            if ((await watch.count()) > 0) await watch.click();
            await b.locator('[aria-label="Game board"]').waitFor({ timeout: 90_000 });
            await b.waitForTimeout(4_000);
            await shotBoth([b], `match-bots-r${round}`, S('spectate', '#/match/<id>', `watching two bots play, round ${round}`));
          }, b);
        }
      }
      await alicePlays(a, round, roomUrl, once, S);
      await sleep(400);
    }
    if (pod?.phase !== 'done') throw new Error(`the tournament did not finish: ${JSON.stringify(pod).slice(0, 400)}`);
    say(`done: ${pod.standings.map((r) => `${r.rank}. ${isAi(r.id) ? r.id : 'alice'} ${r.matchPoints}`).join(', ')}`);

    /* the end */
    for (const [p, who] of [
      [a, 'the person'],
      [b, 'the watcher'],
    ] as const) {
      await go(p, roomUrl, 3_000);
      await shotBoth([p], `finished-${p === a ? 'player' : 'watcher'}`, S('finished', '#/room/<id>', `the finished tournament, as ${who}`), { full: true });
    }
    await go(a, `${stack.origin}${PREFIX}/`, 3_000);
    await shotBoth([a], 'front-after', S('finished', '#/', 'the front page after the tournament'), { full: true });
    await go(a, `${stack.origin}${PREFIX}/#/tournaments`, 2_500);
    await shotBoth([a], 'tournaments', S('finished', '#/tournaments', 'past tournaments'), { full: true });
  } finally {
    await stack.stop();
  }
});

/** One step of the person's own play: whatever the page offers next, shot the first time it shows. */
async function alicePlays(
  a: Page,
  round: number,
  roomUrl: string,
  once: (key: string, pages: readonly Page[], meta: ShotMeta, opts?: { full?: boolean }) => Promise<void>,
  S: (area: string, route: string, state: string) => ShotMeta,
): Promise<void> {
  const press = async (sel: string): Promise<boolean> => {
    const el = a.locator(sel).first();
    if ((await el.count()) === 0 || !(await el.isVisible().catch(() => false)) || !(await el.isEnabled().catch(() => false))) return false;
    return el.click({ timeout: 3_000 }).then(
      () => true,
      () => false,
    );
  };
  const hash = new URL(a.url()).hash;
  if ((await a.getByTestId('game-result').count()) > 0) {
    await once('match-result', [a], S('match', '#/match/<id>', 'the game result, a conceded game'));
    if (await press('[data-testid="game-result-enter"]')) return;
    if (await press('[data-testid="sideboard-ready"]')) return;
    if (await press('[data-testid="game-result-next"]')) return;
    await press('[data-testid="game-result-room"]');
    return;
  }
  if ((await a.locator('[aria-label="Game board"]').count()) > 0) {
    const concede = a.getByTestId('live-concede');
    if (!(await concede.isEnabled().catch(() => false)) || (await a.getByTestId('live-says').textContent().catch(() => '')) === '') return;
    await a.waitForTimeout(3_000);
    await once('match-player', [a], S('match', '#/match/<id>', 'the person’s own match, game 1, opening hand'));
    await concede.click({ timeout: 3_000 }).catch(() => undefined);
    await once('match-concede', [a], S('match', '#/match/<id>', 'the Concede sheet'));
    await a.getByTestId('live-concede-yes').click({ timeout: 3_000 }).catch(() => undefined);
    return;
  }
  if (/\/sideboard$/.test(hash)) {
    await once('sideboard', [a], S('match', '#/match/<id>/sideboard', 'the sideboard step between games'), { full: true });
    if (await press('[data-testid="sideboard-ready"]')) return;
    if (await press('[data-testid="game-result-enter"]')) return;
    await press('a[data-door="enter"]');
    return;
  }
  if ((await a.getByTestId('table-page').count()) > 0) {
    await once('table-mine', [a], S('hub', '#/room/<id>/table/<t>', 'my own table page'), { full: true });
    if (await press('a[data-door="enter"]')) return;
    await press('a[data-door="sideboard"]');
    return;
  }
  const lit = '[data-testid="pod-tables-row"][data-call] [data-testid="pod-tables-play"]';
  if ((await a.locator(lit).count()) > 0) {
    await once(`hub-mine-r${round}`, [a], S('hub', '#/room/<id>', `the hub in round ${round}, my table lit`), { full: true });
    await press(lit);
    return;
  }
  if ((await a.getByTestId('pod-tables').count()) > 0) {
    await once('hub-waiting', [a], S('hub', '#/room/<id>', 'my match done, the bots still playing'), { full: true });
    return;
  }
  if (!/\/room\//.test(new URL(a.url()).pathname)) await a.goto(roomUrl);
}
