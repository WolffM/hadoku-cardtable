/**
 * The front page's replay draws each player's hand where it was in the game. The operator,
 * 2026-11-05: *"i just watched a cursor move to the portrait, pick up misty rainforest, then drop it
 * and i saw it appear somewhere else on the board. seems like the cursor is not correctly matching
 * where it went during the game in the replay view on front page"*.
 *
 * `replay-cursor.state`: alice (turn 1) and then bob (turn 2) each drag the land from the middle of
 * their hand onto their own battlefield, between the two lands already there, and bob concedes. The
 * front page then plays the recording back on its card, and for BOTH players:
 *
 * - the replayed cursor, the moment their card is lifted, is on that card in the replay's own hand;
 * - the card lands in the column of its row the live game put it in;
 * - the card they let go is not left standing where they let go of it once the card is in its column.
 *
 * `[replay-cursor]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { grindPriority, makeTitled, resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { railAt } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (what: string, v: unknown): void => console.log(`[replay-cursor] ${what}: ${JSON.stringify(v)}`);

const ownHandCard = (page: Page, name: string) => page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: name });

/** The ids of the row holding `id` on `owner`'s battlefield, left to right. */
function rowOf(page: Page, owner: 'you' | 'them', id: number): Promise<number[] | null> {
  return page.evaluate(
    ({ owner, id }) => {
      const card = document.querySelector(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card="${id}"]`);
      const row = card?.closest('[data-tier], [data-board-row]');
      return row === null || row === undefined ? null : [...row.querySelectorAll('[data-board-card]')].map((e) => Number(e.getAttribute('data-board-card')));
    },
    { owner, id },
  );
}

/**
 * A player's own drag, at a person's pace: hover the card, press, hold a beat (so the lift is
 * relayed with the pointer still on the card), carry it in small steps, and let go between the two
 * lands of its row.
 */
async function dragBetween(page: Page, cardId: number, left: number, right: number): Promise<void> {
  const card = (await page.locator(`[data-board-card="${cardId}"]`).boundingBox())!;
  const a = (await page.locator(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${left}"]`).boundingBox())!;
  const b = (await page.locator(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${right}"]`).boundingBox())!;
  const from = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
  const to = { x: (a.x + a.width + b.x) / 2, y: (a.y + a.height / 2 + b.y + b.height / 2) / 2 };
  await page.mouse.move(from.x, from.y, { steps: 6 });
  await page.waitForTimeout(400);
  await page.mouse.down();
  await page.waitForTimeout(400);
  expect(await page.locator(`[data-board-card="${cardId}"]`).getAttribute('data-cast-lift'), 'the card is lifted').toBe('lifted');
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  await page.mouse.up();
}

/** What a player's turn leaves: the land they played, and its row on their own board and the other's. */
interface Play {
  name: string;
  land: number;
  row: number[];
}

async function playLand(me: Page, other: Page, player: string, land: string, between: [string, string]): Promise<Play> {
  const card = ownHandCard(me, land);
  await expect(card.and(me.locator('[data-selectable]')), `${player}: ${land} is offered`).toHaveCount(1, { timeout: 30_000 });
  const id = Number(await card.getAttribute('data-board-card'));
  const named = async (name: string): Promise<number> =>
    Number(await me.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]', { hasText: name }).first().getAttribute('data-board-card'));
  await dragBetween(me, id, await named(between[0]), await named(between[1]));
  await expect.poll(() => rowOf(me, 'you', id), { timeout: 20_000, message: `${player}: ${land} is on their battlefield` }).not.toBeNull();
  await expect.poll(() => rowOf(other, 'them', id), { timeout: 20_000, message: `the other seat sees ${player}'s ${land}` }).not.toBeNull();
  // Settled: the same row on both screens.
  await expect.poll(async () => JSON.stringify(await rowOf(other, 'them', id)), { timeout: 10_000 }).toBe(JSON.stringify(await rowOf(me, 'you', id)));
  const row = (await rowOf(me, 'you', id))!;
  log(`${player} played ${land}`, { id, row });
  return { name: player, land: id, row };
}

/** What the front card's rAF watcher keeps: each lift's first twenty frames, and each change of the table it draws. */
interface Lift {
  t: number;
  /** Which frame of the hold, from 1: the first twenty of each are kept. */
  frame: number;
  name: string;
  tip: { x: number; y: number };
  hand: { id: number; x: number; y: number; w: number; h: number }[];
}
interface Moment {
  t: number;
  back: boolean;
  rows: Record<string, number[] | null>;
}

test(titled('the front page’s replay starts each player’s cursor on the card they lifted, and lands it where the game put it, for both players'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(10 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'replay-cursor');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });

    const plays: Play[] = [await playLand(alice.page, bob.page, 'Alice', 'Mountain', ['Plains', 'Forest'])];
    await grindPriority(
      [alice.page, bob.page],
      async () => {
        const at = await railAt(bob.page);
        return at?.turn === 2 && at.phase === 'MAIN1' && (await ownHandCard(bob.page, 'Swamp').and(bob.page.locator('[data-selectable]')).count()) > 0;
      },
      { timeoutMs: 90_000 },
    );
    plays.push(await playLand(bob.page, alice.page, 'Bob', 'Swamp', ['Island', 'Forest']));
    await bob.page.waitForTimeout(1_500);
    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result'), 'alice sees the result').toBeVisible({ timeout: 30_000 });

    // The recording is written when the game ends.
    await expect.poll(async () => (await alice.context.request.get(`${stack.origin}${PREFIX}/api/replays/${matchId}`)).status(), { timeout: 30_000, message: 'the recording is there' }).toBe(200);
    const recorded = (await (await alice.context.request.get(`${stack.origin}${PREFIX}/api/replays/${matchId}`)).json()) as {
      relays?: { event: string }[];
      presence?: { at: number; seat: number; presence: { held: boolean; pointer: unknown; anchor: unknown } }[];
    };
    log('relayed table messages recorded', (recorded.relays ?? []).map((r) => r.event));
    for (const seat of [0, 1]) {
      const sent = (recorded.presence ?? []).filter((p) => p.seat === seat);
      const lift = sent.findIndex((p) => p.presence.held);
      log(`seat ${seat}'s recorded pointers around its lift`, sent.slice(Math.max(0, lift - 2), lift + 3));
    }

    const carol = await openFriend(browser, 'carol');
    const front = carol.page;
    await resizeWindow(front, { width: 1280, height: 800 });
    await front.addInitScript((lands: number[]) => {
      const w = window as unknown as { __lifts: Lift[]; __moments: Moment[] };
      w.__lifts = [];
      w.__moments = [];
      let heldFrames = 0;
      let last = '';
      const step = (): void => {
        const card = document.querySelector('[data-testid="featured-match"]');
        if (card !== null) {
          const back = card.querySelector('.presence__back');
          const cursor = card.querySelector('.presence');
          heldFrames = back === null ? 0 : heldFrames + 1;
          if (back !== null && heldFrames <= 20 && cursor !== null) {
            const tip = cursor.getBoundingClientRect();
            const hand = [...card.querySelectorAll('[data-zone="hand"][data-owner="you"] [data-board-card]')].map((e) => {
              const r = e.getBoundingClientRect();
              return { id: Number(e.getAttribute('data-board-card')), x: r.left, y: r.top, w: r.width, h: r.height };
            });
            w.__lifts.push({ t: performance.now(), frame: heldFrames, name: cursor.querySelector('.presence__name')?.textContent ?? '', tip: { x: tip.left, y: tip.top }, hand });
          }
          const rows: Record<string, number[] | null> = {};
          for (const id of lands) {
            const row = card.querySelector(`[data-zone="battlefield"] [data-board-card="${id}"]`)?.closest('[data-tier], [data-board-row]');
            rows[id] = row === null || row === undefined ? null : [...row.querySelectorAll('[data-board-card]')].map((e) => Number(e.getAttribute('data-board-card')));
          }
          const state = JSON.stringify({ back: back !== null, rows });
          if (state !== last) {
            last = state;
            w.__moments.push({ t: performance.now(), back: back !== null, rows });
          }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, plays.map((p) => p.land));
    await front.goto(`${stack.origin}${PREFIX}/`);
    await expect(front.getByTestId('featured-match-tag')).toHaveText('REPLAY', { timeout: 30_000 });
    const scale = await front.getByTestId('featured-match').locator('.featured-match__viewport').evaluate((v) => v.getBoundingClientRect().width / 540);
    log('front card scale', scale);
    expect(scale, 'the card draws the board smaller than it is: the case the report was in').toBeLessThan(0.9);

    // One whole pass: both lands arrive, and then the loop takes them away again.
    await expect
      .poll(
        async () =>
          front.evaluate((lands) => {
            const ms = (window as unknown as { __moments: Moment[] }).__moments;
            const both = ms.findIndex((m) => lands.every((id) => m.rows[id] !== null));
            return both >= 0 && ms.slice(both).some((m) => lands.every((id) => m.rows[id] === null));
          }, plays.map((p) => p.land)),
        { timeout: 5 * 60_000, intervals: [500], message: 'the card plays the replay through both plays and loops' },
      )
      .toBe(true);
    const { lifts, moments } = await front.evaluate(() => {
      const w = window as unknown as { __lifts: Lift[]; __moments: Moment[] };
      return { lifts: w.__lifts, moments: w.__moments };
    });

    for (const play of plays) {
      // The lift of this card: its first frame, under this player's name. The pointer rested on the card
      // before it was pressed, so the recording holds that rest and the cursor is already there.
      const lift = lifts.find((l) => l.name === play.name && l.frame === 1 && l.hand.some((c) => c.id === play.land));
      const card = lift?.hand.find((c) => c.id === play.land);
      log(`${play.name}'s lift`, { tip: lift?.tip, card });
      log(`${play.name}'s cursor over the lift's first frames`, lifts.filter((l) => l.name === play.name).slice(0, 20).map((l) => [l.frame, Math.round(l.t), Math.round(l.tip.x), Math.round(l.tip.y)]));
      expect(lift, `${play.name}'s lift is drawn on the card`).toBeDefined();
      const slack = card!.w * 0.15;
      expect.soft(lift!.tip.x, `${play.name}: the cursor starts on the card they lifted (x)`).toBeGreaterThanOrEqual(card!.x - slack);
      expect.soft(lift!.tip.x).toBeLessThanOrEqual(card!.x + card!.w + slack);
      expect.soft(lift!.tip.y, `${play.name}: the cursor starts on the card they lifted (y)`).toBeGreaterThanOrEqual(card!.y - slack);
      expect.soft(lift!.tip.y).toBeLessThanOrEqual(card!.y + card!.h + slack);

      const arrived = moments.findIndex((m) => m.rows[play.land] !== null);
      expect(arrived, `${play.name}'s ${play.land} reaches the battlefield in the replay`).toBeGreaterThanOrEqual(0);
      const gone = moments.slice(arrived).find((m) => !m.back);
      const lingered = gone === undefined ? Infinity : gone.t - moments[arrived]!.t;
      // The row as it stood just before the loop took the card away again.
      const end = moments.slice(arrived).findIndex((m) => m.rows[play.land] === null);
      const settled = moments[end < 0 ? moments.length - 1 : arrived + end - 1]!.rows[play.land];
      log(`${play.name}'s landing`, { lingeredMs: Math.round(lingered), replayRow: settled, liveRow: play.row });
      expect.soft(lingered, `${play.name}: what they let go of is not left standing once the card is in its column`).toBeLessThanOrEqual(1_500);
      expect.soft(settled, `${play.name}: the card lands in the column the game put it in`).toEqual(play.row);
    }
  } finally {
    await stack.stop();
  }
});
