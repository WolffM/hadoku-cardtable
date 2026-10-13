/**
 * The operator, 2026-10-12: *"Jace's sanctum reduces the cost of instants and sorceries. can we
 * display modified costs on cards in hand using our applied overlay tags? should apply to anything
 * that modifies anything in hand"*
 *
 *  1. Alice controls Jace's Sanctum. Her Think Twice ({1}{U}) wears a {U} cost tag and her
 *     Divination ({2}{U}) a {1}{U} one, each with a tooltip naming the Sanctum; her Grizzly Bears
 *     wears none. Bob's screen draws no cost of hers.
 *  2. Bob controls Thalia, Guardian of Thraben: Alice's Shock ({R}) wears a {1}{R} tag naming
 *     Thalia, her Grizzly Bears none. Her Vedalken Orrery lets her cast spells as though they had
 *     flash: the Bears wears a Flash tag naming the Orrery, the Shock (an instant) does not.
 *
 * Every step prints one `[mc-hand-costs]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test
 * SKIPS and its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { handCardNamed, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[mc-hand-costs] ${JSON.stringify({ step, data })}`);

/** Alice's hand card of this name, by id, once it is drawn. */
async function held(page: Page, name: string): Promise<number> {
  let id: number | undefined;
  await expect.poll(async () => (id = await handCardNamed(page, name)), { timeout: 30_000, message: `${name} is in hand` }).not.toBeUndefined();
  return id!;
}

const tagsOf = (id: number): string => `[data-zone="hand"][data-owner="you"] [data-board-card="${id}"] > .board-card__keywords`;

/** The cost tag on a held card: its tokens (`data-cost`) and its pips as drawn, or null when it wears none. */
async function costTag(page: Page, id: number): Promise<{ cost: string; pips: string[] } | null> {
  const tag = page.locator(`${tagsOf(id)} > [data-cost]`);
  if ((await tag.count()) === 0) return null;
  return {
    cost: (await tag.getAttribute('data-cost')) ?? '',
    pips: await tag.locator('.pip[data-token]').evaluateAll((els) => els.map((e) => e.getAttribute('data-token') ?? '')),
  };
}

/** Rest the pointer on the middle of `selector` (tags take no pointer events: the tooltip finds them by box). */
async function hover(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`nothing drawn at ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
}

const tip = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="board-tip"]');
    return el === null || getComputedStyle(el).visibility === 'hidden' ? null : (el.textContent ?? '').trim();
  });

async function tipOn(page: Page, selector: string, want: RegExp, label: string): Promise<void> {
  let seen: string | null = null;
  await hover(page, selector);
  try {
    await expect.poll(async () => (seen = await tip(page)), { timeout: 5_000, message: `${label}: the tooltip names the source` }).toMatch(want);
  } finally {
    log(label, { selector, seen });
  }
}

/** Wait for a held card's cost tag to read `cost`, logging what it read. */
async function expectCost(page: Page, id: number, name: string, cost: string | null): Promise<void> {
  let seen: Awaited<ReturnType<typeof costTag>> = null;
  try {
    await expect
      .poll(async () => (seen = await costTag(page, id))?.cost ?? null, { timeout: 30_000, message: `${name}'s cost tag` })
      .toBe(cost);
  } finally {
    log(`${name} cost`, { id, seen });
  }
  if (cost !== null) expect(seen!.pips, `${name}'s tag draws its cost as pips`).toEqual(cost.split(' '));
}

test(titled("Jace's Sanctum: a held instant and sorcery show their reduced cost, a creature does not"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'mc-sanctum');
    const { alice, bob } = seated;
    const page = alice.page;
    const twice = await held(page, 'Think Twice');
    const divination = await held(page, 'Divination');
    const bears = await held(page, 'Grizzly Bears');

    await expectCost(page, twice, 'Think Twice', 'U');
    await expectCost(page, divination, 'Divination', '1 U');
    await expectCost(page, bears, 'Grizzly Bears', null);
    await tipOn(page, `${tagsOf(twice)} > [data-cost]`, /Jace's Sanctum/, 'Think Twice tag');
    await tipOn(page, `${tagsOf(divination)} > [data-cost]`, /Jace's Sanctum/, 'Divination tag');

    // Hidden information: the other screen draws no cost of Alice's.
    const theirs = await bob.page.locator('[data-zone="hand"][data-owner="them"] [data-cost]').count();
    log('bob sees', { costTagsOnAlicesHand: theirs });
    expect(theirs, "Bob's screen draws no cost tag on Alice's hand").toBe(0);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('Thalia raises a held noncreature spell, and a granted flash is tagged on the card it reaches'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'mc-thalia');
    const page = seated.alice.page;
    const shock = await held(page, 'Shock');
    const bears = await held(page, 'Grizzly Bears');

    await expectCost(page, shock, 'Shock', '1 R');
    await expectCost(page, bears, 'Grizzly Bears', null);
    await tipOn(page, `${tagsOf(shock)} > [data-cost]`, /Thalia, Guardian of Thraben/, 'Shock tag');

    const flash = (id: number) => page.locator(`${tagsOf(id)} > [data-keyword="flash"]`);
    await expect(flash(bears), 'the Bears wears a Flash tag').toHaveCount(1, { timeout: 30_000 });
    await tipOn(page, `${tagsOf(bears)} > [data-keyword="flash"]`, /^Flash\b.*Vedalken Orrery/, 'Bears flash tag');
    const shockFlash = await flash(shock).count();
    log('shock flash', { count: shockFlash });
    expect(shockFlash, 'an instant wears no Flash tag').toBe(0);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
