/**
 * The operator, 2026-10-10: *"card hidden by windbrisk heights shows as 'card 59' with no art. this is
 * a bit weird. if we need to show a hidden card, can we use a literal 'hidden card' with an ephemeral
 * card back?"* — and: *"when multiple hidden cards are there lets make sure they each get their own
 * 'hidden' card. at the moment it's showing 'card 3' and 'card 59' but only if i open the expanded exile
 * view."*
 *
 * Alice plays two Windbrisk Heights (Exploration gives her the second land drop); each Hideaway exiles
 * one of her top four face down. Forge lets her look at them, so her screen draws each as itself, with
 * its art. Bob's screen is never sent their names: there each is its own card back at the card's own
 * size, named "Hidden card" — in the exile on the board, in the expanded pile view and in the inspector —
 * and nothing on either screen reads "card <id>".
 */
import { expect, test, type Page } from '@playwright/test';

import { castByDrag, grindPriority, handCardNamed, makeTitled, passOverStack, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The scenario's top eight: whatever the two Hideaways exile, it is two of these. */
const TOP_EIGHT = ['Serra Angel', 'Lightning Bolt', 'Counterspell', 'Grizzly Bears', 'Llanowar Elves', 'Savannah Lions', 'Giant Growth', 'Dark Ritual'];
const HIDDEN = 'Hidden card';

const exile = (page: Page, owner: 'you' | 'them') => page.locator(`.seat [data-zone="exile"][data-owner="${owner}"]`);
const inspector = (page: Page) => page.locator('[data-inspect]');
const pileView = (page: Page) => page.getByTestId('pile-view');
const VIEW = '[data-testid="pile-view"]';

interface Drawn {
  back: boolean;
  label: string | null;
  name: string | null;
  art: boolean;
  face: string;
  drawn: string;
  box: string;
}

/** What `scope` draws for the card: a back (and its accessible name), or a face (its name, its art), and its boxes. */
const drawnIn = (page: Page, scope: string, id: number): Promise<Drawn | null> =>
  page.evaluate(
    ({ scope, id }) => {
      const li = document.querySelector(`${scope} li[data-card-id="${id}"]`);
      if (li === null) return null;
      const back = li.querySelector('[data-card-back]');
      const face = li.querySelector('.board-card__face')!.getBoundingClientRect();
      const drawn = (back ?? li.querySelector('.card'))?.getBoundingClientRect();
      const size = (r: DOMRect | undefined): string => (r === undefined ? 'none' : `${Math.round(r.width)}×${Math.round(r.height)}`);
      return {
        back: back !== null,
        label: back?.getAttribute('aria-label') ?? null,
        name: li.querySelector('.card__name')?.textContent?.trim() ?? null,
        art: li.querySelector('img.card__art') !== null,
        face: size(face),
        drawn: size(drawn),
        box: `${Math.round(face.left)},${Math.round(face.top)}`,
      };
    },
    { scope, id },
  );

/** What the open inspector shows: a back and its name, or a face's name. */
const inspected = (page: Page): Promise<{ back: boolean; label: string | null; name: string | null } | null> =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-inspect]');
    if (panel === null) return null;
    const back = panel.querySelector('[data-card-back]');
    return { back: back !== null, label: back?.getAttribute('aria-label') ?? null, name: panel.querySelector('.card__name')?.textContent?.trim() ?? null };
  });

/** Every element, text or accessible name, anywhere on the page that reads "card <digits>". */
const cardIdLabels = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const re = /^card \d+$/i;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const text = el.textContent?.trim() ?? '';
      if (el.children.length === 0 && re.test(text)) out.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> ${text}`);
      for (const attr of ['aria-label', 'title', 'alt', 'data-tip']) {
        const v = el.getAttribute(attr)?.trim() ?? '';
        if (re.test(v)) out.push(`<${el.tagName.toLowerCase()} ${attr}="${v}">`);
      }
    }
    return out;
  });

/** The ids in alice's exile, as `page` draws them. */
const exiledIds = async (page: Page, owner: 'you' | 'them'): Promise<number[]> =>
  (await exile(page, owner).locator('li[data-card-id]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))))).sort((a, b) => a - b);

async function hover(page: Page, scope: string, id: number): Promise<void> {
  const box = (await page.locator(`${scope} li[data-card-id="${id}"] .board-card__face`).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 12), { steps: 4 });
}

/** Alice drags a Windbrisk Heights onto her battlefield; both pass over its Hideaway, she picks the first offered. */
async function hideaway(alice: Page, bob: Page, stack: { serverLogFile: string }, exiledBefore: number): Promise<void> {
  let heights: number | undefined;
  await expect.poll(async () => (heights = await handCardNamed(alice, 'Windbrisk Heights')), { timeout: 60_000 }).not.toBeUndefined();
  const field = (await alice.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
  await castByDrag(alice, stack, heights!, { x: field.x + field.width / 2, y: field.y + field.height / 2 });
  console.log(`[w69-hidden] alice played Windbrisk Heights #${heights}; stack ${await stackCount(alice)}`);
  await grindPriority([alice, bob], async () => (await exiledIds(alice, 'you')).length > exiledBefore && (await stackCount(alice)) === 0, {
    timeoutMs: 60_000,
    press: passOverStack,
  });
}

test(titled("cards Hideaway exiles face down are each their own card back named 'Hidden card' on the screen that may not see them, and themselves on the one that may"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-hidden');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });

    await hideaway(alice.page, bob.page, stack, 0);
    await hideaway(alice.page, bob.page, stack, 1);
    const ids = await exiledIds(alice.page, 'you');
    expect(ids, 'two cards in alice’s exile').toHaveLength(2);
    await expect.poll(() => exiledIds(bob.page, 'them'), { timeout: 10_000, message: "both are in alice's exile on bob's screen" }).toEqual(ids);

    const mine = '.seat [data-zone="exile"][data-owner="you"]';
    const theirs = '.seat [data-zone="exile"][data-owner="them"]';
    const seen: Record<string, Record<number, Drawn | null>> = { aliceBoard: {}, bobBoard: {}, aliceView: {}, bobView: {} };
    const inspectedOn: Record<string, Record<number, Awaited<ReturnType<typeof inspected>>>> = { aliceBoard: {}, bobBoard: {}, bobView: {} };
    for (const id of ids) {
      seen.aliceBoard![id] = await drawnIn(alice.page, mine, id);
      seen.bobBoard![id] = await drawnIn(bob.page, theirs, id);
      console.log(`[w69-hidden] exiled #${id} on alice's board: ${JSON.stringify(seen.aliceBoard![id])}; on bob's: ${JSON.stringify(seen.bobBoard![id])}`);
    }
    // The inspector on the board, each screen, the top card of the pile (the one a pointer reaches there).
    const top = ids.find((id) => seen.bobBoard![id] !== null)!;
    for (const [who, page, scope] of [['aliceBoard', alice.page, mine], ['bobBoard', bob.page, theirs]] as const) {
      const last = Number(await page.locator(`${scope} li[data-card-id]`).last().getAttribute('data-card-id'));
      await hover(page, scope, last);
      await expect(inspector(page)).toHaveCount(1, { timeout: 3_000 });
      inspectedOn[who]![last] = await inspected(page);
      console.log(`[w69-hidden] inspector on ${who} for #${last}: ${JSON.stringify(inspectedOn[who]![last])}`);
      await page.mouse.move(640, 400);
    }

    // The expanded exile view, on each screen.
    const viewIdLabels: Record<string, string[]> = {};
    for (const [who, page, owner] of [['aliceView', alice.page, 'you'], ['bobView', bob.page, 'them']] as const) {
      const pile = (await exile(page, owner).locator(`li[data-card-id="${top}"]`).boundingBox())!;
      await page.mouse.click(pile.x + pile.width / 2, pile.y + 4);
      await expect(pileView(page), `clicking alice's exile opens its pile view on ${who}`).toHaveCount(1, { timeout: 5_000 });
      await expect(pileView(page).locator('li[data-card-id]')).toHaveCount(2);
      for (const id of ids) {
        seen[who]![id] = await drawnIn(page, VIEW, id);
        console.log(`[w69-hidden] exiled #${id} in ${who}: ${JSON.stringify(seen[who]![id])}`);
      }
      if (who === 'bobView') {
        for (const id of ids) {
          await hover(page, VIEW, id);
          await expect(inspector(page)).toHaveCount(1, { timeout: 3_000 });
          inspectedOn.bobView![id] = await inspected(page);
          console.log(`[w69-hidden] inspector in bobView for #${id}: ${JSON.stringify(inspectedOn.bobView![id])}`);
        }
      }
      viewIdLabels[who] = await cardIdLabels(page);
      console.log(`[w69-hidden] "card <id>" anywhere with ${who} open: [${viewIdLabels[who]!.join(' | ')}]`);
      await page.keyboard.press('Escape');
      await expect(pileView(page)).toHaveCount(0, { timeout: 2_000 });
    }

    const aliceIds = await cardIdLabels(alice.page);
    const bobIds = await cardIdLabels(bob.page);
    console.log(`[w69-hidden] "card <id>" anywhere: alice [${aliceIds.join(' | ')}], bob [${bobIds.join(' | ')}]`);

    // Bob may not see them: each its own back, named "Hidden card", on the board and in the expanded view.
    for (const where of ['bobBoard', 'bobView'] as const) {
      for (const id of ids) {
        expect(seen[where]![id], `${where}: #${id} is its own back named 'Hidden card'`).toMatchObject({ back: true, label: HIDDEN, art: false });
        expect(seen[where]![id]!.drawn, `${where}: #${id}'s back fills the card's own face`).toBe(seen[where]![id]!.face);
      }
    }
    // The board's exile is a pile (each card a strip over the last); the expanded view lays every card out side by side.
    await expect(exile(bob.page, 'them').locator('li[data-card-id] [data-card-back]'), "bob's exile pile holds one back per hidden card").toHaveCount(2);
    expect(new Set(ids.map((id) => seen.bobView![id]!.box)).size, 'bobView: the two backs are two places, not one').toBe(2);
    for (const result of [...Object.values(inspectedOn.bobBoard!), ...Object.values(inspectedOn.bobView!)]) {
      expect(result, "bob's inspector shows a back named 'Hidden card'").toEqual({ back: true, label: HIDDEN, name: null });
    }
    // Alice may: each card itself, with its art.
    for (const where of ['aliceBoard', 'aliceView'] as const) {
      for (const id of ids) {
        expect(seen[where]![id]?.back, `${where}: #${id} is drawn as itself`).toBe(false);
        expect(TOP_EIGHT, `${where}: #${id} is named`).toContain(seen[where]![id]?.name);
      }
    }
    for (const id of ids) expect(seen.aliceView![id]?.art, `aliceView: #${id} draws its art`).toBe(true);
    for (const [id, result] of Object.entries(inspectedOn.aliceBoard!)) expect(result?.name, "alice's inspector names it").toBe(seen.aliceBoard![Number(id)]?.name);
    // And nothing anywhere reads "card <id>", the expanded views open or not.
    for (const [who, labels] of Object.entries(viewIdLabels)) expect(labels, `${who}: the screen reads "card <id>" somewhere`).toEqual([]);
    expect(aliceIds, 'alice\'s screen reads "card <id>" somewhere').toEqual([]);
    expect(bobIds, 'bob\'s screen reads "card <id>" somewhere').toEqual([]);
  } finally {
    await stack.stop();
  }
});
