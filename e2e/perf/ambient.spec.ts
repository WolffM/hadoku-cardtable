/**
 * What a match costs while nobody does anything (the operator, 2026-11-20: *"some parts of the site feel
 * laggy … also during the game"*). Prod's frame telemetry (`perf` client events, 2026-11-06..20) says where
 * to look: our own script was a median 2 % of a slow stretch's time, most slow stretches were in a main
 * phase with nothing being played, and what was running in them was the board's own loops — the flyers'
 * float (`fly-figure`, `fly-shadow`, `fly-tilt`), a waiting spell's `stack-float` and the OK button's
 * `live-ok-pulse`. On the integrated GPU of the player with the most slow frames (59 Hz, 1.5 device pixels),
 * a loop that never stops is a cost that never stops.
 *
 * One crowded mid-game board (`perf-ambient.state`: three flyers a side among the creatures), both seats
 * on prod's common screen (1664×950, 1.5 device pixel ratio) with real JPEG art (`real-art.ts`), and four
 * windows, each traced with nothing added to the page (`threads.ts`):
 *
 *   board         alice's main phase, pointer still, both screens
 *   board-paused  the same with every animation paused: the floor the loops are measured against
 *   stack         a Divination waiting on bob's answer, both screens
 *   stack-without-pulse / stack-without-loops
 *                 the same with the OK button's pulse paused, then the stack's own loops: whose cost it is
 *   hover         alice's pointer across her battlefield, one card at a time
 *
 * `[ambient]` lines and `e2e/.run/perf/ambient.json` are the evidence: each renderer's threads, the shared
 * GPU and browser threads, frames drawn per second, and what was animating. Chromium decides whether an
 * animation runs on the compositor as it starts, so the `not composited` list names only the ones that started
 * inside the window; the paused windows are how a loop already running is costed. Asserts only that each
 * window measured something.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one it SKIPS and its title
 * says why. `[nightly]`: run on a claw on purpose with `-f only=e2e -f specs='perf/ambient.spec.ts'`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { castCard, makeTitled, offeredCard, passOverStack, pressPaymentAuto, stackCount } from '../play/board.ts';
import { forgeAvailability, startPlayStack } from '../play/harness.ts';
import { startScenarioMatch } from '../play/scenario.ts';
import { serveRealArt } from './real-art.ts';
import { emulateScreen, logThreads, runningAnimations, traceSeats, type ThreadReport } from './threads.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SCREEN = { width: 1664, height: 950 };
const DPR = 1.5;
const WINDOW_MS = 6_000;
const HOVER_MS = 3_000;

type Seats = { label: string; page: Page }[];
const results: Record<string, Record<string, ThreadReport | [string, number][]>> = {};

/** Trace `seats` for `ms` while `during` runs (or nothing does), and print each seat and the shared threads. */
async function window(name: string, seats: Seats, ms: number, during?: () => Promise<void>): Promise<Record<string, ThreadReport>> {
  const animating = await Promise.all(seats.map(({ page }) => runningAnimations(page)));
  const trace = await traceSeats(seats[0]!.page.context().browser()!, seats);
  await (during === undefined ? seats[0]!.page.waitForTimeout(ms) : during());
  const r = await trace.stop();
  results[name] = { ...r };
  for (const [i, { label }] of seats.entries()) {
    logThreads('ambient', `${name} ${label}`, r[label]!);
    console.log(`[ambient] ${name} ${label}: animating ${animating[i]!.map(([n, c]) => `${n}×${c}`).join(', ') || 'nothing'}`);
    results[name]![`${label} animating`] = animating[i]!;
  }
  logThreads('ambient', `${name} shared`, r.shared!);
  for (const { label } of seats) expect(r[label]!.threads.length, `${name}: the trace saw ${label}'s page`).toBeGreaterThan(0);
  return r;
}

/** Pause (or resume) `page`'s running animations: every one, or only those whose name (`runningAnimations`'s) is in `names`. */
const pause = (page: Page, paused: boolean, names?: readonly string[]): Promise<void> =>
  page.evaluate(
    ([p, only]) => {
      for (const a of document.getAnimations()) {
        const name = a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? `t:${a.transitionProperty}` : a.id;
        if (only !== null && !only.includes(name)) continue;
        if (p) a.pause();
        else a.play();
      }
    },
    [paused, names ?? null] as const,
  );

/** The stack's loops, and the OK button's pulse: the two groups a waiting spell starts. */
const STACK_LOOPS = ['stack-float', 'stack-drift-x', 'stack-drift-turn'];
const OK_PULSE = ['live-ok-pulse'];

test(titled('[nightly] perf: a crowded board left alone, with its loops and without, a spell waiting, and a hover'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const prepare = async (page: Page): Promise<void> => {
      await serveRealArt(page);
      await emulateScreen(page, SCREEN, DPR);
    };
    const { alice: a, bob: b } = await startScenarioMatch(browser, stack, 'perf-ambient', { beforeAlice: prepare, beforeBob: prepare });
    const alice = a.page;
    const bob = b.page;
    const both: Seats = [
      { label: 'alice', page: alice },
      { label: 'bob', page: bob },
    ];
    // Alice's turn, her main phase, Divination offered: the board is drawn and waiting on her.
    const divination = await offeredCard(alice, 'Divination', { zone: 'hand' });
    for (const page of [alice, bob]) await page.mouse.move(4, 4);
    await alice.waitForTimeout(1_500);

    await window('board', both, WINDOW_MS);
    for (const { page } of both) await pause(page, true);
    await window('board-paused', both, WINDOW_MS);
    for (const { page } of both) await pause(page, false);

    await castCard(alice, divination);
    await pressPaymentAuto(alice);
    await expect.poll(() => stackCount(alice), { message: 'Divination waits on the stack', timeout: 30_000 }).toBeGreaterThan(0);
    await alice.mouse.move(4, 4);
    await alice.waitForTimeout(1_000);
    await window('stack', both, WINDOW_MS);
    // Which of the two groups the waiting spell's cost is: each paused in turn, the other still running.
    for (const [name, group] of [
      ['stack-without-pulse', OK_PULSE],
      ['stack-without-loops', STACK_LOOPS],
    ] as const) {
      for (const { page } of both) await pause(page, true, group);
      await window(name, both, WINDOW_MS);
      for (const { page } of both) await pause(page, false, group);
    }
    await passOverStack(bob);
    await expect.poll(() => stackCount(alice), { message: 'Divination resolves', timeout: 30_000 }).toBe(0);
    await alice.waitForTimeout(1_000);

    const cards = await alice.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').all();
    const centres = (await Promise.all(cards.map((c) => c.boundingBox()))).flatMap((box) => (box === null ? [] : [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]));
    expect(centres.length, 'alice has cards to hover').toBeGreaterThan(4);
    await window('hover', [{ label: 'alice', page: alice }], HOVER_MS, async () => {
      const each = HOVER_MS / centres.length;
      for (const c of centres) {
        await alice.mouse.move(c.x, c.y, { steps: 4 });
        await alice.waitForTimeout(each);
      }
    });

    const dir = resolve(import.meta.dirname, '../.run/perf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'ambient.json'), JSON.stringify(results, null, 1));
  } finally {
    await stack.stop();
  }
});
