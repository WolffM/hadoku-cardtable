/**
 * Sunday's tournament, every screen of it, at 1440×900 and 390×844 (or `TOUR_SIZES`), dark and light: a
 * Bloomburrow set-cube pod of two people (alice, the leader, and bob) and six bots (Bots play on, the pick
 * timer on) from the empty lobby to the podium, with a third person (carol) who arrives once the draft has
 * started and watches: the draft, the hub, a bots' table and its match, and the people's own matches. Both
 * people concede every game, so a round lasts as long as the bots' own matches; alice holds hers until bob,
 * his own match done, has watched it from the hub (watch-anywhere). Also shot: round 2's pairings arriving on
 * the hub alice is sitting on, bob's tab gone mid-round and back, and the finished pod on Stats › Tournaments
 * (it lists a pod two people played). A review aid, never a gate (`*.tour.ts`); `phone.ts` measures and
 * screenshots. `TOUR_ENGINE` picks the browser, `TOUR_CONTEXT=phone` makes every person an iPhone.
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
import { inMenu } from '../play/phone.ts';
import { attempt, CONTEXT, expect, openPhone, shotBoth, type ShotMeta } from './phone.ts';

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

test('pod: a BLB set-cube pod from the lobby to the podium, as two players and a spectator', async ({ browser }) => {
  test.setTimeout(90 * 60_000);
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
    const alice = await openPhone(browser, 'alice', CONTEXT);
    const bob = await openPhone(browser, 'bob', CONTEXT);
    const carol = await openPhone(browser, 'carol', CONTEXT);
    const a = alice.page;
    let b = bob.page;
    const c = carol.page;
    const S = (area: string, route: string, state: string): ShotMeta => ({ area, route, state });

    await go(a, `${stack.origin}${PREFIX}/`);
    await shotBoth([a], 'front', S('front', '#/', 'the front page before the tournament'), { full: true });

    /* the lobby */
    await submitCreateRoom(a, { name: `Bloomburrow Major ${Date.now() % 1000}`, gameType: 'draft' });
    const roomId = await roomIdFromAddress(a);
    const roomUrl = `${stack.origin}${PREFIX}/#/room/${roomId}`;
    await a.getByTestId('draft-lobby').waitFor({ timeout: UI });
    await shotBoth([a], 'lobby-empty', S('lobby', '#/room/<id>', 'the leader alone in a new draft room'), { full: true });
    // Each press writes the room's plan, and the picker is disabled until the room answers: timed, so a slow one shows.
    for (const id of ['pool-picker-tab-set', 'pool-picker-sets-BLB', 'pool-picker-style-set-cube']) {
      const t0 = Date.now();
      await a.getByTestId(id).click({ timeout: 120_000 });
      await expect(a.getByTestId('pool-picker-sets-BLB')).toBeEnabled({ timeout: 120_000 });
      say(`${id}: ${Date.now() - t0} ms to press and settle`);
    }
    await expect(a.getByTestId('pool-picker-sets-BLB')).toBeChecked();
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
    // bob walks in and is seated by the room.
    await go(b, roomUrl, 2_000);
    await expect(b.locator('[data-testid^="pod-seat-"][data-mine]')).toHaveCount(1, { timeout: UI });
    // A seat's number is in its test id (`pod-seat-3`); the seat itself carries no data-seat.
    const seatOf = async (p: Page): Promise<number> => {
      const id = (await p.locator('[data-testid^="pod-seat-"][data-mine]').first().getAttribute('data-testid')) ?? '';
      const n = Number(/^pod-seat-(\d+)$/.exec(id)?.[1]);
      if (!Number.isInteger(n)) throw new Error(`tour: no seat number in ${id}`);
      return n;
    };
    const seated = (await roomOf(alice, stack, roomId)).game.pod?.seats ?? [];
    const memberAt = (i: number): string => {
      const seat = seated[i];
      if (seat === null || seat === undefined) throw new Error(`pod seat ${i} is empty`);
      return seat.memberId;
    };
    const aliceId = memberAt(await seatOf(a));
    const bobId = memberAt(await seatOf(b));
    const who = (id: string): string => (id === aliceId ? 'alice' : id === bobId ? 'bob' : isAi(id) ? 'AI' : id);
    say(`alice is ${aliceId}, bob is ${bobId}`);
    for (let i = 0; i < 6; i++) {
      const seats = (await roomOf(alice, stack, roomId)).game.pod?.seats ?? [];
      const open = seats.indexOf(null);
      const ai = a.locator(`[data-testid="pod-seat-ai"][data-seat="${open}"]`);
      await ai.click({ timeout: UI });
      await expect(ai).toHaveCount(0, { timeout: UI });
      if (i === 2) await shotBoth([a], 'lobby-filling', S('lobby', '#/room/<id>', 'two people and three bots seated, three seats open'), { full: true });
    }
    await shotBoth([a], 'lobby-full', S('lobby', '#/room/<id>', 'eight seated: two people, six bots, not ready'), { full: true });

    /* the draft */
    await b.getByTestId('ready-toggle').click({ timeout: UI });
    await readyPod(a, 90_000);
    await a.getByTestId('pod').waitFor({ timeout: 90_000 });
    await a.locator('[data-testid="pack"] button[data-testid="card"]').first().waitFor({ timeout: UI });
    await a.waitForTimeout(1_500);
    await shotBoth([a], 'draft-pack', S('draft', '#/room/<id>', 'pack 1 pick 1, the default layout'), { full: true });
    const grid = a.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
    if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
    await a.waitForTimeout(600);
    await shotBoth([a], 'draft-grid', S('draft', '#/room/<id>', 'pack 1 pick 1 as a grid'), { full: true });

    await go(c, roomUrl, 3_000);
    await shotBoth([c], 'draft-watcher', S('draft', '#/room/<id>', 'a third person arrives mid-draft: a watcher'), { full: true });

    const enabled = '[data-testid="pack"] button[data-testid="card"]:not([disabled])';
    const bobDrafts = draftToTheEnd(b, enabled);
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
    say(`drafted ${picks} picks; bob ${await bobDrafts}`);

    /* building */
    await a.getByTestId('deck-editor').waitFor({ timeout: 60_000 });
    await a.waitForTimeout(2_000);
    await shotBoth([a], 'deck-built', S('deck', '#/deck/<id>', 'the builder as the draft ends'), { full: true });
    await shotBoth([c], 'build-watcher', S('deck', '#/room/<id>', 'the watcher while the field builds'), { full: true });
    await a.getByTestId('basics-auto').click();
    await a.waitForTimeout(1_500);
    await shotBoth([a], 'deck-auto', S('deck', '#/deck/<id>', 'Auto lands pressed'), { full: true });
    for (const p of [a, b]) {
      if (p === b) {
        await b.getByTestId('deck-editor').waitFor({ timeout: 60_000 });
        await b.getByTestId('basics-auto').click();
        await b.waitForTimeout(800);
      }
      await p.getByTestId('play-deck').click();
      await p.waitForURL(/\/room\/[^/#]+/, { timeout: UI });
    }

    /* the rounds: both people concede every game; the watcher looks around each round */
    let lastRound = 0;
    let lastSeenRound = 0;
    let roundStart = Date.now();
    /** The round bob watched alice's live match in, once he has (watch-anywhere). */
    let watched = 0;
    /** The round bob's tab went away and came back in. */
    let awayRound = 0;
    const noShots = async (): Promise<void> => undefined;
    const deadline = Date.now() + 60 * 60_000;
    let pod: PodView | null = null;
    while (Date.now() < deadline) {
      pod = (await roomOf(alice, stack, roomId)).game.pod;
      if (pod?.phase === 'done') break;
      const round = pod?.round ?? 0;
      if (pod?.phase === 'rounds' && round !== lastRound) {
        lastRound = round;
        say(`round ${round} of ${pod.rounds}: ${pod.pairings.map((x) => x.players.map(who).join('-')).join(' ')}`);
        if (round === 2) {
          // alice has been sitting on the hub since her round-1 match: round 2 arrives on it, unreloaded.
          await attempt('round 2 arrives on the hub', async () => {
            // Her round-1 match may be the round's last: its result is still up, and Back to room is her way on.
            const back = a.getByTestId('game-result-room');
            if (await back.isVisible().catch(() => false)) await back.click({ timeout: 3_000 });
            await a.getByTestId('pod-tables').waitFor({ timeout: UI });
            await shotBoth([a], 'hub-r2-arrives', S('hub', '#/room/<id>', 'round 2’s pairings arriving on the hub alice sat on'), { full: true });
          }, a);
        }
        await attempt(`hub round ${round}`, async () => {
          await go(c, roomUrl, 2_500);
          await c.getByTestId('pod-tables').waitFor({ timeout: UI });
          await shotBoth([c], `hub-r${round}`, S('hub', '#/room/<id>', `the hub in round ${round}, as a watcher`), { full: true });
        }, c);
        if (round === 2 && awayRound === 0) {
          // bob's tab goes away mid-round (a phone locked, a tab closed) and comes back.
          awayRound = round;
          await attempt('a seat goes away and comes back', async () => {
            await b.close();
            await sleep(8_000);
            await go(c, roomUrl, 2_500);
            await shotBoth([c], 'hub-seat-away', S('hub', '#/room/<id>', 'bob’s tab gone mid-round, as the watcher sees it'), { full: true });
            b = await bob.context.newPage();
            await go(b, roomUrl, 3_000);
            await shotBoth([b], 'hub-seat-back', S('hub', '#/room/<id>', 'bob back in the room mid-round'), { full: true });
            await go(c, roomUrl, 2_500);
            await shotBoth([c], 'hub-seat-back-watcher', S('hub', '#/room/<id>', 'bob back, as the watcher sees it'), { full: true });
          }, c);
        }
        if (round === 1 || round === pod.rounds) {
          await attempt(`spectate a bots' table, round ${round}`, async () => {
            const bots = pod!.pairings.find((x) => x.players.every(isAi));
            if (bots === undefined) throw new Error('no bots-only table this round');
            await go(c, `${roomUrl}/table/${bots.tableId}`, 2_500);
            await c.getByTestId('table-page').waitFor({ timeout: UI });
            await shotBoth([c], `table-bots-r${round}`, S('spectate', '#/room/<id>/table/<t>', `a bots’ table page, round ${round}`), { full: true });
            const watch = c.locator('a[data-door], [data-testid="pod-tables-watch"]').first();
            if ((await watch.count()) > 0) await watch.click();
            await c.locator('[aria-label="Game board"]').waitFor({ timeout: 90_000 });
            await c.waitForTimeout(4_000);
            await shotBoth([c], `match-bots-r${round}`, S('spectate', '#/match/<id>', `watching two bots play, round ${round}`));
          }, c);
        }
      }
      const pairing = (id: string) => pod?.pairings.find((x) => x.players.includes(id));
      const apart = pod?.phase === 'rounds' && pairing(aliceId) !== undefined && pairing(aliceId) !== pairing(bobId);
      // alice holds her match until bob, his own done, has watched it — the first round they are apart.
      const hold = apart && watched === 0 && Date.now() < roundStart + 4 * 60_000;
      if (round !== lastSeenRound) {
        lastSeenRound = round;
        roundStart = Date.now();
      }
      if (round === 1 && !(await aliceIsLive(a)) && (await a.getByTestId('table-page').count()) > 0 && (await a.locator('a[data-door="enter"], a[data-door="sideboard"]').count()) === 0) {
        // Her round-1 match is over: back to the hub by the page's own link, to sit there until round 2 arrives.
        await a.getByTestId('table-hub').click({ timeout: 3_000 }).catch(() => undefined);
      }
      await playStep(a, round, roomUrl, once, S, { hold });
      if (awayRound !== round || !b.isClosed()) await playStep(b, round, roomUrl, noShots, S, { hold: false });
      if (apart && watched === 0 && (await bobIsFree(b)) && (await aliceIsLive(a))) {
        const table = pairing(aliceId)!.tableId;
        await attempt('watch-anywhere: bob watches alice', async () => {
          await go(b, roomUrl, 2_000);
          await shotBoth([b], 'hub-free-player', S('spectate', '#/room/<id>', 'bob’s match done, alice’s still live: the hub'), { full: true });
          await go(b, `${roomUrl}/table/${table}`, 2_500);
          await b.getByTestId('table-page').waitFor({ timeout: UI });
          await shotBoth([b], 'table-live-watch', S('spectate', '#/room/<id>/table/<t>', 'a player between matches on another live table'), { full: true });
          const watch = b.locator('a[data-door], [data-testid="pod-tables-watch"]').first();
          if ((await watch.count()) > 0) await watch.click();
          await b.locator('[aria-label="Game board"]').waitFor({ timeout: 90_000 });
          await b.waitForTimeout(4_000);
          await shotBoth([b], 'match-live-watch', S('spectate', '#/match/<id>', 'a player between matches watching alice’s live game'));
        }, b);
        watched = round;
        await go(b, roomUrl, 1_000);
      }
      await sleep(400);
    }
    if (pod?.phase !== 'done') throw new Error(`the tournament did not finish: ${JSON.stringify(pod).slice(0, 400)}`);
    say(`done: ${pod.standings.map((r) => `${r.rank}. ${who(r.id)} ${r.matchPoints}`).join(', ')}; bob watched alice in round ${watched}`);

    /* the end */
    for (const [p, name] of [
      [a, 'the person'],
      [c, 'the watcher'],
    ] as const) {
      await go(p, roomUrl, 3_000);
      await shotBoth([p], `finished-${p === a ? 'player' : 'watcher'}`, S('finished', '#/room/<id>', `the finished tournament, as ${name}`), { full: true });
    }
    await go(a, `${stack.origin}${PREFIX}/`, 3_000);
    await shotBoth([a], 'front-after', S('finished', '#/', 'the front page after the tournament'), { full: true });
    await go(a, `${stack.origin}${PREFIX}/#/tournaments`, 2_500);
    await shotBoth([a], 'tournaments', S('finished', '#/tournaments', 'past tournaments: the final standings'), { full: true });
  } finally {
    await stack.stop();
  }
});

/** A person's draft to its end, the first enabled card every pick; says how many picks it made. */
async function draftToTheEnd(p: Page, enabled: string): Promise<string> {
  let picks = 0;
  for (;;) {
    const next = await p.waitForFunction(
      (sel) => (window.location.hash.startsWith('#/deck/') ? 'done' : document.querySelector(sel) !== null ? 'pick' : null),
      enabled,
      { timeout: 3 * 60_000, polling: 100 },
    );
    if ((await next.jsonValue()) === 'done') return `${picks} picks`;
    await p.locator(enabled).first().click({ timeout: 5_000 }).then(
      () => (picks += 1),
      () => undefined,
    );
    await p.waitForTimeout(450);
  }
}

/** bob's own match is over for the round: he is on the hub with no table of his lit. */
async function bobIsFree(b: Page): Promise<boolean> {
  if (b.isClosed()) return false;
  if ((await b.getByTestId('pod-tables').count()) === 0) return false;
  return (await b.locator('[data-testid="pod-tables-row"][data-call]').count()) === 0;
}

/** alice is in a live game (its board drawn). */
async function aliceIsLive(a: Page): Promise<boolean> {
  return (await a.locator('[aria-label="Game board"]').count()) > 0 && (await a.getByTestId('game-result').count()) === 0;
}

/**
 * One step of a person's own play: whatever the page offers next, shot the first time it shows. With
 * `hold`, a live game is left running (alice waits for bob to come and watch it).
 */
async function playStep(
  a: Page,
  round: number,
  roomUrl: string,
  once: (key: string, pages: readonly Page[], meta: ShotMeta, opts?: { full?: boolean }) => Promise<void>,
  S: (area: string, route: string, state: string) => ShotMeta,
  { hold }: { hold: boolean },
): Promise<void> {
  if (a.isClosed()) return;
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
    // On a phone the desktop bar's Concede sits in the action menu (⋯, then Menu), and the bar says nothing
    // in `live-says`: a wide table has the button out and a line said once the game is live.
    const phone = await a.getByTestId('action-more').isVisible().catch(() => false);
    if (!phone && (!(await a.getByTestId('live-concede').isEnabled().catch(() => false)) || (await a.getByTestId('live-says').textContent().catch(() => '')) === '')) return;
    await a.waitForTimeout(3_000);
    await once('match-player', [a], S('match', '#/match/<id>', 'the person’s own match, game 1, opening hand'));
    if (hold) return;
    const concede = phone ? await inMenu(a, 'live-concede') : a.getByTestId('live-concede');
    if (phone) await concede.tap({ timeout: 3_000 }).catch(() => undefined);
    else await concede.click({ timeout: 3_000 }).catch(() => undefined);
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
