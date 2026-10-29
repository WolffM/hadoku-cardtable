/**
 * A match's end reaches every screen, whatever that screen is doing when it ends.
 *
 * `w69-rematch.spec.ts` went red twice in full runs at the same step: bob conceded half a second
 * after both seats joined, before Forge had dealt, and alice's screen kept the live board (both
 * hands empty, 20 life, Concede still enabled) for 45 s with no result screen. Bob's screen showed
 * his. A player meets the same thing with an immediate concede, a loss by disconnect, or a crash
 * at the start: the game is over, and one of the two screens never says so.
 *
 * Each case ends the game at a different point of alice's opening, and in each alice must land on
 * Victory and bob on Defeat:
 *  - bob concedes as his own board is drawn, at a different moment on each repetition, so the
 *    concede lands before, during and after Forge's deal (the red run's concede met the deal);
 *  - alice's screen has its join answered and then hears nothing more until the game is over;
 *  - both screens reload once the game is over.
 *
 * `[early-end]` lines are the evidence: every match message alice's browser received (the
 * snapshot's cursor and frames, each frame's seq and method, and whether it carried `GameOver`),
 * and what each screen drew.
 */
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { messages, openFriend, type Friend } from './play/browser.ts';
import { seatBoth } from './play/enter.ts';
import { isSnapshot, type ServerEnvelope } from './play/frames.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;

const say = (line: string): void => console.log(`[early-end] ${line}`);
const result = (f: Friend) => f.page.getByTestId('game-result');

/**
 * Holds every byte the server sends this page's sockets — websocket messages, and the long-polling
 * GETs socket.io starts on — while `holding`, and lets them through in order on `release`.
 * Registered before the page opens anything, so every socket it ever opens is routed.
 */
interface Gate {
  holding: boolean;
  release(): void;
}

async function gate(page: Page): Promise<Gate> {
  const held: (() => void)[] = [];
  const g: Gate = {
    holding: false,
    release() {
      g.holding = false;
      for (const go of held.splice(0)) go();
    },
  };
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (g.holding) held.push(() => ws.send(message));
      else ws.send(message);
    });
  });
  await page.route(/\/socket\.io\/.*transport=polling/, async (route) => {
    if (g.holding && route.request().method() === 'GET') await new Promise<void>((go) => held.push(go));
    await route.fallback();
  });
  return g;
}

/** Alice's browser has adopted a snapshot of the match: her join is answered. */
async function joinAnswered(f: Friend): Promise<boolean> {
  await Promise.all(f.pending);
  return messages(f).some((m) => m.dir === 'in' && m.kind === 'ack' && isSnapshot(m.msg));
}

function serverSaid(stack: PlayStack, evt: string, matchId: string): boolean {
  return readFileSync(stack.serverLogFile, 'utf8')
    .split('\n')
    .some((line) => line.includes(`"evt":"${evt}"`) && line.includes(`"matchId":"${matchId}"`));
}

/**
 * The report runs after the assertions, so it must not spend the test's time: a long-poll GET that a
 * reload cut off can leave its `res.text()` unsettled, and the 2026-10-29 full run spent 3.8 min of a
 * passing test waiting on one. Whatever has not settled in this long is reported as such.
 */
const REPORT_WAIT_MS = 5_000;

/** Every match message alice's browser was sent, one line each. */
async function report(f: Friend, when: string, raw: boolean): Promise<void> {
  const settled = await Promise.race([
    Promise.all(f.pending).then(() => true),
    new Promise<false>((done) => setTimeout(() => done(false), REPORT_WAIT_MS)),
  ]);
  if (!settled) say(`${when} ${f.name} some polling captures had not settled after ${REPORT_WAIT_MS} ms`);
  const over = (raw: string): string => (/"GameOver":\{"t":"bool","v":true\}/.test(raw) ? ' GameOver' : '');
  for (const m of messages(f)) {
    if (m.dir !== 'in') continue;
    if (m.kind === 'ack' && isSnapshot(m.msg)) {
      say(`${when} ${f.name} ${m.via} snapshot cursor=${m.msg.cursor?.seq ?? 'null'} frames=${m.msg.frames.map((fr) => fr.method).join(',')}${over(m.raw)}`);
    } else if (m.kind === 's2c') {
      const e = m.msg as ServerEnvelope;
      const losers = Array.isArray(e.frame.losers) ? ` losers=${e.frame.losers.join(',')}` : '';
      say(`${when} ${f.name} ${m.via} s2c seq=${e.cursor.seq} ${e.frame.method}${over(m.raw)}${losers}`);
    }
    if (raw && (m.kind === 'ack' || m.kind === 's2c')) say(`${when} ${f.name} RAW ${m.raw}`);
  }
  const concede = f.page.getByTestId('live-concede');
  say(
    `${when} ${f.name} draws: result=${(await result(f).getAttribute('data-result', { timeout: REPORT_WAIT_MS }).catch(() => null)) ?? 'none'} concede=${(await concede.count()) === 0 ? 'absent' : (await concede.isDisabled({ timeout: REPORT_WAIT_MS })) ? 'disabled' : 'enabled'} url=${f.page.url().split('#')[1]}`,
  );
}

/** Bob gives up through the product, as soon as his own board offers it. */
async function bobConcedes(bob: Friend): Promise<void> {
  await bob.page.getByTestId('live-concede').click({ timeout: 60_000 });
  await bob.page.getByTestId('live-concede-yes').click();
}

async function bothSeeTheEnd(alice: Friend, bob: Friend, when: string): Promise<void> {
  let failed = true;
  try {
    await expect(result(alice), "alice's result screen").toHaveAttribute('data-result', 'victory', { timeout: 30_000 });
    await expect(result(bob), "bob's result screen").toHaveAttribute('data-result', 'defeat', { timeout: 30_000 });
    failed = false;
  } finally {
    // A red prints every frame each screen was sent, byte for byte: the claws keep no artifact of a page's socket.
    await report(alice, when, failed);
    await report(bob, when, failed);
  }
}

async function bobsMatch(bob: Friend): Promise<string> {
  await bob.page.waitForURL(MATCH_URL, { timeout: 120_000 });
  const matchId = MATCH_URL.exec(bob.page.url())?.[1];
  if (matchId === undefined) throw new Error(`no match id in ${bob.page.url()}`);
  return matchId;
}

async function gameOver(stack: PlayStack, matchId: string): Promise<void> {
  await expect.poll(() => serverSaid(stack, 'game-over', matchId), { message: 'the server ends the game', timeout: 60_000 }).toBe(true);
}

/** How long bob waits, once his Concede is on the screen, before pressing it: a sweep across Forge's deal. */
const CONCEDE_AFTER_MS = [0, 200, 400];

test(titled('bob concedes as his board is drawn: alice lands on Victory, bob on Defeat'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await seatBoth(alice, bob, stack.origin);
    await bob.page.getByTestId('ready-toggle').click();
    const matchId = await bobsMatch(bob);
    const wait = CONCEDE_AFTER_MS[test.info().repeatEachIndex % CONCEDE_AFTER_MS.length]!;
    await expect(bob.page.getByTestId('live-concede')).toBeEnabled({ timeout: 60_000 });
    await bob.page.waitForTimeout(wait);
    await bobConcedes(bob);
    await gameOver(stack, matchId);
    say(`${matchId}: bob conceded ${wait} ms after his board offered it`);
    await bothSeeTheEnd(alice, bob, 'immediate');
  } finally {
    await stack.stop();
  }
});

test(titled("alice's join is answered, then her screen hears nothing until bob has conceded: she lands on Victory"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const held = await gate(alice.page);
    const bob = await openFriend(browser, 'bob');
    await seatBoth(alice, bob, stack.origin);
    await bob.page.getByTestId('ready-toggle').click();
    const matchId = await bobsMatch(bob);
    await expect.poll(() => joinAnswered(alice), { message: "alice's join is answered", timeout: 60_000 }).toBe(true);
    held.holding = true;
    await bobConcedes(bob);
    await gameOver(stack, matchId);
    say(`${matchId}: bob conceded while alice's screen held everything after her join`);
    held.release();
    await bothSeeTheEnd(alice, bob, 'held-after-join');
  } finally {
    await stack.stop();
  }
});

test(titled('both screens reload after the game is over: each lands on its own result'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await seatBoth(alice, bob, stack.origin);
    await bob.page.getByTestId('ready-toggle').click();
    const matchId = await bobsMatch(bob);
    await alice.page.waitForURL(MATCH_URL, { timeout: 120_000 });
    await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
    await bobConcedes(bob);
    await gameOver(stack, matchId);
    for (const f of [alice, bob]) await f.page.reload();
    say(`${matchId}: both screens reloaded after the end`);
    await bothSeeTheEnd(alice, bob, 'reloaded');
  } finally {
    await stack.stop();
  }
});
