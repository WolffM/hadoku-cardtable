/**
 * Tapping Aether Vial goes straight to the card choice. The operator, 2026-10-16: *"why does aether vial
 * say 'Search your hand? Yes/No' when i tap it? obviously i want to activate it if i tapped it. weird
 * question"*
 *
 * The Vial's ability is a ChangeZone from the hand with `Optional$`, and Forge asks "Search your hand?"
 * before every optional hidden-zone search (`ChangeZoneEffect.changeHiddenOriginResolve`). Its card
 * choice that follows already lets the player pick nothing, and searching one's own hand shuffles
 * nothing and shows the opponent nothing, so the Yes/No is a question with no second answer.
 *
 * `av-aether-vial.state`: alice's Vial has two charge counters; Grizzly Bears (2) and Memnite (0) are
 * in her hand. `av-aether-vial-none.state`: three counters, nothing of mana value 3 in hand.
 */
import { expect, test, type Page } from '@playwright/test';

import { enabledCancel, enabledOk, makeTitled, ownNamed, says, serverLog, stackCount } from './play/board.ts';
import { confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { recordSurface, type Surface } from './play/surface.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const handPick = (page: Page) => page.locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]');
const handNames = (page: Page) => page.locator('[data-zone="hand"][data-owner="you"] .card__name').allTextContents();
const theirBattlefield = (page: Page) => page.locator('[data-zone="battlefield"][data-owner="them"] .card__name').allTextContents();
const isTapped = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`).evaluate((e) => e.hasAttribute('data-tapped'));

/**
 * The Vial's card choice is open: Grizzly Bears is offered from the hand. One Island cannot cast the
 * Bears, so only the choice offers it; Memnite is offered again at priority as a cast.
 */
const choiceOpen = async (page: Page): Promise<boolean> => (await handPick(page).evaluateAll((els) => els.map((e) => e.querySelector('.card__name')?.textContent?.trim()))).includes('Grizzly Bears');

/** Every text alice's yes/no pop-up ever showed. */
const asked = async (confirms: Surface): Promise<string[]> => (await confirms.rows()).filter((r) => r.shown).map((r) => r.text);

/** The server's rows for alice's confirms: what it answered for her, and what it showed her. */
function confirmRows(stack: PlayStack): string {
  return serverLog(stack)
    .filter((r) => r.seat === 0 && (r.evt === 'auto-confirmed' || ((r.evt === 'prompt-forwarded' || r.evt === 'prompt-withheld') && r.kind !== 'priority')))
    .map((r) => `${String(r.evt)} ${String(r.kind ?? '')} ${String(r.why ?? '')}`)
    .join(' | ');
}

/**
 * Tap the Vial, then let priority pass — alice's own window over her ability, bob's — pressing only
 * Forge's priority OK, never a confirm, until `done()` holds or a yes/no is put to alice. `done` gets
 * the server log's length from just before the tap, so it can read what came of the tap alone.
 */
async function tapVial(seated: ScenarioMatch, stack: PlayStack, done: (from: number) => Promise<boolean>): Promise<'done' | 'asked'> {
  const { alice, bob } = seated;
  const [vial] = await ownNamed(alice.page, 'Aether Vial');
  expect(vial, 'alice controls the Vial').toBeDefined();
  const card = alice.page.locator(`[data-board-card="${vial!}"]`);
  await expect
    .poll(() => card.evaluate((e) => e.hasAttribute('data-selectable')), {
      timeout: 45_000,
      message: 'the Vial is offered at priority',
    })
    .toBe(true);
  const from = serverLog(stack).length;
  await card.locator('button').first().click();
  await expect
    .poll(() => isTapped(alice.page, vial!), {
      timeout: 15_000,
      message: 'tapping the Vial activates it',
    })
    .toBe(true);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await done(from)) return 'done';
    if ((await confirmYes(alice.page).count()) > 0) return 'asked';
    for (const page of [alice.page, bob.page]) {
      if ((await stackCount(page)) > 0 && (await enabledOk(page).count()) > 0)
        await enabledOk(page)
          .first()
          .click({ timeout: 1_000 })
          .catch(() => undefined);
    }
    await alice.page.waitForTimeout(100);
  }
  throw new Error(`the Vial's ability never resolved — alice says "${await says(alice.page)}"`);
}

async function playVial(browser: Parameters<typeof startScenarioMatch>[0], scenario: string, body: (seated: ScenarioMatch, confirms: Surface, stack: PlayStack) => Promise<void>): Promise<void> {
  if (!forge.ok) return;
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, scenario);
    const confirms = await recordSurface(seated.alice.page, '[data-testid="live-confirm"]');
    await body(seated, confirms, stack);
    console.log(`[av] ${scenario}: alice was asked ${JSON.stringify(await asked(confirms))}; server: ${confirmRows(stack)}`);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
}

test(titled('tapping Aether Vial goes straight to the card choice; the creature picked enters the battlefield'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  await playVial(browser, 'av-aether-vial', async (seated, confirms, stack) => {
    const { alice, bob } = seated;
    const outcome = await tapVial(seated, stack, () => choiceOpen(alice.page));
    expect(outcome, `alice was asked a yes/no before the card choice: ${JSON.stringify(await asked(confirms))}; server: ${confirmRows(stack)}`).toBe('done');
    const names = await handPick(alice.page).evaluateAll((els) => els.map((e) => e.querySelector('.card__name')?.textContent?.trim() ?? ''));
    expect(names, 'the choice offers the creature of mana value 2 only').toEqual(['Grizzly Bears']);

    await handPick(alice.page).first().locator('button').first().click();
    await expect.poll(async () => (await ownNamed(alice.page, 'Grizzly Bears')).length, { timeout: 15_000, message: 'the Bears enter the battlefield' }).toBe(1);
    await expect
      .poll(() => theirBattlefield(bob.page), {
        timeout: 15_000,
        message: "bob sees the Bears on alice's battlefield",
      })
      .toContain('Grizzly Bears');
    expect(await handNames(alice.page), 'Memnite stays in hand').toEqual(['Memnite']);
    await expect(bob.page.locator('body'), "bob never sees alice's hand").not.toContainText('Memnite');
    expect(await asked(confirms), 'alice was asked nothing').toEqual([]);
    expect(
      serverLog(stack).some((r) => r.evt === 'auto-confirmed' && r.seat === 0),
      "the server answered Forge's search question for her",
    ).toBe(true);
  });
});

test(titled('tapping Aether Vial and choosing nothing leaves the creature in hand'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  await playVial(browser, 'av-aether-vial', async (seated, confirms, stack) => {
    const { alice, bob } = seated;
    const outcome = await tapVial(seated, stack, () => choiceOpen(alice.page));
    expect(outcome, `alice was asked a yes/no before the card choice: ${JSON.stringify(await asked(confirms))}; server: ${confirmRows(stack)}`).toBe('done');
    expect(await asked(confirms), 'nothing was asked before the choice').toEqual([]);

    await enabledCancel(alice.page).first().click();
    // Forge's own guard on a choice left empty ("Cancel Search?") is the player's: answer it. Forge closes
    // the choice and asks in the same instant, so the choice closing says nothing about the question —
    // waiting on it let the poll end before the pop-up was drawn, and the question went unanswered
    // (main d49f3f1d, b0079816). Wait for the question or for the ability to have resolved.
    await expect
      .poll(async () => (await confirmYes(alice.page).count()) > 0 || (await stackCount(alice.page)) === 0, {
        timeout: 15_000,
        message: "Forge's Cancel Search? question, or the ability resolved without one",
      })
      .toBe(true);
    if ((await confirmYes(alice.page).count()) > 0) await confirmYes(alice.page).click();

    await expect
      .poll(() => stackCount(alice.page), {
        timeout: 15_000,
        message: 'the ability resolved',
      })
      .toBe(0);
    await expect
      .poll(() => choiceOpen(alice.page), {
        timeout: 10_000,
        message: 'the card choice is closed',
      })
      .toBe(false);
    expect((await handNames(alice.page)).sort(), 'both creatures stay in hand').toEqual(['Grizzly Bears', 'Memnite']);
    expect(await ownNamed(alice.page, 'Grizzly Bears'), 'nothing entered').toEqual([]);
    expect(await theirBattlefield(bob.page), "bob's view of alice's battlefield").not.toContain('Grizzly Bears');
  });
});

test(titled('tapping Aether Vial with no creature of that mana value in hand asks nothing at all'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  await playVial(browser, 'av-aether-vial-none', async (seated, confirms, stack) => {
    const { alice } = seated;
    let picked = false;
    // Resolved: Forge hands alice a priority window again after the tap (her window over her own
    // ability is passed for her), so nothing of the ability is left to ask.
    const outcome = await tapVial(seated, stack, async (from) => {
      picked ||= /from your hand/i.test(await says(alice.page));
      const priorityAgain = serverLog(stack)
        .slice(from)
        .some((r) => r.seat === 0 && r.evt === 'prompt-forwarded' && r.kind === 'priority');
      return priorityAgain && (await stackCount(alice.page)) === 0;
    });
    expect(outcome, `alice was asked: ${JSON.stringify(await asked(confirms))}; server: ${confirmRows(stack)}`).toBe('done');
    expect(picked, 'no empty card choice was drawn').toBe(false);
    expect(await asked(confirms), 'alice was asked nothing').toEqual([]);
    expect((await handNames(alice.page)).sort(), 'both creatures stay in hand').toEqual(['Grizzly Bears', 'Memnite']);
  });
});
