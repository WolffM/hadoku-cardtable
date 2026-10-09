/**
 * The operator: *"i notice priority flashing back and forth in
 * untap/upkeep/draw. that doesn't happen when passing through turns. it's a
 * bit distracting, can you unify that behavior."*
 *
 * Measured against a real match (`docs/planning/wave63-evidence/F/flash.md`):
 * the rail's `data-whose`, the control buttons' `disabled` state and End
 * Turn's `data-highlight` never move during an auto-passed
 * `UNTAP`/`UPKEEP`/`DRAW`. What flashes is `Board.tsx`'s own `.seat__flag`
 * ("priority"), fed by Forge's raw per-frame `HasPriority` wire fact. The fix
 * (`LiveBoard.tsx`'s `withGatedPriority`) draws it only while that seat
 * genuinely has something open, without touching `Board.tsx` or `adapter.ts`.
 *
 * This spec watches all three original candidates (as a sanity check) plus
 * the real one, across a NORMAL turn's `UNTAP`/`UPKEEP`/`DRAW` (nobody
 * clicks anything; the opponent holds and plays nothing, `w63-flash.state`)
 * and the same span reached instead by pressing End Turn (which arms Forge's
 * `skipPhaseDelay` exemption). `[w63-flash]`-tagged rows are printed either
 * way — claws upload evidence on a red run only.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeHeaderSettings, openHeaderSettings } from './play/w32.ts';

const forge = forgeAvailability();
/** The pacer's own tick for a phase frame (`pace.ts`, the `phase` class) — this spec's bound for how late the opponent's flag may light (AE16). Copied, not imported: the UI's transport chain does not type-check under the e2e tsconfig. */
const PACE_PHASE_MS = 250;
const titled = makeTitled(forge);

interface FlashRow {
  t: number;
  /** Wall clock (`Date.now()`), alongside `t`'s own page-relative clock — only the wall clock is comparable across alice's and bob's two pages. */
  wall: number;
  signal: 'whose' | 'phase' | 'turn' | 'end-turn-disabled' | 'end-turn-highlight' | 'next-phase-disabled' | 'priority-flag-you' | 'priority-flag-opp';
  value: string;
}

/**
 * Every change to the rail's `data-whose`/`data-phase`/`data-turn`, and the
 * control buttons' `disabled`/`data-highlight`, from the moment this is
 * called — a `MutationObserver`, the same technique `e2e/w32.spec.ts`'s own
 * `watchPhases` uses, so a flip-and-back within a single task is never
 * missed the way a polled read would miss it.
 */
async function watchFlash(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __flash?: FlashRow[] };
    w.__flash = [];
    const push = (signal: FlashRow['signal'], value: string) => w.__flash!.push({ t: performance.now(), wall: Date.now(), signal, value });

    const rail = document.querySelector<HTMLElement>('[data-testid="live-phases"]');
    if (rail === null) throw new Error('no phase rail to watch');
    push('whose', rail.dataset.whose ?? '');
    push('phase', rail.dataset.phase ?? '');
    push('turn', rail.dataset.turn ?? '');
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName === 'data-whose') push('whose', rail.dataset.whose ?? '');
        else if (m.attributeName === 'data-phase') push('phase', rail.dataset.phase ?? '');
        else if (m.attributeName === 'data-turn') push('turn', rail.dataset.turn ?? '');
      }
    }).observe(rail, { attributes: true, attributeFilter: ['data-whose', 'data-phase', 'data-turn'] });

    const endTurn = document.querySelector<HTMLElement>('[data-testid="live-button-end-turn"]');
    if (endTurn === null) throw new Error('no End Turn button to watch');
    push('end-turn-disabled', String(endTurn.hasAttribute('disabled')));
    push('end-turn-highlight', String(endTurn.hasAttribute('data-highlight')));
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName === 'disabled') push('end-turn-disabled', String(endTurn.hasAttribute('disabled')));
        else if (m.attributeName === 'data-highlight') push('end-turn-highlight', String(endTurn.hasAttribute('data-highlight')));
      }
    }).observe(endTurn, { attributes: true, attributeFilter: ['disabled', 'data-highlight'] });

    const nextPhase = document.querySelector<HTMLElement>('[data-testid="live-button-next-phase"]');
    if (nextPhase === null) throw new Error('no Next Phase button to watch');
    push('next-phase-disabled', String(nextPhase.hasAttribute('disabled')));
    new MutationObserver((muts) => {
      for (const m of muts) if (m.attributeName === 'disabled') push('next-phase-disabled', String(nextPhase.hasAttribute('disabled')));
    }).observe(nextPhase, { attributes: true, attributeFilter: ['disabled'] });

    // `Board.tsx`'s own `.seat__flag`, fed by `BoardPlayer.hasPriority` —
    // read-only here (this spec never touches `Board.tsx` or `adapter.ts`);
    // the fix lives in `LiveBoard.tsx`, the view it hands to `<Board>`.
    for (const [label, scope] of [
      ['you', '.seat[data-viewer]'],
      ['opp', '.seat:not([data-viewer])'],
    ] as const) {
      const seat = document.querySelector<HTMLElement>(`${scope} .seat__counts`);
      if (seat === null) continue;
      const read = () => String(seat.querySelector('.seat__flag:not(.seat__flag--lost)') !== null);
      push(`priority-flag-${label}` as FlashRow['signal'], read());
      new MutationObserver(() => push(`priority-flag-${label}` as FlashRow['signal'], read())).observe(seat, { childList: true, subtree: true });
    }
  });
}

const flashRowsOf = (page: Page): Promise<FlashRow[]> => page.evaluate(() => [...((window as unknown as { __flash?: FlashRow[] }).__flash ?? [])]);

const nextPhaseOffered = (page: Page): Promise<boolean> => page.getByTestId('live-button-next-phase').isEnabled();

/** Timestamps (wall clock) every moment bob's OWN control bar becomes enabled — a real window genuinely opening for him. */
async function watchBobOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __bobOpen?: number[] };
    w.__bobOpen = [];
    for (const testid of ['live-button-next-phase', 'live-button-end-turn']) {
      const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
      if (el === null) continue;
      new MutationObserver(() => {
        if (!el.disabled) w.__bobOpen!.push(Date.now());
      }).observe(el, { attributes: true, attributeFilter: ['disabled'] });
    }
  });
}
const bobOpenTimesOf = (page: Page): Promise<number[]> => page.evaluate(() => [...((window as unknown as { __bobOpen?: number[] }).__bobOpen ?? [])]);

/** Whether `priority-flag-you` and `priority-flag-opp` are ever both `'true'` at the same point in the recorded timeline. */
function bothFlagsEverLit(rows: FlashRow[]): boolean {
  let you = false;
  let opp = false;
  for (const r of [...rows].sort((a, b) => a.t - b.t)) {
    if (r.signal === 'priority-flag-you') you = r.value === 'true';
    else if (r.signal === 'priority-flag-opp') opp = r.value === 'true';
    else continue;
    if (you && opp) return true;
  }
  return false;
}

/** Click whichever of the two control buttons is offered, preferring Next Phase (never End Turn, by default). */
async function passOnce(page: Page, button: 'next-phase' | 'end-turn' = 'next-phase'): Promise<void> {
  const testid = button === 'end-turn' ? 'live-button-end-turn' : 'live-button-next-phase';
  await page.getByTestId(testid).click();
}

/**
 * Drive the match until ALICE's own turn reaches `targetTurn` with a real
 * stop offered — never End Turn here, an ordinary Next Phase on whichever
 * seat (either seat can draw a land and be given a real stop of its own;
 * nothing about this scenario depends on which).
 */
async function advanceToTurn(alice: Page, bob: Page, targetTurn: number, timeoutIterations = 600): Promise<void> {
  for (let i = 0; i < timeoutIterations; i++) {
    for (const p of [alice, bob]) await answerPrompt(p);
    const turnText = await alice.getByTestId('live-phases').getAttribute('data-turn');
    const turn = Number(turnText ?? '0');
    if (turn >= targetTurn && (await nextPhaseOffered(alice))) return;
    let clicked = false;
    for (const p of [alice, bob]) {
      if (await nextPhaseOffered(p)) {
        // Bob holds his window the way a person does before passing: a window answered inside the
        // server's 150 ms grace is never told to the other seat (no flash, by design), so a driver
        // that passes in ~100 ms leaves nothing for alice's flag to measure.
        if (p === bob) await bob.waitForTimeout(600);
        await passOnce(p, 'next-phase');
        clicked = true;
      }
    }
    if (!clicked) await alice.waitForTimeout(100);
  }
  throw new Error(`never reached turn ${targetTurn} with a stop offered`);
}

/** Rows whose `t` falls in `[from, to)`, sorted. */
function windowed(rows: FlashRow[], from: number, to: number): FlashRow[] {
  return rows.filter((r) => r.t >= from && r.t < to).sort((a, b) => a.t - b.t);
}

/** How many times `signal` changed value within `rows` (consecutive duplicates do not count — only real flips). */
function flips(rows: FlashRow[], signal: FlashRow['signal']): number {
  const values = rows.filter((r) => r.signal === signal).map((r) => r.value);
  let n = 0;
  for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) n++;
  return n;
}

/** The `t` of the row that entered `phase` (first occurrence at or after `after`), or `undefined`. */
function enteredAt(rows: FlashRow[], phase: string, after = 0): number | undefined {
  return rows.find((r) => r.signal === 'phase' && r.value === phase && r.t >= after)?.t;
}

/**
 * The start of `turn`'s own begin step: the earlier of the turn counter
 * ticking over and `UPKEEP` being entered (first occurrence of either at or
 * after `after`) — two independent `MutationObserver` callbacks can record
 * the same batched commit a fraction of a millisecond apart, in either
 * order, so the boundary is whichever is seen first, never one alone.
 * `UNTAP` itself is not always its own observable row (a batched commit can
 * skip straight to `UPKEEP`).
 */
function turnBeganAt(rows: FlashRow[], turn: number, after = 0): number {
  const byTurn = rows.find((r) => r.signal === 'turn' && r.value === String(turn) && r.t >= after)?.t;
  const byPhase = rows.find((r) => r.signal === 'phase' && r.value === 'UPKEEP' && r.t >= after)?.t;
  const candidates = [byTurn, byPhase].filter((t): t is number => t !== undefined);
  return candidates.length > 0 ? Math.min(...candidates) : after;
}

/** `signal`'s own value at `at` — the last row recorded at or before it, `'false'` if there is none. */
function valueAt(rows: FlashRow[], signal: FlashRow['signal'], at: number): string {
  return [...rows].filter((r) => r.signal === signal && r.t <= at).sort((a, b) => a.t - b.t).at(-1)?.value ?? 'false';
}

test(titled('untap/upkeep/draw does not flash the drawn priority holder, same as an End-Turn crawl'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w66-flag');
    // The e2e harness forces every friend's Fast Mode ON for speed
    // (`e2e/prefsLocal.ts`'s `setPlayFastModeDefault`) — the OPPOSITE of a
    // real player's own default (`pace.ts`: paced unless the setting is
    // flipped). Fast Mode flushes every queued frame at once, so React
    // batches several phase changes into one commit and the very flash
    // under test cannot be observed at all under it. Alice is turned back to
    // the real default here, exactly through the settings checkbox a person
    // clicks (`e2e/w47-pace.spec.ts`'s own technique).
    const fastModeToggle = (await openHeaderSettings(alice.page)).locator('[data-testid="live-settings-fast-mode"]');
    await expect(fastModeToggle, 'the harness default is Fast Mode on').toBeChecked();
    await fastModeToggle.uncheck();
    await closeHeaderSettings(alice.page);

    await watchFlash(alice.page);
    await watchBobOpen(bob.page);

    // ── Turn 1 (human/alice), MAIN1: ordinary passes carry the match through
    // MAIN2 and into ai's turn 2 — nobody ever presses End Turn here, so ai's
    // whole turn (UNTAP/UPKEEP/DRAW included) auto-passes at Forge's own pace.
    await expect(alice.page.getByTestId('live-phases'), 'turn 1, MAIN1').toHaveAttribute('data-turn', '1');
    await passOnce(alice.page, 'next-phase'); // MAIN1 -> MAIN2
    await expect(alice.page.getByTestId('live-phases')).toHaveAttribute('data-phase', 'MAIN2', { timeout: 20_000 });
    await passOnce(alice.page, 'next-phase'); // MAIN2 -> (combat/end/cleanup auto) -> ai turn 2

    const t2Start = await alice.page.evaluate(() => performance.now());
    await advanceToTurn(alice.page, bob.page, 3);
    const t2End = await alice.page.evaluate(() => performance.now());

    // ── Turn 3 (human/alice again), MAIN1: this time End Turn is pressed,
    // which arms the crawl exemption for the rest of this turn AND ai's
    // turn 4 (ai still has nothing, so nothing stops the crawl before alice's
    // own turn 5).
    await expect(alice.page.getByTestId('live-phases'), 'turn 3, MAIN1').toHaveAttribute('data-turn', '3');
    const t4Start = await alice.page.evaluate(() => performance.now());
    await passOnce(alice.page, 'end-turn');
    await advanceToTurn(alice.page, bob.page, 5);
    const t4End = await alice.page.evaluate(() => performance.now());

    const rows = await flashRowsOf(alice.page);

    // Narrow each window to ai's own UNTAP..DRAW span specifically: from the
    // turn counter ticking over (before its MAIN1, a real decision point and
    // not part of this bug) — never from alice's own trailing combat/cleanup,
    // which can still legitimately ask bob something of its own.
    const normalFrom = turnBeganAt(rows, 2, t2Start);
    const normalTo = enteredAt(rows, 'MAIN1', normalFrom) ?? t2End;
    const crawlFrom = turnBeganAt(rows, 4, t4Start);
    const crawlTo = enteredAt(rows, 'MAIN1', crawlFrom) ?? t4End;

    const normalRows = windowed(rows, normalFrom, normalTo);
    const crawlRows = windowed(rows, crawlFrom, crawlTo);

    for (const [label, win] of [
      ['normal turn 2 UNTAP..DRAW', normalRows],
      ['crawled turn 4 UNTAP..DRAW', crawlRows],
    ] as const) {
      for (const r of win) console.log(`[w63-flash] ${label} +${Math.round(r.t - win[0]!.t)}ms ${r.signal}=${r.value}`);
    }

    const normalWhoseFlips = flips(normalRows, 'whose');
    const crawlWhoseFlips = flips(crawlRows, 'whose');
    const normalHighlightFlips = flips(normalRows, 'end-turn-highlight');
    const crawlHighlightFlips = flips(crawlRows, 'end-turn-highlight');
    const normalEndTurnDisabledFlips = flips(normalRows, 'end-turn-disabled');
    const crawlEndTurnDisabledFlips = flips(crawlRows, 'end-turn-disabled');

    console.log(
      `[w63-flash] flips — whose normal=${normalWhoseFlips} crawl=${crawlWhoseFlips}; ` +
        `end-turn-highlight normal=${normalHighlightFlips} crawl=${crawlHighlightFlips}; ` +
        `end-turn-disabled normal=${normalEndTurnDisabledFlips} crawl=${crawlEndTurnDisabledFlips}`,
    );

    // The rail's `data-whose` is the active player's own fact (`whoseTurn`,
    // `LiveBoard.tsx`) — at most ONE flip, into the new active player, per
    // UNTAP..DRAW span, and the same count whichever way the span was
    // reached.
    expect(normalWhoseFlips, 'a normal turn: data-whose flips at most once, to the active player').toBeLessThanOrEqual(1);
    expect(crawlWhoseFlips, 'an End-Turn crawl: data-whose flips at most once, to the active player').toBeLessThanOrEqual(1);
    expect(normalWhoseFlips, 'a normal turn and an End-Turn crawl flash the holder the same number of times').toBe(crawlWhoseFlips);

    // End Turn's own highlight and enabled state must not be seen toggling
    // back and forth either, across a window where nothing is this seat's to
    // decide.
    expect(normalHighlightFlips, 'a normal turn: End Turn\'s highlight does not flash').toBeLessThanOrEqual(1);
    expect(normalEndTurnDisabledFlips, 'a normal turn: End Turn\'s enabled state does not flash').toBeLessThanOrEqual(1);

    expect(normalRows.filter((r) => r.signal === 'phase').length, 'the normal span actually crossed UNTAP/UPKEEP/DRAW').toBeGreaterThanOrEqual(2);
    expect(crawlRows.filter((r) => r.signal === 'phase').length, 'the crawled span actually crossed UNTAP/UPKEEP/DRAW').toBeGreaterThanOrEqual(2);

    // `Board.tsx`'s own priority flag — measured to be the thing that
    // actually flashed (see this file's module header). Fixed in
    // `LiveBoard.tsx` (`withGatedPriority`), so this is the real assertion,
    // not a diagnosis.
    const normalFlagFlips = flips(normalRows, 'priority-flag-you') + flips(normalRows, 'priority-flag-opp');
    const crawlFlagFlips = flips(crawlRows, 'priority-flag-you') + flips(crawlRows, 'priority-flag-opp');
    console.log(`[w63-flash] priority-flag flips: normal=${normalFlagFlips} crawl=${crawlFlagFlips}`);
    expect(normalFlagFlips, 'a normal turn: the priority flag flips at most once, to the active player').toBeLessThanOrEqual(1);
    expect(crawlFlagFlips, 'an End-Turn crawl: the priority flag flips at most once, to the active player').toBeLessThanOrEqual(1);

    // Neither player's own flag outlives its own window, over the WHOLE
    // match, not only the two narrow spans above.
    expect(bothFlagsEverLit(rows), 'both flags are never lit at the same moment').toBe(false);
    expect(valueAt(rows, 'priority-flag-you', t2Start), 'the viewer’s own flag is off once they have passed their own window').toBe('false');

    // Does the opponent's flag track the server's own "waiting for them"
    // fact with no visible lag behind Forge's real window opening? Measured
    // cross-page (wall clock, not the two pages' own independent
    // `performance.now()`): the gap between bob's own bar going live and
    // alice's flag lighting for him.
    // A correct 1:1 pairing, each side consumed in order — never a global
    // nearest search, which can re-match the same alice event to several
    // bob events and report a lag that is really a pairing mistake.
    const sortedBob = (await bobOpenTimesOf(bob.page)).sort((a, b) => a - b);
    const sortedOpp = rows
      .filter((r) => r.signal === 'priority-flag-opp' && r.value === 'true')
      .map((r) => r.wall)
      .sort((a, b) => a - b);
    const lags: number[] = [];
    let j = 0;
    for (const bobT of sortedBob) {
      while (j < sortedOpp.length && sortedOpp[j]! < bobT) j++;
      if (j >= sortedOpp.length) break;
      lags.push(sortedOpp[j]! - bobT);
      j++;
    }
    console.log(`[w63-flash] opponent-flag lag behind bob's own real window opening: ${lags.join(', ')} ms`);
    // AE16, measured from the SERVER's own clock: every window the server
    // forwarded to bob's seat (`prompt-forwarded`, seat 1 — the wall-clock `t`
    // of the row; the claw's one clock serves both browsers and the server)
    // paired, in order, with the next moment alice's screen lit the flag for
    // him. Alice's view of bob's flag follows that server fact, not a state
    // delta queued behind her paced End Turn crawl — so it lights within one
    // pacer tick of the server forwarding, every window, the crawled turn's
    // included (measured ~4.8 s once per match before the fix).
    const forwarded = serverLog(stack)
      .filter((r) => r.evt === 'prompt-forwarded' && Number(r.seat) === 1 && typeof r.t === 'string')
      .map((r) => Date.parse(r.t as string))
      .sort((a, b) => a - b);
    const serverLags: number[] = [];
    let k = 0;
    for (const at of forwarded) {
      while (k < sortedOpp.length && sortedOpp[k]! < at) k++;
      if (k >= sortedOpp.length) break;
      serverLags.push(sortedOpp[k]! - at);
      k++;
    }
    console.log(`[w63-flash] opponent-flag lag behind the server forwarding bob's window: ${serverLags.join(', ')} ms (${forwarded.length} forwarded)`);
    expect(serverLags.length, 'the server forwarded bob a real window at least once (his Memnite makes his MAIN1 a stop)').toBeGreaterThan(0);
    expect(Math.max(...serverLags), `opponent-flag lag (${serverLags.join(', ')} ms) stays within one pacer tick of the server`).toBeLessThanOrEqual(PACE_PHASE_MS + 200);
  } finally {
    await stack.stop();
  }
});
