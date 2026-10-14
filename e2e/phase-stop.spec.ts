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
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const rail = (page: Page): Locator => page.getByTestId('live-phases');
const row = (page: Page, phase: string): Locator => rail(page).locator(`li[data-phase="${phase}"]`);
const nextPhase = (page: Page): Locator => page.getByTestId('live-button-next-phase');
const endTurn = (page: Page): Locator => page.getByTestId('live-button-end-turn');

interface At {
  phase: string;
  whose: string;
  turn: number;
  live: boolean;
}

const trace: string[] = [];
let t0 = Date.now();
const lastSeen = new Map<Page, string>();

async function at(page: Page, who = 'a'): Promise<At> {
  const start = Date.now();
  const phase = (await rail(page).getAttribute('data-phase')) ?? '';
  const whose = (await rail(page).getAttribute('data-whose')) ?? '';
  const turn = Number(await rail(page).getAttribute('data-turn'));
  const live = (await nextPhase(page).count()) > 0 && (await nextPhase(page).isEnabled());
  const seen = `${turn}:${phase}:${whose}:${String(live)}`;
  const ms = Date.now() - start;
  if (seen !== lastSeen.get(page) || ms > 100) trace.push(`+${start - t0} ${who} ${ms}ms ${seen}`);
  lastSeen.set(page, seen);
  return { phase, whose, turn, live };
}

/** A real pointer click in the middle of the rail's row for `phase`. */
async function clickRow(page: Page, phase: string): Promise<void> {
  const box = await row(page, phase).boundingBox();
  if (box === null) throw new Error(`no rail row for ${phase}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** One press of a live button, at most once per (turn, phase) — never a second press into the next window. */
async function pressOnce(page: Page, button: Locator, key: string, pressed: Set<string>): Promise<void> {
  if (pressed.has(key) || (await button.count()) === 0 || !(await button.isEnabled())) return;
  pressed.add(key);
  const start = Date.now();
  await button.click({ timeout: 1_000 }).then(
    () => trace.push(`+${start - t0} press ${key} clicked`),
    () => trace.push(`+${start - t0} press ${key} timed out`) && pressed.delete(key),
  );
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
      const theirs = await at(bob.page, 'b');
      if (theirs.whose === 'yours') await pressOnce(bob.page, endTurn(bob.page), `bob:${theirs.turn}`, pressed);
      await page.waitForTimeout(40);
    }
    console.log(`[phase-stop] trace ${trace.join(' | ')}`);
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
    await stack.stop();
  }
});
