/**
 * The operator: *"build a 'stop at' mechanic that essentially works like full control but just for
 * one phase. so basically i can click on 'end step' and the game will progress normally until it
 * reaches my set stop and then give me priority in that phase so i can do stuff."* A stop is one-shot,
 * and it is for the NEXT time that phase comes round on either player's turn: *"if i put a stop on
 * upkeep and it's currently the main phase, then the stop should happen on the next turn at upkeep"*.
 *
 * Two real browsers, `own-spell`: alice's own Main 1, turn 1. Alice clicks End step on the phase rail
 * and passes; the game runs to her end step — a step the default policy passes for her — and her bar
 * is live there. Then she clicks Upkeep, reloads, still sees it marked, and passes: it fires at bob's
 * upkeep on turn 2. Her own end step on turn 3 is passed for her again: the stop was spent.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { makeTitled, serverLog } from './play/board.ts';
import { railAt, type RailAt } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const rail = (page: Page): Locator => page.getByTestId('live-phases');
const row = (page: Page, phase: string): Locator => rail(page).locator(`li[data-phase="${phase}"]`);
const nextPhase = (page: Page): Locator => page.getByTestId('live-button-next-phase');
const endTurn = (page: Page): Locator => page.getByTestId('live-button-end-turn');

/** What the spec saw and pressed, in order — printed whatever the outcome, so a red names the frame it read. */
const trace: string[] = [];
let t0 = Date.now();
const lastSeen = new Map<Page, string>();

/** One screen's {@link RailAt}, read at one instant; a transition is traced. */
async function at(page: Page, who = 'alice'): Promise<RailAt> {
  const now = (await railAt(page)) ?? { phase: '', whose: '', turn: 0, live: false };
  const seen = `${now.turn}:${now.phase}:${now.whose}:${now.live ? 'live' : 'dead'}`;
  if (seen !== lastSeen.get(page)) trace.push(`+${Date.now() - t0} ${who} ${seen}`);
  lastSeen.set(page, seen);
  return now;
}

const pressable = async (button: Locator): Promise<boolean> => (await button.count()) > 0 && (await button.isEnabled());

/** A real pointer click in the middle of the rail's row for `phase`. */
async function clickRow(page: Page, phase: string): Promise<void> {
  const box = await row(page, phase).boundingBox();
  if (box === null) throw new Error(`no rail row for ${phase}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * One press of a live button, at most once per window `key` — never a second press into the next
 * window. A press counts once it took: the button went dead or the screen moved on to another step
 * within the client's own bar-hold bound. A click that took nothing (the button re-rendered under the
 * pointer) frees the key, so the next tick presses again instead of leaving the seat unanswered.
 */
async function pressOnce(page: Page, button: Locator, key: string, pressed: Set<string>): Promise<void> {
  if (pressed.has(key) || !(await pressable(button))) return;
  pressed.add(key);
  const before = await railAt(page);
  const clicked = await button.click({ timeout: 1_000 }).then(() => true, () => false);
  const took =
    clicked &&
    (await expect
      .poll(async () => {
        const now = await railAt(page);
        return !(await pressable(button)) || now?.turn !== before?.turn || now?.phase !== before?.phase;
      }, { timeout: 2_000 })
      .toBe(true)
      .then(() => true, () => false));
  trace.push(`+${Date.now() - t0} press ${key} ${took ? 'took' : clicked ? 'took nothing' : 'timed out'}`);
  if (!took) pressed.delete(key);
}

test(titled('a stop set on the rail holds priority at the next occurrence of that phase, once, on either turn'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    const page = alice.page;
    const pressed = new Set<string>();
    trace.length = 0;
    lastSeen.clear();
    t0 = Date.now();

    await expect(nextPhase(page), "alice's own Main 1 bar").toBeEnabled({ timeout: 60_000 });
    console.log(`[phase-stop] start ${JSON.stringify(await at(page))}`);

    await clickRow(page, 'END_OF_TURN');
    await page.waitForTimeout(300);
    const markedEnd = (await row(page, 'END_OF_TURN').getAttribute('data-stop')) !== null;
    console.log(`[phase-stop] End step marked after the click: ${String(markedEnd)}`);

    // Alice passes her main phases; nothing else is pressed for her.
    let now = await at(page);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      now = await at(page);
      if (now.whose !== 'yours' || (now.phase === 'END_OF_TURN' && now.live)) break;
      if (now.phase === 'MAIN1' || now.phase === 'MAIN2') await pressOnce(page, nextPhase(page), `${now.turn}:${now.phase}`, pressed);
      await page.waitForTimeout(40);
    }
    console.log(`[phase-stop] after passing the main phases ${JSON.stringify(now)}`);
    expect(now, 'alice holds priority in her own end step').toEqual({ phase: 'END_OF_TURN', whose: 'yours', turn: 1, live: true });
    expect(markedEnd, 'the pending stop showed on the rail').toBe(true);
    await expect(row(page, 'END_OF_TURN'), 'the stop is spent once it fired').not.toHaveAttribute('data-stop');

    // Upkeep, set during alice's own end step: the next upkeep is bob's. It is the server's, so a
    // reload still draws it.
    await clickRow(page, 'UPKEEP');
    await expect(row(page, 'UPKEEP'), 'Upkeep marked').toHaveAttribute('data-stop', '');
    await page.reload();
    await expect(row(page, 'UPKEEP'), 'Upkeep still marked after a reload').toHaveAttribute('data-stop', '', { timeout: 30_000 });
    await expect(nextPhase(page), 'her end-step bar is back after the reload').toBeEnabled({ timeout: 30_000 });
    await nextPhase(page).click();

    await expect
      .poll(async () => JSON.stringify(await at(page)), { timeout: 60_000, message: "alice holds priority in bob's upkeep" })
      .toBe(JSON.stringify({ phase: 'UPKEEP', whose: 'theirs', turn: 2, live: true }));
    console.log(`[phase-stop] fired at ${JSON.stringify(await at(page))}`);
    await expect(row(page, 'UPKEEP'), 'the Upkeep stop is spent').not.toHaveAttribute('data-stop');
    await nextPhase(page).click();

    // Bob ends his turn; alice passes her turn-3 main phases. Her end step is passed for her again.
    let heldEndAgain = false;
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      now = await at(page);
      if (now.turn >= 4) break;
      if (now.turn === 3 && now.phase === 'END_OF_TURN' && now.live) heldEndAgain = true;
      if (now.whose === 'yours' && (now.phase === 'MAIN1' || now.phase === 'MAIN2')) await pressOnce(page, nextPhase(page), `${now.turn}:${now.phase}`, pressed);
      const theirs = await at(bob.page, 'bob');
      if (theirs.whose === 'yours') await pressOnce(bob.page, endTurn(bob.page), `bob:${theirs.turn}`, pressed);
      await page.waitForTimeout(40);
    }
    console.log(`[phase-stop] turn 3 done ${JSON.stringify(now)}; alice held her end step again: ${String(heldEndAgain)}`);
    expect(now.turn, 'the game reached turn 4').toBeGreaterThanOrEqual(4);
    expect(heldEndAgain, 'a spent stop does not fire again').toBe(false);

    const log = serverLog(stack).filter((r) => r.seat === 0 && ['stop-set', 'stop-fired', 'stop-cleared'].includes(String(r.evt)));
    console.log(`[phase-stop] log ${JSON.stringify(log.map((r) => [r.evt, r.phase, r.why ?? null]))}`);
    expect(log.map((r) => `${String(r.evt)}:${String(r.phase)}`)).toEqual([
      'stop-set:END_OF_TURN',
      'stop-fired:END_OF_TURN',
      'stop-set:UPKEEP',
      'stop-fired:UPKEEP',
    ]);
  } finally {
    console.log(`[phase-stop] trace ${trace.join(' | ')}`);
    await stack.stop();
  }
});
