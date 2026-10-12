/**
 * Wave 32: what the third play test found, in a real browser against a real Forge.
 *
 *  1. **The start of the game reads `Start`, not `0 Nobody` (Q1), and an End Turn
 *     passes the skipped phases at once (Q5) while an ordinary pass keeps Forge's
 *     own pace.** Operator: *"only when 'end turn' is clicked."* The rail's phase
 *     changes are timestamped in the page, so the gap measured is the one a person
 *     watching would see.
 *  2. **An avatar change reaches the board (Q6).** The watchparty picker saves into
 *     the prefs SDK's write-through cache (`prefs-cache:<user>:watchparty`); the page
 *     writes that row the way the SDK does, and BOTH boards must redraw that seat's
 *     face within a few seconds, with no reload.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`) like
 * `play.spec.ts`; without one each test SKIPS and its title says why. Serves the
 * prebuilt `apps/ui/dist`: rebuild before running.
 *
 * **Wave 33 §E removed the random-game monitor** that used to live here as
 * item 2 ("no creatures, no block (Q10), and a Mana Leak with one spell on
 * the stack answers itself (Q7)"): a long game played by both hands and
 * WATCHED for the situation to occur, which took up to six minutes and had
 * passed vacuously at least once (the wave 32 closing notes' own admission —
 * a run that never met the situation proved nothing about it). Its intent
 * now lives in `w33.spec.ts`'s scripted scenarios (`lone-spell.state`,
 * `no-creatures.state`, `one-creature.state`), each of which lands the game
 * directly in the situation it needs rather than hoping a free-play game
 * reaches it.
 */

import { expect, test, type Page } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { answerConfirm, confirmYes } from './play/confirm.ts';
import { enterMatch, grindPriority, makeTitled, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { recordSurface, type Surface } from './play/surface.ts';
import { frameIntervals, installFrameClock } from './frame-clock.ts';
import { turnNumber } from './play/turn.ts';

test.describe.configure({ mode: 'serial' });

const forge = forgeAvailability();
const titled = makeTitled(forge);

/**
 * Forge's own sleep at a phase it is not set up to skip (`FControlGamePlayback.phasesDelay`):
 * exactly 200 ms, taken on the game thread between one phase and the next.
 */
const FORGE_SLEEP_MS = 200;

/* ── what a page shows ───────────────────────────────────────────────── */

/**
 * The control box's End Turn is pressable (wave 51: enabled only while
 * Forge's second button is End Turn) — AND it really is End Turn, not the
 * Auto Yield repurposing of the same slot on the other seat's turn
 * (`data-yield` is present only in that mode).
 */
const endTurnOffered = (page: Page): Promise<boolean> =>
  page.getByTestId('live-button-end-turn').evaluate((el) => (el as HTMLButtonElement).disabled === false && !el.hasAttribute('data-yield'));

interface PhaseEntry {
  t: number;
  phase: string;
  whose: string;
}

/** Each page's record of its rail (`recordSurface`), timestamped in the page, so a gap is the page's own. */
const rails = new Map<Page, Surface>();
async function watchPhases(page: Page): Promise<void> {
  rails.set(page, await recordSurface(page, '[data-testid="live-phases"]', { attrs: ['data-phase', 'data-whose'], shown: 'present' }));
}

/** Every change of the rail's phase since it was watched, with whose it was then. */
async function phasesOf(page: Page): Promise<PhaseEntry[]> {
  const rail = rails.get(page);
  if (rail === undefined) throw new Error('the rail is not being watched');
  const out: PhaseEntry[] = [];
  for (const r of await rail.rows()) {
    const phase = r.attrs['data-phase'] ?? '';
    if ((out.at(-1)?.phase ?? null) !== phase) out.push({ t: r.t, phase, whose: r.attrs['data-whose'] ?? '' });
  }
  return out;
}
const mark = (page: Page): Promise<number> => page.evaluate(() => performance.now());

const gaps = (entries: PhaseEntry[]): number[] => entries.slice(1).map((e, i) => Math.round(e.t - entries[i]!.t));

/** How many of the page's own animation frames (`frame-clock.ts`) each gap spans. */
const frameGaps = (page: Page, entries: PhaseEntry[]): Promise<number[]> =>
  page.evaluate((ts) => {
    const frameOf = (t: number): number => window.__frameAt.filter((at) => at <= performance.timeOrigin + t).length;
    return ts.slice(1).map((t, i) => frameOf(t) - frameOf(ts[i]!));
  }, entries.map((e) => e.t));

/** Both keep their hands; returns once someone holds priority in their own precombat main with an End Turn button. */
async function toFirstPriority(alice: Friend, bob: Friend): Promise<Friend> {
  for (let i = 0; i < 120; i++) {
    for (const f of [alice, bob]) {
      await answerPrompt(f.page);
      const text = await says(f.page);
      // Wave 35 R2 moved this question off the control bar into its own
      // decision area, so the old bar click here hung forever once that landed.
      //
      // Wave 36 T4: "keep your hand?" moved the same way, into its own
      // `ConfirmPrompt` pop-up — Keep is `prompt-confirm-yes`, the same
      // default this helper always took.
      if (/play or draw/i.test(text) && (await f.page.getByTestId('live-play-or-draw-play').count()) > 0) await f.page.getByTestId('live-play-or-draw-play').click();
      else if (/keep your hand/i.test(text) && (await confirmYes(f.page).count()) > 0) await answerConfirm(f.page, 'yes');
      else if (await endTurnOffered(f.page)) return f;
    }
    await alice.page.waitForTimeout(250);
  }
  throw new Error(`nobody reached priority with End Turn offered; alice: ${await says(alice.page)} | bob: ${await says(bob.page)}`);
}

/* ── 1. Start, and End Turn ──────────────────────────────────────────── */

test(titled('the turn reads Start with no name under it (Q1); End Turn passes skipped phases at once, the preference is scoped to the End Turn seat (Q5)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    for (const f of [alice, bob]) await installFrameClock(f.page);
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await enterMatch(alice, bob, stack.origin);

    // Q1: before turn 1 the rail says Start, and the name that sat under it is gone.
    for (const f of [alice, bob]) {
      await expect(f.page.getByTestId('live-turn-n'), `${f.name}: turn 0 reads Start`).toHaveText('Start');
      expect(turnNumber(await f.page.getByTestId('live-turn-n').textContent()), 'Start is turn 0').toBe(0);
      await expect(f.page.locator('.live__turn-who'), `${f.name}: no name under the turn counter`).toHaveCount(0);
      await expect(f.page.getByTestId('live-phases'), `${f.name}: data-whose stays for the specs`).toHaveAttribute('data-whose', /^(yours|theirs|nobody)$/);
    }

    for (const f of [alice, bob]) await watchPhases(f.page);
    const first = await toFirstPriority(alice, bob);
    const second = first === alice ? bob : alice;
    await expect(first.page.getByTestId('live-turn-n'), 'turn 1 has a number').toHaveText(/^\d+$/);

    // ── End Turn: every phase the seat is not stopped at passes without Forge's pause.
    const clicked = await mark(first.page);
    await first.page.getByTestId('live-button-end-turn').click();
    await expect
      .poll(async () => (await phasesOf(first.page)).filter((e) => e.t > clicked && e.whose === 'theirs').length, { timeout: 60_000, message: 'the End Turn ran the turn out' })
      .toBeGreaterThan(0);
    const own = (await phasesOf(first.page)).filter((e) => e.t > clicked && e.whose === 'yours');
    const endTurnGaps = gaps(own);
    const frames = await frameGaps(first.page, own);
    const frameRate = await frameIntervals(first.page);
    console.log(
      `[w32 q5] End Turn: ${own.map((e) => e.phase).join(' > ')}; gaps ${endTurnGaps.join(', ')} ms = ${frames.join(', ')} frame(s) at p50 ${frameRate.p50} ms/frame; click to first ${Math.round((own[0]?.t ?? clicked) - clicked)} ms`,
    );
    expect(endTurnGaps.length, 'an End Turn passes through several phases to measure').toBeGreaterThanOrEqual(3);
    // "At once": Forge's sleep is a floor under EVERY gap it is taken in, and load only adds to a
    // gap, so a paced End Turn has no gap under FORGE_SLEEP_MS on any runner. One gap under it
    // proves the sleep was skipped; a loaded claw can stretch some skipped gaps past 200 ms (146 to
    // 314 ms seen), but not every one. No absolute bound on the longest gap: that measured the claw.
    expect(Math.min(...endTurnGaps), `End Turn: the phases pass without Forge's own ${FORGE_SLEEP_MS} ms sleep (gaps ${endTurnGaps.join(', ')} ms)`).toBeLessThan(FORGE_SLEEP_MS);

    // ── A pass that is NOT an End Turn: the other seat, on its own turn, presses OK at
    // its main phase; the phases it passes through keep Forge's pace. T6: `board.ts`'s own
    // `grindPriority` — the first seat is not the one being measured, so it is the only one pressed.
    await grindPriority([first.page], () => endTurnOffered(second.page), { timeoutMs: 18_000, intervalMs: 150 });
    expect(await endTurnOffered(second.page), `${second.name} reached its own main phase`).toBe(true);
    const passed = await mark(second.page);
    await second.page.getByTestId('live-button-next-phase').click();
    await expect
      .poll(async () => {
        for (const f of [alice, bob]) await answerPrompt(f.page);
        return (await phasesOf(second.page)).filter((e) => e.t > passed).length;
      }, { timeout: 60_000, message: 'an ordinary pass moved the game on' })
      .toBeGreaterThanOrEqual(2);
    const passes = (await phasesOf(second.page)).filter((e) => e.t > passed && e.whose === 'yours');
    const passGaps = gaps(passes);
    console.log(`[w32 q5] plain pass: ${passes.map((e) => e.phase).join(' > ')}; gaps ${passGaps.join(', ')} ms`);
    // Lane S's finding (`q5-end-turn-pacing.md`): an ordinary pass is our server clicking a
    // live prompt, and Forge's pause is only ever hit by its own auto-pass (End Turn). So an
    // ordinary pass has no pause to measure; what is asserted is the SCOPE, from the bridge's
    // own `pace` lines: the preference went on once, for the End Turn seat only, and was
    // lifted again, and the other seat's ordinary pass never switched it on.
    await expect
      .poll(() => serverLog(stack).filter((l) => l.evt === 'bridge-pace').length, { timeout: 10_000, message: 'the bridge reported the preference flips' })
      .toBeGreaterThanOrEqual(2);
    const pace = serverLog(stack).filter((l) => l.evt === 'bridge-pace').map((l) => `${String(l.seat)}:${String(l.skipPhaseDelay)}`);
    const firstSeat = first === alice ? 0 : 1;
    expect(pace, 'on at the End Turn click for that seat only, then off; nothing for the ordinary pass').toEqual([`${firstSeat}:true`, `${firstSeat}:false`]);
  } finally {
    await stack.stop();
  }
});

/* ── 2. an avatar change reaches the board ───────────────────────────── */

test(titled('changing the saved avatar mid-match redraws that seat\'s face on both boards, with no reload (Q6)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);

    // The chrome keys the SDK's cache by the userId it was handed. In this harness the page's
    // chrome runs as `anon` (measured: the only prefs-cache row on the page is
    // `prefs-cache:anon:watchparty`), so the pick is saved under both keys.
    const save = (page: Page, sprite: string) =>
      page.evaluate(
        (id) => {
          const row = JSON.stringify({ blob: { sprite: id }, userVersion: 1, deviceVersion: 1, cachedAt: Date.now() });
          for (const k of ['prefs-cache:anon:watchparty', 'prefs-cache:e2e-alice-id:watchparty']) localStorage.setItem(k, row);
        },
        sprite,
      );
    // Alice's face, on her own board and on bob's.
    const faceOf = (f: Friend) => (f === alice ? f.page.locator('[data-player-face][data-viewer]') : f.page.locator('[data-player-face]:not([data-viewer])'));
    const navigations: string[] = [];
    for (const f of [alice, bob]) f.page.on('framenavigated', (fr) => fr === f.page.mainFrame() && navigations.push(`${f.name}: ${fr.url()}`));
    const before = navigations.length;

    for (const sprite of ['e2e-sprite-one', 'e2e-sprite-two']) {
      await save(alice.page, sprite);
      for (const f of [alice, bob]) {
        await expect(faceOf(f), `${f.name}: alice's face is redrawn with ${sprite}`).toHaveAttribute('data-avatar', sprite, { timeout: 20_000 });
        await expect(faceOf(f).getByTestId('seat-avatar'), `${f.name}: the face draws that avatar's image`).toHaveAttribute('src', new RegExp(`square_${sprite}\\.png$`));
      }
    }
    expect(navigations.length, 'the pages were not reloaded to show it').toBe(before);
  } finally {
    await stack.stop();
  }
});
