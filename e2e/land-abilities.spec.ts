/**
 * The operator, 2026-10-11 (match m-d87aabc2c3e2): *"i have a ghost quarter up
 * and it's my opponents turn, but the game won't let me respond with it? i
 * should be able to tap ghost quarter and use it, why is it not showing as
 * usable?"*
 *
 * The server passed the window for them: its "nothing left to do" rule
 * dropped every land on the seat's own battlefield as a mana source, Ghost
 * Quarter included. A land is a mana source only when every ability Forge
 * offers on it is a mana ability.
 *
 * Scenarios `land-abilities-gq` (bob: Ghost Quarter and a Forest) and
 * `land-only-pass` (bob: one Mountain, the control).
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, enabledOk, handCardNamed, makeTitled, pressOffered, pressPaymentAuto, says, serverLog, stackCount } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const OWN_BATTLEFIELD = '.seat[data-viewer] [data-zone="battlefield"]';
const THEIR_BATTLEFIELD = '[data-zone="battlefield"][data-owner="them"]';
const DESTROY_TARGET_LAND = /destroy target land/i;

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable')).catch(() => false);

async function namedAll(page: Page, zone: string, name: string): Promise<number[]> {
  return page
    .locator(`${zone} [data-board-card]`)
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
}


/** The open "which ability?" pop-up's options, by their plain words; [] when none is open. */
async function abilityChoices(page: Page): Promise<string[]> {
  const options = page.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]');
  if (!(await options.first().isVisible({ timeout: 300 }).catch(() => false))) return [];
  return options.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
}

/** Bob's own window with the Goblin on the stack: his says line names the stack and his OK is live. */
const bobHoldsTheStack = async (bob: Page): Promise<boolean> => /Stack: 1 to Resolve/i.test(await says(bob)) && (await enabledOk(bob).count()) > 0;

/** Seat 1's server rows from `from` on, as `evt kind why`. */
const seatOneRows = (stack: { serverLogFile: string }, from: number): string[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.seat === 1 && /auto-passed|prompt-(withheld|forwarded)/.test(String(r.evt)))
    .map((r) => `${String(r.evt)} ${String(r.kind ?? r.phase ?? '')} ${String(r.why ?? '')}`.trim());

/**
 * Alice casts Raging Goblin; resolves once bob holds the window or the Goblin
 * is on her battlefield, whichever comes first. Returns which.
 */
async function castGoblin(alice: Page, bob: Page): Promise<'bob-window' | 'resolved'> {
  const goblin = await handCardNamed(alice, 'Raging Goblin');
  expect(goblin, 'alice holds Raging Goblin').toBeDefined();
  let clicked = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await bobHoldsTheStack(bob)) return 'bob-window';
    if ((await namedAll(alice, OWN_BATTLEFIELD, 'Raging Goblin')).length > 0) return 'resolved';
    if (!clicked && (await isOffered(alice, goblin!))) clicked = await clickHandCard(alice, goblin!);
    await pressPaymentAuto(alice);
    await alice.waitForTimeout(150);
  }
  throw new Error(`the Goblin was neither answered nor resolved: alice says ${JSON.stringify(await says(alice))}, bob says ${JSON.stringify(await says(bob))}`);
}

test(titled('an untapped Ghost Quarter holds its owner\'s window on the opponent\'s spell, and destroys a land from there'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-abilities-gq');
    const a = alice.page;
    const b = bob.page;
    await expect.poll(async () => (await namedAll(b, OWN_BATTLEFIELD, 'Ghost Quarter')).length, { timeout: 45_000, message: 'bob controls Ghost Quarter' }).toBe(1);
    const quarter = (await namedAll(b, OWN_BATTLEFIELD, 'Ghost Quarter'))[0]!;

    const logFrom = serverLog(stack).length;
    const outcome = await castGoblin(a, b);
    console.log(`[land-abilities] gq: after alice's cast, ${outcome}; bob's rows [${seatOneRows(stack, logFrom).join(' | ')}]`);
    expect(outcome, 'bob is given the window to answer the Goblin with Ghost Quarter').toBe('bob-window');
    expect(await stackCount(b), 'the Goblin is on the stack as bob decides').toBe(1);

    // The operator's response: Ghost Quarter, on alice's Mountain.
    const mountains = await namedAll(b, THEIR_BATTLEFIELD, 'Mountain');
    await expect.poll(() => pressOffered(card(b, quarter)), { timeout: 15_000, message: 'Ghost Quarter is offered at bob’s window, and pressed' }).toBe(true);
    await expect.poll(() => abilityChoices(b), { timeout: 15_000, message: 'a click on Ghost Quarter asks which ability' }).toContainEqual(expect.stringMatching(DESTROY_TARGET_LAND));
    const choices = await abilityChoices(b);
    const options = b.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]');
    await options.nth(choices.findIndex((l) => DESTROY_TARGET_LAND.test(l))).click();
    const target = mountains[0]!;
    await expect.poll(() => isOffered(b, target), { timeout: 15_000, message: 'alice\'s Mountain is offered as the target' }).toBe(true);
    expect(await pressOffered(card(b, target)), 'alice’s Mountain pressed as the target').toBe(true);

    // Ghost Quarter resolves first; alice is asked whether to search for a basic land, and declines.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const gone = (await namedAll(b, THEIR_BATTLEFIELD, 'Mountain')).includes(target) === false;
      const goblinIn = (await namedAll(b, THEIR_BATTLEFIELD, 'Raging Goblin')).length > 0;
      if (gone && goblinIn) break;
      if (/Search your library\?/.test(await says(a)) && (await confirmOpen(a))) await answerConfirm(a, 'no').catch(() => undefined);
      await answerPrompt(a);
      await b.waitForTimeout(250);
    }
    const rows = serverLog(stack)
      .slice(logFrom)
      .filter((r) => r.seat === 0 || r.seat === 1)
      .filter((r) => /auto-|prompt-|ask-/.test(String(r.evt)))
      .map((r) => `${String(r.seat)}:${String(r.evt)} ${String(r.kind ?? r.method ?? r.phase ?? '')} ${String(r.why ?? '')}`.trim());
    console.log(`[land-abilities] gq: rows [${rows.join(' | ')}]; alice says ${JSON.stringify(await says(a))}; bob says ${JSON.stringify(await says(b))}; stack ${await stackCount(b)}`);
    const quarterLeft = (await namedAll(b, OWN_BATTLEFIELD, 'Ghost Quarter')).length;
    const targetLeft = (await namedAll(b, THEIR_BATTLEFIELD, 'Mountain')).includes(target);
    const goblinIn = (await namedAll(b, THEIR_BATTLEFIELD, 'Raging Goblin')).length > 0;
    console.log(
      `[land-abilities] gq: abilities [${choices.join(' | ')}]; Ghost Quarter ${quarterLeft === 0 ? 'sacrificed' : 'still in play'}; target Mountain ${targetLeft ? 'still in play' : 'destroyed'}; Goblin ${goblinIn ? 'resolved' : 'not resolved'}`,
    );
    expect(quarterLeft, 'Ghost Quarter was sacrificed for its ability').toBe(0);
    expect(targetLeft, 'the targeted Mountain was destroyed').toBe(false);
    expect(goblinIn, 'the Goblin resolved after it').toBe(true);
  } finally {
    await stack.stop();
  }
});

test(titled('a seat with only a basic land untapped is still passed on the opponent\'s spell'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-only-pass');
    const logFrom = serverLog(stack).length;
    const outcome = await castGoblin(alice.page, bob.page);
    const rows = seatOneRows(stack, logFrom);
    console.log(`[land-abilities] basics: after alice's cast, ${outcome}; bob's rows [${rows.join(' | ')}]`);
    expect(outcome, 'the Goblin resolved with bob never asked').toBe('resolved');
    expect(rows.filter((r) => r.startsWith('auto-passed')).length, 'the server passed bob\'s window').toBeGreaterThan(0);
  } finally {
    await stack.stop();
  }
});
