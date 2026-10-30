/**
 * Breaking tournament mode against the real built server and real Forge — wave 83 §D, the cases that need
 * a live match. The room's own bookkeeping (counts, byes, ties, drops, simultaneous results, restarts of the
 * lobby alone) is `apps/server/src/room/w83d-tournament-break.test.ts`.
 *
 * Each test: Alice leads a Classic tournament with locked decks, she and Bob sit, pick and ready, the field
 * locks, and round 1 carries both into their match. Then something goes wrong mid-round:
 * - a player reloads, and later closes their tab and comes back two minutes on;
 * - the server restarts (a deploy);
 * - the match's Forge JVM dies.
 * The round must still reach its result and standings.
 *
 * `[w83d]` lines are the evidence: the match ids, the pid killed, what each screen showed.
 */
import { expect, test, type Browser } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { type Friend } from './play/browser.ts';
import { forgeAvailability, matchPid, startPlayStack, type PlayStack } from './play/harness.ts';
import { openMyTable } from './play/rooms.ts';
import { concedeToResult, enableTournament, openRoomWithLeader, sitPickReady } from './play/tournament.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
const board = (f: Friend) => f.page.locator('[aria-label="Game board"]');

interface Round {
  alice: Friend;
  bob: Friend;
  roomUrl: string;
  matchId: string;
}

/** A two-entrant Classic tournament, locked, both entrants on round 1's board. */
async function intoRoundOne(browser: Browser, stack: PlayStack, label: string): Promise<Round> {
  const { alice, bob, roomUrl } = await openRoomWithLeader(browser, stack.origin, `w83d ${label} ${Date.now()}`);
  await enableTournament(alice, bob, 'locked');
  await sitPickReady(alice, 0);
  await sitPickReady(bob, 1);
  for (const p of [alice, bob]) await p.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
  for (const p of [alice, bob]) await expect(board(p), `${p.name}: on round 1’s board`).toBeVisible({ timeout: UI_TIMEOUT });
  const matchId = matchUrl.exec(alice.page.url())![1]!;
  expect(matchUrl.exec(bob.page.url())![1], 'both in one match').toBe(matchId);
  console.log(`[w83d] ${label}: round 1 match ${matchId}`);
  return { alice, bob, roomUrl, matchId };
}

/** Where the game just ended left the round, from the room itself: `done`, `sideboarding`, or still `playing`. */
async function afterGame(f: Friend, roomUrl: string): Promise<string> {
  const roomId = new URL(roomUrl).hash.replace(/^#\/room\//, '');
  const room = (await f.page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as { pod: { phase: string } | null; tables: { series: { phase: string } }[] };
  if (room.pod?.phase === 'done') return 'done';
  return room.tables.some((t) => t.series.phase === 'sideboarding') ? 'sideboarding' : 'playing';
}

/**
 * The rest of the round from wherever its series stands: `loser` concedes each game until the table's Bo3
 * is decided, through the sideboard step between games, and both see standings on the hub.
 */
async function finishRound(r: Round, loser: Friend, winner: Friend): Promise<void> {
  for (let game = 0; game < 3; game++) {
    await concedeToResult(loser, winner);
    // The result screen can draw a beat before the table records the game.
    let next = 'playing';
    await expect.poll(async () => (next = await afterGame(loser, r.roomUrl)), { timeout: UI_TIMEOUT, message: 'the table records the game' }).not.toBe('playing');
    if (next === 'done') break;
    for (const p of [winner, loser]) {
      await openMyTable(p.page, r.roomUrl);
      await p.page.getByTestId('sideboard-ready').click({ timeout: UI_TIMEOUT });
    }
    for (const p of [winner, loser]) await expect(board(p), `${p.name}: game ${game + 2}`).toBeVisible({ timeout: UI_TIMEOUT });
  }
  for (const p of [winner, loser]) {
    await p.page.goto(r.roomUrl);
    await expect(p.page.getByTestId('pod-standings'), `${p.name}: the round settles to standings`).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(p.page.getByTestId(/^pod-standings-row-\d+$/)).toHaveCount(2);
  }
}

test(titled('players reconnecting mid-round: a reload, then a tab closed for two minutes, and the round still settles'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const r = await intoRoundOne(browser, stack, 'reconnect');

    await r.bob.page.reload();
    await expect(board(r.bob), 'bob: back on the board after a reload').toBeVisible({ timeout: UI_TIMEOUT });
    expect(matchUrl.exec(r.bob.page.url())?.[1], 'bob: the same match').toBe(r.matchId);

    await r.alice.page.close();
    const closedAt = Date.now();
    await r.bob.page.waitForTimeout(120_000);
    r.alice.page = await r.alice.context.newPage();
    await r.alice.page.goto(r.roomUrl);
    await r.alice.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
    await expect(board(r.alice), 'alice: back on the board after two minutes away').toBeVisible({ timeout: UI_TIMEOUT });
    expect(matchUrl.exec(r.alice.page.url())?.[1], 'alice: the same match').toBe(r.matchId);
    console.log(`[w83d] reconnect: alice back after ${Math.round((Date.now() - closedAt) / 1000)} s on ${r.matchId}`);

    await finishRound(r, r.bob, r.alice);
  } finally {
    await stack.stop();
  }
});

test(titled('a server restart mid-round: both entrants are back in their match, and the round settles with the same pairing'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const r = await intoRoundOne(browser, stack, 'restart');
    await stack.restart();
    for (const p of [r.alice, r.bob]) {
      await expect(p.page.getByTestId('live-status'), `${p.name}: rejoined after the restart`).toHaveCount(0, { timeout: 60_000 });
      await expect(board(p)).toBeVisible({ timeout: UI_TIMEOUT });
      expect(matchUrl.exec(p.page.url())?.[1], `${p.name}: the same match`).toBe(r.matchId);
    }
    console.log(`[w83d] restart: both back on ${r.matchId}`);
    await finishRound(r, r.alice, r.bob);
  } finally {
    await stack.stop();
  }
});

test(titled('a tournament match whose Forge dies: both screens say so, the table plays the game again, and the round settles'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const r = await intoRoundOne(browser, stack, 'jvm-dies');
    const pid = matchPid(stack.workDir, r.matchId);
    console.log(`[w83d] jvm-dies: killing ${r.matchId}'s bridge JVM, pid ${pid}`);
    process.kill(pid, 'SIGKILL');
    for (const p of [r.alice, r.bob]) await expect(p.page.getByTestId('match-ended'), `${p.name}: told the match ended`).toBeVisible({ timeout: UI_TIMEOUT });

    // The game had no result, so the series stands where it was and its table deals the game again.
    for (const p of [r.alice, r.bob]) await openMyTable(p.page, r.roomUrl);
    for (const p of [r.alice, r.bob]) {
      await p.page.waitForURL(matchUrl, { timeout: 60_000 });
      await expect(board(p), `${p.name}: a new game at the same table`).toBeVisible({ timeout: UI_TIMEOUT });
    }
    const replay = matchUrl.exec(r.alice.page.url())![1]!;
    expect(replay, 'a new match, not the dead one').not.toBe(r.matchId);
    console.log(`[w83d] jvm-dies: the table dealt ${replay}`);
    await finishRound({ ...r, matchId: replay }, r.bob, r.alice);
  } finally {
    await stack.stop();
  }
});
