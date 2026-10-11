/**
 * The operator, 2026-10-11: *"Courser of Kruphix should have something where both people can see the top
 * card of the library at all times. and i should be able to click it if its a land. Seems like at the moment
 * there is nothing at all?"*
 *
 * Alice has Courser of Kruphix and Exploration; her library's top three are Mountain, Plains, Serra Angel.
 * With real mouse gestures on two screens:
 *
 *   1. both screens draw Mountain on alice's library — and neither draws bob's top card, which nobody may
 *      see, nor is its name or the next card's ever sent;
 *   2. alice drags Mountain off her library onto her battlefield: it lands, and both screens draw the next
 *      top, Plains;
 *   3. she clicks Plains and clicks her battlefield: it lands too, and both screens draw Serra Angel, which
 *      Forge does not offer (a creature cannot be cast from the top).
 *
 * And the same mark on any card Forge offers outside the hand — the operator, 2026-10-11: *"i played
 * snapcaster mage and it auto-targeted serum visions. i guess thats fine but theres no indicator that that
 * card now has flashback"*: Serum Visions is drawn as playable in her graveyard (on the board and in the
 * opened pile view) once Snapcaster's trigger gives it flashback, never before, never on bob's screen, and
 * casting it from there works.
 */
import { expect, test, type Page } from '@playwright/test';

import type { Friend } from './play/browser.ts';
import { castByDrag, enabledOk, grindPriority, handCardNamed, makeTitled, offeredNamed, pressPaymentAuto, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const library = (owner: 'you' | 'them') => `.seat [data-zone="library"][data-owner="${owner}"]`;
const field = '.seat[data-viewer] [data-zone="battlefield"]';

/** The names `page` draws on a library, top card only. */
const topOf = (page: Page, owner: 'you' | 'them'): Promise<string[]> => page.locator(`${library(owner)} .card__name`).allTextContents().then((t) => t.map((s) => s.trim()));
const landsOn = (page: Page, name: string): Promise<number> =>
  page.locator(`${field} .card__name`).allTextContents().then((t) => t.filter((s) => s.trim() === name).length);
const life = (page: Page) => page.locator('[data-player-face][data-viewer] [data-testid="life"]').textContent().then((t) => Number(t?.trim()));
const topId = (page: Page): Promise<number | null> =>
  page.locator(`${library('you')} [data-board-card]`).first().getAttribute('data-board-card', { timeout: 2_000 }).then(Number).catch(() => null);

/** Whether `name` (as a JSON string value) was ever in what the server sent this browser. */
const received = (f: Friend, name: string): boolean => f.captures.some((c) => c.dir === 'in' && c.text.includes(JSON.stringify(name)));

const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Pass priority only while something is on the stack — alice's own main phase is never passed. */
async function passOverStack(page: Page): Promise<void> {
  if ((await stackCount(page)) === 0 || (await enabledOk(page).count()) === 0) return;
  await enabledOk(page).first().click({ timeout: 1_000 }).catch(() => undefined);
  await expect(enabledOk(page)).toHaveCount(0, { timeout: 2_000 }).catch(() => undefined);
}

/** Both screens draw `name` on alice's library. */
async function bothShowTop(alice: Page, bob: Page, name: string, why: string): Promise<void> {
  await expect.poll(() => topOf(alice, 'you'), { timeout: 30_000, message: `alice's screen draws ${name} on top of her library (${why})` }).toEqual([name]);
  await expect.poll(() => topOf(bob, 'them'), { timeout: 10_000, message: `bob's screen draws ${name} on top of alice's library (${why})` }).toEqual([name]);
}

test(titled("with Courser of Kruphix the top of alice's library is drawn on both screens, and a land there is played off it like a hand card"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-librarytop');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => landsOn(alice.page, 'Courser of Kruphix'), { timeout: 60_000, message: 'Courser of Kruphix is on her battlefield' }).toBe(1);

    // ── 1. Mountain is drawn on her library on both screens; bob's library stays hidden on both.
    await expect.poll(() => offeredNamed(alice.page, 'Island'), { timeout: 60_000, message: 'alice has priority at her main phase' }).not.toBeUndefined();
    console.log(
      `[pp-top] start: alice's library top drawn [${(await topOf(alice.page, 'you')).join(', ')}], on bob's screen [${(await topOf(bob.page, 'them')).join(', ')}]; ` +
        `server sent "Mountain" to alice ${received(alice, 'Mountain')}, to bob ${received(bob, 'Mountain')}; offered to alice: Mountain=${await offeredNamed(alice.page, 'Mountain')}`,
    );
    await bothShowTop(alice.page, bob.page, 'Mountain', 'Courser: play with the top card of your library revealed');
    const leaks = {
      bobTopOnAlice: await topOf(alice.page, 'them'),
      bobTopOnBob: await topOf(bob.page, 'you'),
      elvesSentToAlice: received(alice, 'Llanowar Elves'),
      elvesSentToBob: received(bob, 'Llanowar Elves'),
      angelSentToBob: received(bob, 'Serra Angel'),
      plainsSentToBob: received(bob, 'Plains'),
    };
    console.log(`[pp-top] hidden: ${JSON.stringify(leaks)}`);
    expect(leaks, "bob's library is drawn on neither screen, and no card under a top is sent to anyone").toEqual({
      bobTopOnAlice: [],
      bobTopOnBob: [],
      elvesSentToAlice: false,
      elvesSentToBob: false,
      angelSentToBob: false,
      plainsSentToBob: false,
    });

    // ── 2. Dragged off the library onto her battlefield, Mountain lands; Plains is the next top.
    const mountain = await topId(alice.page);
    expect(mountain, 'Mountain is a card on her library').not.toBeNull();
    await expect.poll(() => offeredNamed(alice.page, 'Mountain'), { timeout: 10_000, message: 'Forge offers Mountain from the top of her library' }).toBe(mountain!);
    const from = centre((await alice.page.locator(`${library('you')} [data-board-card="${mountain}"]`).boundingBox())!);
    const to = centre((await alice.page.locator(field).boundingBox())!);
    const lifeBefore = await life(alice.page);
    await alice.page.mouse.move(from.x, from.y);
    await alice.page.mouse.down();
    await alice.page.mouse.move(to.x, to.y, { steps: 10 });
    const lifted = await alice.page.locator(`[data-board-card="${mountain}"]`).getAttribute('data-cast-lift').catch(() => null);
    await alice.page.mouse.up();
    console.log(`[pp-top] drag Mountain #${mountain} from ${Math.round(from.x)},${Math.round(from.y)} to ${Math.round(to.x)},${Math.round(to.y)}: data-cast-lift=${lifted}`);
    expect(lifted, 'a press on the top card picks it up like a hand card').toBe('lifted');
    await grindPriority([alice.page, bob.page], async () => (await landsOn(alice.page, 'Mountain')) === 1 && (await stackCount(alice.page)) === 0 && (await life(alice.page)) > lifeBefore, {
      timeoutMs: 30_000,
      press: passOverStack,
    });
    console.log(`[pp-top] Mountain landed: alice's battlefield Mountains ${await landsOn(alice.page, 'Mountain')}, bob's view ${await landsOn(bob.page, 'Mountain').catch(() => -1)}, life ${lifeBefore} -> ${await life(alice.page)}`);
    await bothShowTop(alice.page, bob.page, 'Plains', 'the next top after Mountain was played');

    // ── 3. Clicked, then her battlefield clicked: Plains lands; Serra Angel is the next top, shown, not offered.
    const plains = await topId(alice.page);
    await expect.poll(() => offeredNamed(alice.page, 'Plains'), { timeout: 10_000, message: 'Forge offers Plains from the top of her library (Exploration)' }).toBe(plains!);
    const at = centre((await alice.page.locator(`${library('you')} [data-board-card="${plains}"]`).boundingBox())!);
    await alice.page.mouse.move(at.x, at.y, { steps: 4 });
    await expect
      .poll(() => alice.page.locator('[data-inspect] .card__name').first().textContent({ timeout: 1_000 }).then((t) => t?.trim()).catch(() => null), {
        timeout: 5_000,
        message: 'hovering the top card shows it in the inspector',
      })
      .toBe('Plains');
    await alice.page.mouse.click(at.x, at.y);
    const clickLift = await alice.page.locator(`[data-board-card="${plains}"]`).getAttribute('data-cast-lift').catch(() => null);
    await alice.page.mouse.click(to.x, to.y);
    console.log(`[pp-top] click Plains #${plains}, then her battlefield: data-cast-lift after the first click=${clickLift}`);
    const lifeMid = await life(alice.page);
    await grindPriority([alice.page, bob.page], async () => (await landsOn(alice.page, 'Plains')) === 1 && (await stackCount(alice.page)) === 0 && (await life(alice.page)) > lifeMid, {
      timeoutMs: 30_000,
      press: passOverStack,
    });
    await bothShowTop(alice.page, bob.page, 'Serra Angel', 'the next top after Plains was played');
    const angel = await topId(alice.page);
    const offeredAngel = await offeredNamed(alice.page, 'Serra Angel');
    console.log(`[pp-top] Plains landed: battlefield Plains ${await landsOn(alice.page, 'Plains')}, life ${await life(alice.page)}; top now Serra Angel #${angel} on both screens, offered=${offeredAngel}; "Serra Angel" sent to bob ${received(bob, 'Serra Angel')}`);
    expect(offeredAngel, 'Serra Angel on top is shown, never offered').toBeUndefined();
  } finally {
    await stack.stop();
  }
});

const YARD = '.seat [data-zone="graveyard"][data-owner="you"]';

/** How `page` draws card `id` in `scope`: whether it is marked playable, and the ring it is drawn with. */
const markOf = (page: Page, scope: string, id: number) =>
  page.evaluate(
    ({ scope, id }) => {
      const li = document.querySelector(`${scope} [data-board-card="${id}"]`);
      if (li === null) return null;
      const card = li.querySelector('.card');
      return {
        selectable: li.hasAttribute('data-selectable'),
        canAct: li.hasAttribute('data-can-act'),
        ring: card === null ? 'none' : getComputedStyle(card).boxShadow,
      };
    },
    { scope, id },
  );

/** The id of the card named `name` in a graveyard as `page` draws it. */
const yardCard = (page: Page, owner: 'you' | 'them', name: string): Promise<number | null> =>
  page
    .locator(`.seat [data-zone="graveyard"][data-owner="${owner}"] [data-board-card]`)
    .evaluateAll(
      (els, n) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === n).map((e) => Number(e.getAttribute('data-board-card'))),
      name,
    )
    .then((ids) => ids[0] ?? null);

test(titled('a card Snapcaster Mage gives flashback is drawn as playable in the graveyard while Forge offers it, and is cast from there'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-snapcaster');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    let snapcaster: number | undefined;
    await expect
      .poll(async () => (snapcaster = await handCardNamed(alice.page, 'Snapcaster Mage')), { timeout: 60_000, message: 'Snapcaster Mage is in her hand' })
      .not.toBeUndefined();
    await expect.poll(() => offeredNamed(alice.page, 'Snapcaster Mage'), { timeout: 60_000, message: 'alice has priority at her main phase' }).toBe(snapcaster);
    const visions = (await yardCard(alice.page, 'you', 'Serum Visions'))!;
    const before = await markOf(alice.page, YARD, visions);
    console.log(`[pp-snap] before Snapcaster: Serum Visions #${visions} in alice's graveyard ${JSON.stringify(before)}`);
    expect(before?.selectable, 'Serum Visions is not playable before Snapcaster').toBe(false);

    const to = centre((await alice.page.locator(field).boundingBox())!);
    await castByDrag(alice.page, stack, snapcaster!, to);
    await grindPriority([alice.page, bob.page], async () => (await landsOn(alice.page, 'Snapcaster Mage')) === 1 && (await stackCount(alice.page)) === 0, {
      timeoutMs: 60_000,
      press: async (page) => {
        await pressPaymentAuto(page);
        if (/target/i.test(await says(page))) {
          const target = page.locator(`${YARD} [data-board-card="${visions}"][data-selectable] > .board-card__face`);
          if ((await target.count()) > 0) await target.click({ position: { x: 8, y: 6 }, timeout: 1_000 }).catch(() => undefined);
        }
        await passOverStack(page);
      },
    });
    await expect
      .poll(() => offeredNamed(alice.page, 'Serum Visions'), { timeout: 15_000, message: 'Forge offers Serum Visions from her graveyard once Snapcaster gave it flashback' })
      .toBe(visions);
    const board = await markOf(alice.page, YARD, visions);
    const onBob = await markOf(bob.page, '.seat [data-zone="graveyard"][data-owner="them"]', visions);
    console.log(
      `[pp-snap] after Snapcaster: says "${(await says(alice.page)).replace(/\s+/g, ' ').trim()}"; Serum Visions on alice's board ${JSON.stringify(board)}, on bob's ${JSON.stringify(onBob)}`,
    );
    expect(board?.selectable, 'drawn as playable on her board').toBe(true);
    expect(board?.ring, 'with the ring a playable hand card has').not.toBe('none');
    expect(onBob?.selectable, "never on bob's screen").toBe(false);

    const island = (await alice.page.locator(`${YARD} li[data-card-id]`).last().boundingBox())!;
    await alice.page.mouse.click(island.x + island.width / 2, island.y + island.height - 6);
    await expect(alice.page.getByTestId('pile-view'), 'clicking her graveyard opens its pile view').toHaveCount(1, { timeout: 5_000 });
    const inView = await markOf(alice.page, '[data-testid="pile-view"]', visions);
    console.log(`[pp-snap] in the opened pile view: ${JSON.stringify(inView)}`);
    expect(inView?.selectable, 'drawn as playable in the pile view').toBe(true);
    await alice.page.keyboard.press('Escape');
    await expect(alice.page.getByTestId('pile-view')).toHaveCount(0, { timeout: 5_000 });

    // Cast from the graveyard: picked up like a hand card and let go over the table.
    const strip = (await alice.page.locator(`${YARD} [data-board-card="${visions}"]`).boundingBox())!;
    await alice.page.mouse.move(strip.x + strip.width / 2, strip.y + 6);
    await alice.page.mouse.down();
    await alice.page.mouse.move(to.x, to.y, { steps: 10 });
    const lifted = await alice.page.locator(`[data-board-card="${visions}"]`).getAttribute('data-cast-lift').catch(() => null);
    await alice.page.mouse.up();
    const exiled = () => alice.page.locator('.seat[data-viewer] [data-zone="exile"] .card__name').allTextContents();
    await grindPriority([alice.page, bob.page], async () => (await exiled()).includes('Serum Visions') && (await stackCount(alice.page)) === 0, {
      timeoutMs: 60_000,
      press: async (page) => {
        await pressPaymentAuto(page);
        await passOverStack(page);
      },
    });
    const after = await offeredNamed(alice.page, 'Serum Visions');
    console.log(`[pp-snap] cast from the graveyard (data-cast-lift=${lifted}): alice's exile [${(await exiled()).join(', ')}], still offered=${after}`);
    expect(lifted, 'picked up like a hand card').toBe('lifted');
    expect(after, 'once cast it is offered no more').toBeUndefined();
  } finally {
    await stack.stop();
  }
});
