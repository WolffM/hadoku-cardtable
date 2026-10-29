/**
 * Wave 47 §P, done-when item 5/6: Fast Mode is a real setting, not a no-op.
 * Against a real Forge jar (`w47-pace.state`: seat 1 — "ai", an ordinary
 * human-controlled seat, never Forge's own AI, same convention every other
 * scenario here uses — holds two free creatures and an uncontested Main
 * Phase 1; seat 0 — "human" — holds nothing castable and nothing to respond
 * with, so the server auto-passes its priority and every cast resolves
 * unattended, with nobody's own click standing between the cast and the
 * clock):
 *
 *   - alice (the observer) starts on the harness's own default, Fast Mode ON
 *     (`e2e/prefsLocal.ts`'s `setPlayFastModeDefault`, called for every play
 *     friend) — turned OFF here through the real settings checkbox, never a
 *     second init-script override, because clicking the control a person
 *     actually clicks is the stronger proof that the wiring from
 *     `SettingsPanel` through `LiveBoard` to `pace.ts`'s wrapper is real.
 *   - bob casts his first free creature. With alice paced, her OWN board
 *     must take noticeably longer than bob's own round trip to show it
 *     resolved onto his battlefield.
 *   - alice flips Fast Mode back ON. bob casts his second free creature, and
 *     this time her board must show it resolved with no artificial hold.
 *
 * Bob is never toggled: he stays on the harness default (Fast Mode on)
 * throughout, so his own board is never paced — only alice, the one seat
 * under test, is.
 *
 * ## Why this measures a DURABLE end-state, never the stack's transient count
 *
 * Measured directly building this spec, against two weaker approaches:
 *
 *  - `board.ts`'s own `castCard` (and a DOM poll on `[data-zone="stack"]`'s
 *    count) can both miss the whole cast entirely: this scenario is
 *    unusually fast to resolve (a bare 0-cost vanilla creature, nothing
 *    else on the board to trigger or respond), and the full cast-to-resolve
 *    cycle can complete in well under 50ms when unpaced — faster than a
 *    fixed-timeout poll reliably samples a value that flickers through 1
 *    and back to 0.
 *  - The raw captured wire frames (`alice.captures`, the same log
 *    `e2e/frames.ts` parses for every other spec) are NOT a usable
 *    substitute either: they are timestamped at the moment the BROWSER's
 *    websocket receives a frame, which is BEFORE `pace.ts`'s wrapper ever
 *    sees it — pacing is a purely in-browser JS delay on when `ingest()` is
 *    CALLED, after the frame has already arrived and already been
 *    captured. Measuring capture timestamps therefore measures network
 *    latency, never the pacer.
 *
 * "The creature is now present on the opponent's battlefield, in the
 * viewer's OWN rendered DOM" is different from both: it is what the pacer
 * actually gates (the frame that moves the card's `Zone` to battlefield is
 * the one the resolve delay holds), and once true it STAYS true — a safe
 * thing to poll at a short interval with no risk of sampling past a
 * transient value.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/**
 * How far alice's board must trail bob's own when she is paced. Comfortably
 * below `pace.ts`'s `PACE_DELAYS_MS.resolve` (600ms): the frame that moves a
 * just-cast creature onto the battlefield is classified `'resolve'` and
 * reaches both seats together, and bob (Fast Mode, his own act) draws it at
 * once while a paced alice holds it that long.
 */
const PACED_LOWER_BOUND_MS = 400;
/**
 * How far alice's board may trail bob's when neither is paced: same-host
 * render and poll noise only, and below the paced floor, so the two bounds
 * can never both pass by accident.
 */
const FAST_UPPER_BOUND_MS = PACED_LOWER_BOUND_MS;

/**
 * The ids Forge currently offers, scoped to the viewer's OWN HAND only —
 * never `board.ts`'s own `offered()`, which matches `[data-board-card][data-selectable]`
 * ANYWHERE on the page. Measured directly building this spec: once the
 * first creature resolves onto the battlefield, its id can still carry
 * `data-selectable` there too, and the unscoped helper then hands back a
 * BATTLEFIELD permanent's id where a hand card's was wanted. Scoping to the
 * hand zone removes the ambiguity at the source.
 */
function offeredHandCardIds(page: Page): Promise<number[]> {
  return page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))))
    .then((ids) => ids.sort((a, b) => a - b));
}

/** `id` is on `page`'s own view of SEAT's battlefield (`data-viewer` for the page's own seat, `:not([data-viewer])` for the other). */
function onBattlefield(page: Page, seat: 'viewer' | 'opponent', id: number): Promise<number> {
  const scope = seat === 'viewer' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  return page.locator(`${scope} [data-zone="battlefield"] [data-board-card="${id}"]`).count();
}

/** Milliseconds from now until `page`'s board shows `id` on SEAT's battlefield. */
async function msUntilOnBattlefield(page: Page, seat: 'viewer' | 'opponent', id: number, who: string): Promise<number> {
  const t0 = Date.now();
  await expect
    .poll(() => onBattlefield(page, seat, id), { timeout: 20_000, intervals: [20], message: `${id} shows resolved on ${who}'s board` })
    .toBeGreaterThan(0);
  return Date.now() - t0;
}

/**
 * Cast whichever hand creature bob is offered, and report the id and
 * `lagMs`: how much later alice's OWN board showed it resolved onto bob's
 * battlefield than bob's own board did — the number pacing is free to hold
 * back. Both are watched from the click, side by side, and apart from the
 * loop that answers bob's prompts.
 *
 * Alice's time alone is not the measure. From the click it also counts
 * bob's lift, his driver answering the ability ask and Forge casting and
 * resolving the spell: run 40868462232 read 1232 ms for an unpaced alice
 * whose board drew the creature 31 ms before bob's did, the frame having
 * reached both seats within 11 ms. Watching alice only once bob's board
 * showed it (before that) counted his poll and prompt answers as her hold:
 * run 40854445398 read 1497 ms for an alice 110 ms AHEAD of bob.
 *
 * Deliberately ONE click, no retry: `board.ts`'s own `castCard` gives up
 * after a fixed 3 s, and a caller built on its exception retrying by
 * picking whatever is offered NEXT is wrong here — the first click's effect
 * can legitimately take longer than 3 s to land on a loaded host, and a
 * naive retry then fires a SECOND real cast (the second creature) while the
 * first one's effect is still in flight, consuming both creatures in what
 * was meant to be only the first (paced) cast.
 */
async function castAndMeasure(bob: Page, alice: Page): Promise<{ id: number; lagMs: number }> {
  await expect.poll(() => offeredHandCardIds(bob), { timeout: 150_000, message: 'bob is offered a hand creature' }).not.toEqual([]);
  const id = (await offeredHandCardIds(bob))[0]!;
  await clickHandCard(bob, id);
  const [aliceMs, bobMs] = await Promise.all([
    msUntilOnBattlefield(alice, 'opponent', id, 'alice'),
    msUntilOnBattlefield(bob, 'viewer', id, 'bob'),
    expect
      .poll(
        async () => {
          await answerPrompt(bob);
          return onBattlefield(bob, 'viewer', id);
        },
        { timeout: 20_000, intervals: [50], message: `${id} lands on bob's own battlefield` },
      )
      .toBeGreaterThan(0),
  ]);
  return { id, lagMs: aliceMs - bobMs };
}

test(titled('w47 — Fast Mode off holds a resolving spell on the stack; on, it does not'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w47-pace');

    const fastModeToggle = (await openSettings(alice.page)).locator('[data-testid="live-settings-fast-mode"]');
    await expect(fastModeToggle, 'the harness default is Fast Mode on').toBeChecked();
    await fastModeToggle.uncheck();
    await closeSettings(alice.page);

    /* ── Paced: bob's first cast must take noticeably longer to show on alice's board ── */
    const first = await castAndMeasure(bob.page, alice.page);
    expect(
      first.lagMs,
      `paced: alice's board should hold ${first.id} off the battlefield for roughly pace.ts's resolve delay after bob's shows it; it trailed by only ${first.lagMs}ms`,
    ).toBeGreaterThanOrEqual(PACED_LOWER_BOUND_MS);

    /* ── Fast: bob's second cast must show on alice's board with no artificial hold ── */
    const fastModeToggleAgain = (await openSettings(alice.page)).locator('[data-testid="live-settings-fast-mode"]');
    await fastModeToggleAgain.check();
    await closeSettings(alice.page);

    const second = await castAndMeasure(bob.page, alice.page);
    expect(
      second.lagMs,
      `fast: no artificial hold is allowed; alice's board showed ${second.id} resolved ${second.lagMs}ms after bob's`,
    ).toBeLessThan(FAST_UPPER_BOUND_MS);
  } finally {
    await stack.stop();
  }
});
