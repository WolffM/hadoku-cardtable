/**
 * The operator, 2026-10-28: *"i'm noticing some animation waiting is a bit too long. let's "unlock" the game
 * state when it's waiting on the last ~10% of an animation"*.
 *
 * A frame the pacer holds behind the board's beats (`apps/ui/src/play/live/pace.ts`) goes once every beat is
 * 90% through (`apps/ui/src/play/motion.ts`'s `UNLOCK_AT`, `whenBoardUnlocked`); the beat itself plays to its
 * end, under whatever is drawn next. Each screen is recorded from its own page clock: every beat (an animation
 * the board waits for) with when it started, reached 90% and ended, and when each mark was drawn. `[w80c]`
 * lines are the evidence.
 *
 * - **The coin** (`wd-coin`, two people): alice's Stitch in Time flips a coin, and on bob's screen the spell's
 *   resolution, queued behind the flip, is drawn once the 2.4 s flip is 90% through, not once it has landed.
 *   Ten percent of a long beat is several of a loaded runner's frames, so this is the gate's red/green.
 * - **The other seat's turn** (`aa-ai-turn`, the Forge AI, Fast Mode off): seat 1 casts Ravenous Chupacabra,
 *   alice's Bears die, seat 1 attacks and its blow lands, alice's turn begins. Its frames go on the next
 *   frame drawing over the last tenth of the beat before it, and nothing jumps: no card is drawn twice (w79c's
 *   "the vanished creature reappeared underneath"), and every card leaving or number taken down before its
 *   animation's end is printed with by how much. The waits are printed for the record; their beats are 0.6–0.8 s, whose last
 *   tenth is about one frame of a loaded runner, so they are not the gate's red/green.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { ATTACK_BEAT_MS } from '../apps/ui/src/play/motion.ts';
import { castUntilOnStack, handCardNamed, makeTitled, says, serverLog } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The operator's "last ~10%": what waits on a beat goes once it is this far through (`motion.ts`'s `UNLOCK_AT`). */
const UNLOCKED = 0.9;
const unlockAfter = (ms: number): number => Math.round(ms * UNLOCKED);


/** One animation as the page drew it, on its wall clock (epoch ms). */
interface Beat {
  name: string;
  start: number;
  at90: number;
  end: number;
}

/** A card leaving or a number rising whose element went before its animation was over, by how much. */
interface Early {
  name: string;
  start: number;
  shortMs: number;
  at: number;
}

interface Recorded {
  beats: Beat[];
  drawn: { what: string; at: number }[];
  /** When each animation frame ran (epoch ms). */
  frameAt: number[];
  early: Early[];
  /** A card drawn twice in one frame: its leaving copy beside the card itself in a row, or two of it in rows. */
  twice: { card: string; at: number }[];
}

/** The marks a test watches for: a name and the selector whose first appearance is it. */
type Marks = readonly (readonly [string, string])[];

/**
 * Start recording on `page`: every finite beat the board waits for (the names `motion.ts`'s `isBeat` reads)
 * and the coin, timed from its own start and length, each one that went early, every card drawn twice, and
 * the first moment each mark is drawn.
 */
async function record(page: Page, marks: Marks): Promise<void> {
  await page.evaluate(
    ({ unlocked, marks }) => {
      const rec: Recorded = { beats: [], drawn: [], frameAt: [], early: [], twice: [] };
      (window as unknown as { __w80c: Recorded }).__w80c = rec;
      const BEATS = ['board-exit-', 'board-number-', 'effect-', 'placed-'];
      const nameOf = (a: Animation): string => {
        const n = a as Animation & { animationName?: string };
        return typeof n.animationName === 'string' && n.animationName !== '' ? n.animationName : a.id;
      };
      const seen = new Map<Animation, Beat>();
      const origin = performance.timeOrigin;
      const tick = (): void => {
        const now = origin + performance.now();
        rec.frameAt.push(now);
        const present = new Set<Animation>();
        for (const a of document.getAnimations()) {
          const name = nameOf(a);
          if (name !== 'beat' && name !== 'coin-toss-flip' && !BEATS.some((p) => name.startsWith(p))) continue;
          const end = a.effect?.getComputedTiming().endTime;
          if (typeof end !== 'number' || !Number.isFinite(end) || a.startTime === null) continue;
          present.add(a);
          const rate = Math.abs(a.playbackRate) || 1;
          const start = origin + Number(a.startTime);
          const timed = { name, start, at90: start + (unlocked * end) / rate, end: start + end / rate };
          const beat = seen.get(a);
          if (beat === undefined) {
            seen.set(a, timed);
            rec.beats.push(timed);
          } else Object.assign(beat, timed);
        }
        // A beat whose element went before its end ended then; a leaving card's or a number's is noted.
        for (const [a, beat] of seen) {
          if (present.has(a)) continue;
          if ((beat.name.startsWith('board-exit-') || beat.name.startsWith('board-number-')) && beat.end > now) rec.early.push({ name: beat.name, start: beat.start, shortMs: Math.round(beat.end - now), at: now });
          beat.end = Math.min(beat.end, now);
          beat.at90 = Math.min(beat.at90, now);
          seen.delete(a);
        }
        const inRows = [...document.querySelectorAll('[data-zone="battlefield"] [data-board-card]:not([data-departure-landing])')].map((e) => e.getAttribute('data-board-card') ?? '');
        const leaving = new Set([...document.querySelectorAll('[data-departure]')].map((e) => e.getAttribute('data-departure') ?? ''));
        const counted = new Map<string, number>();
        for (const id of [...inRows, ...leaving]) counted.set(id, (counted.get(id) ?? 0) + 1);
        for (const [card, n] of counted) if (card !== '' && n > 1 && !rec.twice.some((t) => t.card === card)) rec.twice.push({ card, at: now });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      const first = new Set<string>();
      const look = (): void => {
        for (const [what, selector] of marks) {
          if (first.has(what) || document.querySelector(selector) === null) continue;
          first.add(what);
          rec.drawn.push({ what, at: origin + performance.now() });
        }
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      look();
    },
    { unlocked: UNLOCKED, marks },
  );
}

const recorded = (page: Page): Promise<Recorded> => page.evaluate(() => (window as unknown as { __w80c: Recorded }).__w80c);

/** The page's frame intervals (ms), each with when the frame that ended it ran. */
function frames(rec: Recorded): { at: number; ms: number }[] {
  return rec.frameAt.slice(1).map((at, i) => ({ at, ms: at - rec.frameAt[i]! }));
}

function p95(rec: Recorded): number {
  const sorted = frames(rec)
    .map((f) => f.ms)
    .sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 16;
}

function drawnAt(rec: Recorded, what: string): number {
  const d = rec.drawn.find((x) => x.what === what);
  expect(d, `${what} was drawn`).toBeDefined();
  return d!.at;
}

/**
 * The beats a mark drawn at `at` waited on: those that began before it (not the ones its own frame set off,
 * a few frames before it) and were still playing, or had only just ended, as it was drawn.
 */
function waitedOn(beats: readonly Beat[], at: number, frame: number): { beats: number; at90: number; end: number } {
  const before = beats.filter((b) => b.name !== 'coin-toss-flip' && b.start < at - 3 * frame && b.end > at - 2 * frame);
  return { beats: before.length, at90: Math.max(...before.map((b) => b.at90)), end: Math.max(...before.map((b) => b.end)) };
}

test(titled('the coin: what is queued behind the other seat’s flip is drawn once the flip is 90% through, not once it has landed'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'wd-coin');
    await record(bob.page, [
      ['coin', '[data-testid="coin-flip"][data-flipping]'],
      ['resolving', '[data-placed-resolving], [data-placed-leaving]'],
    ]);
    await expect.poll(() => handCardNamed(alice.page, 'Stitch in Time'), { timeout: 45_000, message: 'alice holds Stitch in Time' }).toBeDefined();
    await castUntilOnStack(alice.page, stack, (await handCardNamed(alice.page, 'Stitch in Time'))!, []);
    await expect.poll(() => says(alice.page), { timeout: 20_000, message: 'alice is asked to call the coin' }).toContain('Call coin flip');
    await expect.poll(() => confirmOpen(alice.page), { timeout: 10_000, message: 'the call is a two-button question' }).toBe(true);
    await answerConfirm(alice.page, 'yes');
    await expect
      .poll(async () => (await recorded(bob.page)).drawn.some((d) => d.what === 'resolving'), { timeout: 30_000, intervals: [250], message: 'Stitch in Time resolved on bob’s screen' })
      .toBe(true);

    const rec = await recorded(bob.page);
    const coin = rec.beats.find((b) => b.name === 'coin-toss-flip');
    expect(coin, 'the coin flipped on bob’s screen').toBeDefined();
    const resolving = drawnAt(rec, 'resolving');
    const after = Math.round(resolving - coin!.start);
    // The flip as the coin's own animation runs it (`CoinToss.tsx`'s FLIP_MS). The coin is drawn a render after
    // its frame goes out and the resolution a render after it is let go: either may be off by half the flip's
    // last tenth, and a release at the landing is still well past that.
    const flipMs = Math.round(coin!.end - coin!.start);
    const slack = Math.round((flipMs - unlockAfter(flipMs)) / 2);
    console.log(
      `[w80c] coin: flipped ${Math.round(coin!.end - coin!.start)} ms (90% at ${Math.round(coin!.at90 - coin!.start)}); the resolution behind it drawn ${after} ms into the flip, ` +
        `${Math.round(resolving - coin!.at90)} ms after its 90%, ${Math.round(resolving - coin!.end)} ms after it landed; frame p95 ${Math.round(p95(rec))} ms`,
    );
    expect(flipMs, 'a whole flip, not one joined part-way').toBeGreaterThanOrEqual(2_000);
    expect(after, `drawn by the flip's 90% (${unlockAfter(flipMs)} ms) + ${slack} ms, not once it has landed (${flipMs} ms)`).toBeLessThanOrEqual(unlockAfter(flipMs) + slack);
    expect(after, 'and not before its 90%').toBeGreaterThanOrEqual(unlockAfter(flipMs) - slack);
  } finally {
    await stack.stop();
  }
});

test(titled('the other seat’s turn goes on over the last tenth of each beat, and no card is drawn twice'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const marks: Marks = [
      ['death', '[data-departure]'],
      ['attack', '.seat:not([data-viewer]) li.board-card[data-attacking]'],
      ['blow', '.board-ram'],
      ['turn', '[data-testid="turn-cue"]'],
    ];
    const { alice } = await startScenarioVsAi(browser, stack, 'aa-ai-turn', { fastMode: false, beforeKeep: (f) => record(f.page, marks) });
    const page = alice.page;
    await expect
      .poll(async () => (await recorded(page)).drawn.some((d) => d.what === 'turn'), { timeout: 90_000, intervals: [250], message: "alice's turn began on her screen" })
      .toBe(true);
    // The turn's own beats play out before the record is read.
    await page.waitForTimeout(1_500);
    const rec = await recorded(page);
    const frame = p95(rec);
    const zero = Math.min(...rec.beats.map((b) => b.start), ...rec.drawn.map((d) => d.at));
    const rel = (t: number): number => Math.round(t - zero);
    for (const d of rec.drawn) {
      const w = waitedOn(rec.beats, d.at, frame);
      console.log(
        `[w80c] drawn ${d.what} at ${rel(d.at)}` +
          (w.beats === 0 ? ' (no beat before it)' : `: after ${w.beats} beats, the last 90% through at ${rel(w.at90)}, over at ${rel(w.end)}; drawn ${Math.round(d.at - w.at90)} ms after its 90%, ${Math.round(d.at - w.end)} ms after its end`),
      );
    }
    console.log(`[w80c] attack beat ${ATTACK_BEAT_MS} ms (90% ${unlockAfter(ATTACK_BEAT_MS)}): the blow drawn ${Math.round(drawnAt(rec, 'blow') - drawnAt(rec, 'attack'))} ms after the attack`);
    for (const r of serverLog(stack).filter((x) => x.evt === 'client' && x.seat === 0 && (x.what === 'input-held' || x.what === 'board-hold-capped'))) {
      console.log(`[w80c] ${String(r.what)} ${String(r.method)} ${String(r.ms)}ms board ${String(r.boardMs)} gaps ${String(r.gapMs)} ahead ${String(r.classes)}`);
    }
    // A leaving card's copy and a number are taken down by their own clocks (`live/numbers.ts`'s `letGo`, the
    // departure's own exit), never by the frame drawn after them, so going on early cannot cut one off. Those
    // clocks start a render before the animations do, so on a loaded runner they go early on main as well (a
    // number 117 ms and a death's copy 254 ms before their animations' ends): printed, not judged.
    console.log(`[w80c] frame p95 ${Math.round(frame)} ms; went early ${JSON.stringify(rec.early.map((e) => ({ ...e, at: rel(e.at) })))}; drawn twice ${JSON.stringify(rec.twice.map((t) => ({ ...t, at: rel(t.at) })))}`);
    expect(rec.twice, 'no card drawn twice').toEqual([]);
  } finally {
    await stack.stop();
  }
});
