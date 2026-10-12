/**
 * The operator, 2026-10-12:
 *
 *  1. *"when any of our symbols are hovered … show a little tooltip for what it means (summoning
 *     sickness, token, keywords, etc."* Alice hovers the sick mark on her Hill Giant, the token mark
 *     on her Goblin and the Flying tag the aura gave her Grizzly Bears: each says what it means.
 *     Hovering the sick creature's art says nothing — the mark is where the tooltip lives, and the
 *     inspector still opens there.
 *  2. *"Reflector Mage's trigger bounced Sylvan Advocate and locked it from being cast until
 *     Hadoku's next turn … let's make the card greyed out and when hovered we can show a tooltip
 *     explaining it."* Alice's Reflector Mage bounces Bob's Ambush Viper: in Bob's hand it is drawn
 *     forbidden and its tooltip names Reflector Mage and Alice's next turn — on his own turn too.
 *     From Alice's next turn he can cast it (it has flash) and it is drawn as any other card.
 *
 * Every step prints one `[tp-tooltips]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test
 * SKIPS and its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { castCard, enabledOk, grindPriority, handCardNamed, makeTitled, offered, says, clickOnce } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { turnNumber } from './play/turn.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SCENARIO = 'tp-tooltips';
const log = (step: string, data: unknown): void => console.log(`[tp-tooltips] ${JSON.stringify({ step, data })}`);

/** The card of this name in `owner`'s `zone` as `page` draws it, by id. */
async function cardNamed(page: Page, zone: 'battlefield' | 'hand', owner: 'you' | 'them', name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator(`[data-zone="${zone}"][data-owner="${owner}"] [data-board-card]`)
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is in the ${owner} ${zone}` },
    )
    .not.toBeUndefined();
  return id!;
}

/** Rest the pointer on the middle of `selector` (marks take no pointer events: this is where the eye is, not a hit target). */
async function hover(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`nothing drawn at ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
}

/** What the board's tooltip says now, or null when none is showing. */
const tip = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="board-tip"]');
    return el === null || getComputedStyle(el).visibility === 'hidden' ? null : (el.textContent ?? '').trim();
  });

/** Hover `selector` and wait for the tooltip to say something matching `want`. */
async function tipOn(page: Page, selector: string, want: RegExp, label: string): Promise<string | null> {
  let seen: string | null = null;
  await hover(page, selector);
  try {
    await expect.poll(async () => (seen = await tip(page)), { timeout: 5_000, message: `${label}: the tooltip says what it means` }).toMatch(want);
  } finally {
    log(label, { selector, seen });
  }
  return seen;
}

test(titled('the sick mark, the token mark and a keyword tag each show a tooltip naming what they mean'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO);
    const { alice, bob } = seated;
    const page = alice.page;
    const giant = await cardNamed(page, 'battlefield', 'you', 'Hill Giant');
    const bears = await cardNamed(page, 'battlefield', 'you', 'Grizzly Bears');
    const goblin = await page
      .locator('[data-zone="battlefield"][data-owner="you"] [data-board-card][data-token]')
      .first()
      .getAttribute('data-board-card');
    expect(goblin, 'alice has a token').not.toBeNull();

    await tipOn(page, `[data-board-card="${giant}"] > .board-card__marks > [data-mark="sick"]`, /summoning sick/i, 'sick mark');
    await tipOn(page, `[data-board-card="${goblin}"] > .board-card__marks > [data-mark="token"]`, /token/i, 'token mark');
    await tipOn(page, `[data-board-card="${bears}"] > .board-card__keywords > [data-keyword="flying"]`, /^Flying\b.*block/i, 'flying tag');

    // The art of the sick creature is the inspector's, not the sick mark's.
    await hover(page, `[data-board-card="${giant}"] > .board-card__face`);
    await expect(page.locator('[data-inspect]'), 'the inspector opens on the card').toHaveCount(1, { timeout: 5_000 });
    await expect.poll(() => tip(page), { timeout: 2_000, message: 'no tooltip over the art' }).toBeNull();
    log('art hover', { tip: await tip(page) });

    // The same marks on the other screen say the same thing.
    await tipOn(bob.page, `[data-board-card="${giant}"] > .board-card__marks > [data-mark="sick"]`, /summoning sick/i, 'sick mark (bob)');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('a creature Reflector Mage bounced is greyed in its owner\'s hand with a tooltip naming the Mage, and castable again from the Mage\'s controller\'s next turn'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO);
    const { alice, bob } = seated;
    const viperOnField = await cardNamed(alice.page, 'battlefield', 'them', 'Ambush Viper');
    const turn = async (): Promise<number> => turnNumber(await alice.page.getByTestId('live-turn-n').textContent());

    // Alice casts the Mage; its trigger takes the Viper (the one creature she may target).
    let mage: number | undefined;
    await expect.poll(async () => (mage = await handCardNamed(alice.page, 'Reflector Mage')), { timeout: 30_000 }).not.toBeUndefined();
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'Reflector Mage is offered' }).toContain(mage!);
    await castCard(alice.page, mage!);
    const viperInHand = (): Promise<number | undefined> => handCardNamed(bob.page, 'Ambush Viper');
    await grindPriority(
      [alice.page, bob.page],
      async () => (await viperInHand()) !== undefined,
      {
        timeoutMs: 60_000,
        press: async (page) => {
          const target = page.locator(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${viperOnField}"][data-selectable]`);
          if (page === alice.page && (await target.count()) > 0) {
            await target.locator(':scope > .board-card__face').click().catch(() => undefined);
            return;
          }
          if ((await enabledOk(page).count()) > 0) await clickOnce(page, await says(page), 'ok');
        },
      },
    );
    const viper = (await viperInHand())!;
    log('bounced', { viper, turn: await turn() });
    const viperLi = `[data-zone="hand"][data-owner="you"] [data-board-card="${viper}"]`;
    const forbidden = () => bob.page.locator(viperLi).getAttribute('data-cast-forbidden');

    // Forbidden on Bob's screen as soon as Forge next asks him anything, and through his own turn.
    await grindPriority([alice.page, bob.page], async () => (await forbidden()) !== null, { timeoutMs: 60_000 });
    log('forbidden', { turn: await turn(), says: await says(bob.page) });
    const why = await tipOn(bob.page, `${viperLi} > .board-card__face`, /Reflector Mage/, 'forbidden viper');
    expect(why, 'the tooltip names how long').toMatch(/Alice's next turn/);
    // Greyed by a veil over the face (never a filter on the card image).
    const veil = await bob.page.locator(`${viperLi} > .board-card__face`).evaluate((el) => {
      const v = getComputedStyle(el, '::before');
      return { content: v.content, background: v.backgroundColor };
    });
    log('forbidden veil', veil);
    expect(veil.content, 'the card is drawn greyed').not.toBe('none');
    expect(veil.background, 'the card is drawn greyed').not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);

    await grindPriority([alice.page, bob.page], async () => (await turn()) >= 2, { timeoutMs: 60_000 });
    await expect.poll(forbidden, { timeout: 30_000, message: 'still forbidden on Bob\'s own turn' }).not.toBeNull();
    log('bob turn', { turn: await turn(), forbidden: await forbidden() });

    // From Alice's next turn he may cast it: offered, and no longer drawn forbidden.
    await grindPriority(
      [alice.page, bob.page],
      async () => (await turn()) >= 3 && (await offered(bob.page)).includes(viper),
      {
        timeoutMs: 120_000,
        press: async (page) => {
          if (page === bob.page && (await turn()) >= 3 && (await offered(bob.page)).includes(viper)) return;
          await answerPrompt(page);
          if ((await enabledOk(page).count()) > 0) await clickOnce(page, await says(page), 'ok');
        },
      },
    );
    log('castable again', { turn: await turn(), forbidden: await forbidden() });
    expect(await forbidden(), 'no longer drawn forbidden').toBeNull();
    await hover(bob.page, `${viperLi} > .board-card__face`);
    await bob.page.waitForTimeout(500);
    expect(await tip(bob.page), 'and its tooltip is gone').toBeNull();
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
