/*
 * Never offer a play Forge will refuse.
 *
 * The operator, 2026-10-11, match m-70cba9014f79:
 *   - "Serra Avenger should not be playable if it's not playable … i tried
 *     playing the card and then it went back to my hand." Forge highlighted it
 *     on the player's second and third turns; its "can't cast during your first,
 *     second, or third turns" is checked only once the cast has begun.
 *   - "i was able to tap rishadan port for the 1 cost ability, but had no way to
 *     pay it and then it untapped." A click on the Port offered both abilities;
 *     "{1},{T}: Tap target land" was taken, its {1} could not be paid (the Port
 *     is the only mana and the {T} is its own), the server cancelled the
 *     payment and Forge untapped the Port.
 *
 * Scenarios `w69-port-alone`, `w69-port-forest`, `w69-serra`.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, clickOnce, makeTitled, pressPaymentAuto, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const OWN_BATTLEFIELD = '.seat[data-viewer] [data-zone="battlefield"]';
const THEIR_BATTLEFIELD = '[data-zone="battlefield"][data-owner="them"]';
const HAND = '[data-zone="hand"][data-owner="you"]';
const TAP_TARGET_LAND = /tap target land/i;

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped')).catch(() => false);
const isOffered = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-selectable')).catch(() => false);
const poolTotal = (page: Page) =>
  page.locator('.seat[data-viewer] [data-mana-pool]').evaluate((el) => Number(el.getAttribute('data-mana-total') ?? '0'));

async function named(page: Page, zone: string, name: string): Promise<number | undefined> {
  const ids = await page
    .locator(`${zone} [data-board-card]`)
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  return ids[0];
}

/** The open "which ability?" pop-up's options, by their plain words; [] when none is open. */
async function abilityChoices(page: Page): Promise<string[]> {
  const options = page.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]');
  if (!(await options.first().isVisible({ timeout: 300 }).catch(() => false))) return [];
  return options.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
}

async function chooseAbility(page: Page, want: RegExp): Promise<void> {
  const options = page.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]');
  const labels = await abilityChoices(page);
  const i = labels.findIndex((l) => want.test(l));
  await options.nth(i >= 0 ? i : 0).click();
}

/** Click the face of a card on the board with a real mouse. */
async function clickFace(page: Page, id: number): Promise<void> {
  const box = (await card(page, id).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const autoCancelled = (stack: { serverLogFile: string }, from: number) => serverLog(stack).slice(from).filter((l) => l.evt === 'auto-cancelled');

test(titled('Rishadan Port with no other mana: "{1},{T}: Tap target land" is never offered, and a click taps the Port for {C}'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-port-alone');
    const a = alice.page;
    await expect.poll(() => named(a, OWN_BATTLEFIELD, 'Rishadan Port'), { timeout: 45_000, message: 'alice controls the Port' }).not.toBeUndefined();
    const port = (await named(a, OWN_BATTLEFIELD, 'Rishadan Port'))!;
    await expect.poll(() => isOffered(a, port), { timeout: 45_000, message: 'the Port is offered at priority (its own mana)' }).toBe(true);

    // The operator's click, and whatever Forge asks after it — taking "Tap target land" wherever it is offered, as they did.
    const logFrom = serverLog(stack).length;
    await clickFace(a, port);
    const offeredAbilities: string[] = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const choices = await abilityChoices(a);
      if (choices.length > 0) {
        offeredAbilities.push(...choices);
        await chooseAbility(a, TAP_TARGET_LAND);
        continue;
      }
      const mountain = await named(a, THEIR_BATTLEFIELD, 'Mountain');
      if (mountain !== undefined && (await isOffered(a, mountain))) await clickFace(a, mountain);
      if (autoCancelled(stack, logFrom).length > 0) break;
      if ((await isTapped(a, port)) && (await poolTotal(a)) === 1) break;
      await a.waitForTimeout(200);
    }
    await a.waitForTimeout(1_500);
    const cancelled = autoCancelled(stack, logFrom);
    const tapped = await isTapped(a, port);
    const pool = await poolTotal(a);
    console.log(
      `[w69-offers] port alone: abilities offered on the click [${offeredAbilities.join(' | ')}]; auto-cancelled ${cancelled.length} (${cancelled.map((l) => String(l.cost)).join(', ')}); Port ${tapped ? 'tapped' : 'untapped'}; pool ${pool}`,
    );
    expect(offeredAbilities.filter((l) => TAP_TARGET_LAND.test(l)), 'the Port\'s "{1},{T}: Tap target land" is offered with no mana to pay its {1}').toEqual([]);
    expect(cancelled, 'no payment was cancelled for want of mana').toEqual([]);
    expect(tapped, 'the click tapped the Port').toBe(true);
    expect(pool, 'for its {C}').toBe(1);
    const bobPort = await named(bob.page, THEIR_BATTLEFIELD, 'Rishadan Port');
    await expect.poll(() => isTapped(bob.page, bobPort!), { timeout: 10_000, message: 'bob sees the Port tapped' }).toBe(true);
  } finally {
    await stack.stop();
  }
});

test(titled('Rishadan Port beside a Forest: "{1},{T}: Tap target land" is offered and taps bob\'s Mountain'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-port-forest');
    const a = alice.page;
    await expect.poll(() => named(a, OWN_BATTLEFIELD, 'Rishadan Port'), { timeout: 45_000, message: 'alice controls the Port' }).not.toBeUndefined();
    const port = (await named(a, OWN_BATTLEFIELD, 'Rishadan Port'))!;
    const forest = (await named(a, OWN_BATTLEFIELD, 'Forest'))!;
    const mountain = (await named(a, THEIR_BATTLEFIELD, 'Mountain'))!;
    await expect.poll(() => isOffered(a, port), { timeout: 45_000, message: 'the Port is offered at priority' }).toBe(true);

    const logFrom = serverLog(stack).length;
    await clickFace(a, port);
    await expect.poll(() => abilityChoices(a), { timeout: 15_000, message: 'a click on the Port asks which ability' }).toContainEqual(expect.stringMatching(TAP_TARGET_LAND));
    const choices = await abilityChoices(a);
    await chooseAbility(a, TAP_TARGET_LAND);

    const steps: string[] = [];
    const deadline = Date.now() + 30_000;
    while (!(await isTapped(a, mountain)) && Date.now() < deadline) {
      if (!steps.includes('target') && (await isOffered(a, mountain))) {
        await clickFace(a, mountain);
        steps.push('target');
      } else if (await pressPaymentAuto(a)) {
        steps.push('auto');
      } else if (!(await isTapped(a, forest)) && (await isOffered(a, forest)) && steps.includes('target')) {
        await clickFace(a, forest);
        steps.push('forest');
      }
      await a.waitForTimeout(300);
    }
    const bobMountain = (await named(bob.page, OWN_BATTLEFIELD, 'Mountain'))!;
    console.log(
      `[w69-offers] port + forest: abilities [${choices.join(' | ')}]; steps [${steps.join(', ')}]; Port ${(await isTapped(a, port)) ? 'tapped' : 'untapped'}, Forest ${(await isTapped(a, forest)) ? 'tapped' : 'untapped'}, Mountain ${(await isTapped(a, mountain)) ? 'tapped' : 'untapped'}; auto-cancelled ${autoCancelled(stack, logFrom).length}`,
    );
    expect(await isTapped(a, mountain), 'the Port tapped bob\'s Mountain').toBe(true);
    expect(await isTapped(a, port), 'the Port is tapped for its cost').toBe(true);
    expect(await isTapped(a, forest), 'the Forest paid the {1}').toBe(true);
    expect(autoCancelled(stack, logFrom), 'no payment was cancelled').toEqual([]);
    await expect.poll(() => isTapped(bob.page, bobMountain), { timeout: 10_000, message: 'bob sees his Mountain tapped' }).toBe(true);
  } finally {
    await stack.stop();
  }
});

test(titled('Serra Avenger is not offered on its caster\'s first three turns, and is offered and casts on the fourth'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-serra');
    const a = alice.page;
    const b = bob.page;
    await expect.poll(() => named(a, HAND, 'Serra Avenger'), { timeout: 45_000, message: 'alice holds Serra Avenger' }).not.toBeUndefined();
    const serra = (await named(a, HAND, 'Serra Avenger'))!;
    // Forge counts a player's turns from the game's real start: the coin toss's winner plays first and has had one.
    const toss = serverLog(stack).find((l) => l.evt === 'coin-toss');
    const before = toss?.winner === 0 ? 1 : 0;
    console.log(`[w69-offers] serra: coin toss won by seat ${String(toss?.winner)}, so alice has had ${before} turn(s) at the scenario's start`);

    const rows: { gameTurn: number; own: number; offered: boolean; returned?: boolean }[] = [];
    let seen = -1;
    let bobSeen = '';
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const line = await says(a);
      const turn = /Turn: (\d+) \(([^)]*)\)/.exec(line);
      const ownMain = /^Priority:/.test(line) && /Main phase, precombat/i.test(line) && turn?.[2] === 'Alice' && Number(turn[1]) !== seen;
      if (ownMain && (await a.locator('[data-testid="live-button-end-turn"]:enabled').count()) > 0) {
        seen = Number(turn![1]);
        // This window's offer has arrived once a Plains is offered (its own mana); then read the Avenger.
        await expect
          .poll(async () => {
            const ids = await a.locator(`${OWN_BATTLEFIELD} [data-board-card][data-selectable]`).count();
            return ids > 0;
          }, { timeout: 15_000, message: `alice's offer for turn ${seen}` })
          .toBe(true);
        await a.waitForTimeout(500);
        const row: (typeof rows)[number] = { gameTurn: seen, own: before + rows.length, offered: await isOffered(a, serra) };
        rows.push(row);
        if (row.own >= 4) break;
        if (row.offered && !rows.some((r) => r.returned !== undefined)) {
          // The operator's click, on a turn Forge refuses the cast: does the Avenger come back?
          await clickHandCard(a, serra);
          await a.waitForTimeout(3_000);
          row.returned = (await named(a, HAND, 'Serra Avenger')) !== undefined;
        }
        await clickOnce(a, line, 'cancel');
        continue;
      }
      const bLine = await says(b);
      const bTurn = /Turn: (\d+) \(([^)]*)\)/.exec(bLine);
      if (/^Priority:/.test(bLine) && bTurn?.[2] === 'Bob' && bLine !== bobSeen && (await b.locator('[data-testid="live-button-end-turn"]:enabled').count()) > 0) {
        bobSeen = bLine;
        await clickOnce(b, bLine, 'cancel');
      }
      await a.waitForTimeout(150);
    }
    for (const r of rows) console.log(`[w69-offers] serra: game turn ${r.gameTurn}, alice's own turn ${r.own}: ${r.offered ? 'OFFERED' : 'not offered'}${r.returned === undefined ? '' : r.returned ? ' — clicked, and it went back to her hand' : ' — clicked, and it left her hand'}`);
    expect(
      rows.filter((r) => r.own < 4 && r.offered).map((r) => `turn ${r.own}`),
      'Serra Avenger is offered on alice\'s first, second or third turn, where Forge refuses the cast',
    ).toEqual([]);
    const fourth = rows.find((r) => r.own === 4);
    expect(fourth, 'alice reached her fourth turn').toBeDefined();
    expect(fourth!.offered, 'Serra Avenger is offered on her fourth turn').toBe(true);

    const castDeadline = Date.now() + 30_000;
    let clicked = false;
    while ((await named(a, OWN_BATTLEFIELD, 'Serra Avenger')) === undefined && Date.now() < castDeadline) {
      if (!clicked && (await named(a, HAND, 'Serra Avenger')) !== undefined) clicked = await clickHandCard(a, serra);
      await pressPaymentAuto(a);
      const line = await says(a);
      if (/Stack: 1 to Resolve/i.test(line)) await clickOnce(a, line, 'ok');
      const bLine = await says(b);
      if (/Stack: 1 to Resolve/i.test(bLine)) await clickOnce(b, bLine, 'ok');
      await a.waitForTimeout(300);
    }
    const resolved = (await named(a, OWN_BATTLEFIELD, 'Serra Avenger')) !== undefined;
    console.log(`[w69-offers] serra: on alice's fourth turn the Avenger ${resolved ? 'resolved onto her battlefield' : 'did NOT resolve'}`);
    expect(resolved, 'Serra Avenger cast on the fourth turn resolves').toBe(true);
    await expect.poll(() => named(b, THEIR_BATTLEFIELD, 'Serra Avenger'), { timeout: 10_000, message: 'bob sees the Avenger on alice\'s battlefield' }).not.toBeUndefined();
  } finally {
    await stack.stop();
  }
});
