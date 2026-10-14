/**
 * The operator, 2026-10-13: *"End step always stop if something can be used. on by default it
 * should be checked on in the settings, and it can be turned off."*
 *
 * The opponent's End step holds the seat's priority when, and only when, it has a real play
 * there — an instant or a non-mana ability it can afford (the same test the attack window
 * uses). With nothing to do it passes on its own. The settings' End step checkbox is on by
 * default; turned off, the End step is passed whatever the seat holds.
 *
 * Two real browsers. `es-end-step-play`: bob's own Main 2, alice holds Lightning Bolt with an
 * untapped Mountain. `es-end-step-idle`: the same, holding a sorcery. Bob presses his own Main 2
 * OK; nothing is pressed for alice until her own End step stop shows.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickOnce, enabledOk, makeTitled, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const rail = (page: Page): Locator => page.getByTestId('live-phases');
const nextPhase = (page: Page): Locator => page.getByTestId('live-button-next-phase');

interface At {
  phase: string;
  whose: string;
  turn: number;
  live: boolean;
}

async function at(page: Page): Promise<At> {
  return {
    phase: (await rail(page).getAttribute('data-phase')) ?? '',
    whose: (await rail(page).getAttribute('data-whose')) ?? '',
    turn: Number(await rail(page).getAttribute('data-turn')),
    live: (await nextPhase(page).count()) > 0 && (await nextPhase(page).isEnabled()),
  };
}

/** Alice's server rows from `from` on, as `evt kind/phase why rule plays`. */
const aliceRows = (stack: PlayStack, from: number): string[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.seat === 0 && /auto-passed|prompt-(withheld|forwarded)/.test(String(r.evt)))
    .map((r) => [r.evt, r.kind ?? r.phase, r.why, r.rule, r.plays === undefined ? undefined : JSON.stringify(r.plays)].filter((x) => x !== undefined).join(' '));

const heldAtTheirEnd = (a: At): boolean => a.phase === 'END_OF_TURN' && a.whose === 'theirs' && a.live;
const atOwnMain = (a: At): boolean => a.phase === 'MAIN1' && a.whose === 'yours' && a.turn === 2;

/**
 * Bob passes his own Main 2; alice is never pressed for. Returns once alice holds a live bar in
 * bob's End step, or once the game has carried her to her own Main 1 — whichever comes first —
 * and whether the End step ever held her.
 */
async function bobEndsHisTurn({ alice, bob }: ScenarioMatch): Promise<{ held: boolean; last: At }> {
  await expect.poll(async () => `${(await at(alice.page)).whose}:${(await at(alice.page)).phase}`, { timeout: 60_000 }).toBe('theirs:MAIN2');
  let held = false;
  let last = await at(alice.page);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    last = await at(alice.page);
    if (heldAtTheirEnd(last)) held = true;
    if (held || atOwnMain(last)) break;
    const line = await says(bob.page);
    if (/^Priority:/.test(line) && /Main phase, postcombat/i.test(line) && (await enabledOk(bob.page).count()) > 0) await clickOnce(bob.page, line, 'ok');
    await alice.page.waitForTimeout(40);
  }
  return { held, last };
}

test(titled("the opponent's End step holds a seat that has a real play, and the log names the rule"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const m = await startScenarioMatch(browser, stack, 'es-end-step-play');
    const logFrom = serverLog(stack).length;
    const { held, last } = await bobEndsHisTurn(m);
    const rows = aliceRows(stack, logFrom);
    console.log(`[end-step] play: held ${held} at ${JSON.stringify(last)}; rows [${rows.join(' | ')}]`);
    expect(held, "alice's priority is held in bob's End step").toBe(true);
    const kept = rows.filter((r) => r.startsWith('prompt-forwarded priority kept play-stop'));
    expect(kept, 'the window was kept by the End step stop, and the log says so').toHaveLength(1);
    expect(kept[0], 'the log names the play').toContain('"name":"Lightning Bolt"');

    await clickOnce(m.alice.page, await says(m.alice.page), 'ok');
    await expect.poll(async () => atOwnMain(await at(m.alice.page)), { timeout: 30_000, message: "one OK takes alice on to her own Main 1" }).toBe(true);
  } finally {
    await stack.stop();
  }
});

test(titled("the opponent's End step passes a seat with nothing to play"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const m = await startScenarioMatch(browser, stack, 'es-end-step-idle');
    const logFrom = serverLog(stack).length;
    const { held, last } = await bobEndsHisTurn(m);
    const rows = aliceRows(stack, logFrom);
    console.log(`[end-step] idle: held ${held} at ${JSON.stringify(last)}; rows [${rows.join(' | ')}]`);
    expect(held, "alice is not held in bob's End step").toBe(false);
    expect(atOwnMain(last), "the game carried alice to her own Main 1").toBe(true);
    expect(rows, 'the End step was judged by the play test and passed').toContain('auto-passed End step nothing-to-do');
  } finally {
    await stack.stop();
  }
});

test(titled("with the End step setting turned off, the opponent's End step passes a seat even holding a play"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const m = await startScenarioMatch(browser, stack, 'es-end-step-play');
    const toggle = (await openSettings(m.alice.page)).getByTestId('live-settings-stop-end-step');
    await expect(toggle, 'the End step stop is on by default').toBeChecked();
    await toggle.uncheck();
    await closeSettings(m.alice.page);
    const logFrom = serverLog(stack).length;
    const { held, last } = await bobEndsHisTurn(m);
    const rows = aliceRows(stack, logFrom);
    console.log(`[end-step] off: held ${held} at ${JSON.stringify(last)}; rows [${rows.join(' | ')}]`);
    expect(held, "alice is not held in bob's End step").toBe(false);
    expect(atOwnMain(last), "the game carried alice to her own Main 1").toBe(true);
    expect(rows, 'the End step was skipped').toContain('auto-passed End step skip-phase');
  } finally {
    await stack.stop();
  }
});
