/**
 * The operator, 2026-10-19: *"let's start introducing a custom context menu for some quick actions. The
 * first quick action i need is 'stack all of the same tokens'"* — in match m-e6863c7810f1 their tokens of
 * one kind sat in many piles (the match log's last `arrangement` for seat 0: piles of 2, 2, 1, 1, 2, …).
 *
 * The operator, 2026-10-20: *"keep tapped and untapped as their own stacks. when untap happens, players
 * can rightclick to do the tap action again"*.
 *
 * Alice has six 1/1 Soldier tokens (two tapped), a Soldier with a +1/+1 counter, a Goblin token and a
 * Grizzly Bears. Every token arrives in its own column; she piles two untapped Soldiers by hand, so the
 * four untapped are split across three piles. A right-click on a lone Soldier opens the board's own menu
 * (the browser's never shows); Escape closes it. Again, and "Stack all of the same tokens": the four
 * untapped Soldiers are one pile and the two tapped another, on her screen and on bob's. The countered
 * Soldier and the Goblin stay where they were — not the same token — and a right-click on a card with
 * nothing to stack opens no menu at all.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, onTopPoint, pointerDrag } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Alice's battlefield, on her own screen (`you`) or on bob's (`them`). */
const field = (page: Page, side: 'you' | 'them') =>
  page.locator(`.seat${side === 'you' ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"]`);
const card = (page: Page, side: 'you' | 'them', id: string) => field(page, side).locator(`li.board-card[data-card-id="${id}"]`);
/**
 * Every pile of alice's battlefield, as its card ids base first, tier by tier (each screen draws her
 * tiers in its own order — bob's mirrors them) and in column order within a tier: what both screens
 * must agree on.
 */
const piles = async (page: Page, side: 'you' | 'them'): Promise<string[]> =>
  (
    await field(page, side)
      .locator('[data-tier] > li.board-card')
      .evaluateAll((els) =>
        els.map((e) => ({
          tier: e.parentElement!.closest('[data-tier]')!.getAttribute('data-tier')!,
          pile: [e.getAttribute('data-card-id'), ...Array.from(e.querySelectorAll(':scope > ul > li.board-card'), (m) => m.getAttribute('data-card-id'))].join('+'),
        })),
      )
  )
    .sort((a, b) => a.tier.localeCompare(b.tier))
    .map((p) => `${p.tier}:${p.pile}`);
const idsOf = (pile: string): string[] => pile.slice(pile.indexOf(':') + 1).split('+');
const pileOf = (all: readonly string[], id: string): string[] => {
  const pile = all.find((p) => idsOf(p).includes(id));
  return pile === undefined ? [] : idsOf(pile);
};
const menu = (page: Page) => page.getByRole('menu');
const stackItem = (page: Page) => menu(page).getByRole('menuitem', { name: 'Stack all of the same tokens' });
/** A real right-click where a press on the card lands — the mouse, not a dispatched event. */
const rightClick = async (page: Page, id: string): Promise<void> => {
  const at = onTopPoint(await boxOf(card(page, 'you', id)));
  await page.mouse.click(at.x, at.y, { button: 'right' });
};

test(titled('right-click a token → Stack all of the same tokens: the untapped in one pile, the tapped in another, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'cx-stack-tokens');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const a = alice.page;
    const named = (name: string) => field(a, 'you').locator('li.board-card', { has: a.locator('.card__name', { hasText: name }) });
    await expect(named('Soldier'), 'alice’s seven Soldier tokens').toHaveCount(7, { timeout: 45_000 });
    const soldierIds = await named('Soldier').evaluateAll((els) =>
      els.map((e) => ({ id: e.getAttribute('data-card-id')!, countered: e.querySelector('[data-counter]') !== null, tapped: e.hasAttribute('data-tapped') })),
    );
    const same = soldierIds.filter((s) => !s.countered && !s.tapped).map((s) => s.id);
    const tapped = soldierIds.filter((s) => !s.countered && s.tapped).map((s) => s.id);
    const countered = soldierIds.find((s) => s.countered)!.id;
    const goblin = (await named('Goblin').getAttribute('data-card-id'))!;
    const bears = (await named('Grizzly Bears').getAttribute('data-card-id'))!;
    expect(same, 'four untapped Soldiers').toHaveLength(4);
    expect(tapped, 'two tapped Soldiers').toHaveLength(2);
    console.log(`[cx] untapped soldiers ${same.join(',')}, tapped ${tapped.join(',')}, countered ${countered}, goblin ${goblin}, bears ${bears}`);
    console.log(`[cx] arrived: ${(await piles(a, 'you')).join(' | ')}`);

    // Split, as the operator's were: two Soldiers piled by hand, the other two each on their own.
    const [s0, s1, , s4] = same as [string, string, string, string];
    await pointerDrag(a, card(a, 'you', s1), onTopPoint(await boxOf(card(a, 'you', s0))));
    await expect(card(a, 'you', s0), 'two Soldiers in one pile').toHaveAttribute('data-pile-size', '2');
    const split = await piles(a, 'you');
    console.log(`[cx] split: ${split.join(' | ')}`);
    expect(new Set(same.map((id) => pileOf(split, id)[0])).size, 'the four untapped Soldiers are in three piles').toBe(3);

    // The board's own menu, never the browser's; Escape puts it away.
    await rightClick(a, s4);
    await expect(stackItem(a), 'a right-click on a Soldier offers to stack them').toBeVisible();
    await expect(stackItem(a), 'the first action has the focus').toBeFocused();
    await a.keyboard.press('Escape');
    await expect(menu(a), 'Escape closes the menu').toHaveCount(0);
    expect(await piles(a, 'you'), 'and changes nothing').toEqual(split);

    // A Goblin has no twin and the Bears are no token: nothing to stack, no menu.
    for (const id of [goblin, bears, countered]) {
      await rightClick(a, id);
      await expect(menu(a), `no menu on ${id}: nothing to stack`).toHaveCount(0);
    }

    await rightClick(a, s4);
    await stackItem(a).click();
    await expect(menu(a), 'the menu closes once the action ran').toHaveCount(0);
    await expect
      .poll(async () => pileOf(await piles(a, 'you'), s4).sort(), { timeout: 10_000, message: 'alice: the four untapped Soldiers are one pile' })
      .toEqual([...same].sort());
    const mine = await piles(a, 'you');
    console.log(`[cx] alice after the stack: ${mine.join(' | ')}`);
    await expect(card(a, 'you', pileOf(mine, s4)[0]!), 'a pile of four').toHaveAttribute('data-pile-size', '4');
    expect(pileOf(mine, tapped[0]!).sort(), 'the tapped two are a pile of their own').toEqual([...tapped].sort());
    for (const id of [countered, goblin, bears]) expect(pileOf(mine, id), `${id} stays on its own`).toEqual([id]);
    await expect.poll(() => piles(bob.page, 'them'), { timeout: 10_000, message: 'bob draws alice’s battlefield the same' }).toEqual(mine);
    console.log(`[cx] bob sees alice's battlefield: ${(await piles(bob.page, 'them')).join(' | ')}`);

    // Nothing left to stack: the menu no longer opens on them.
    await rightClick(a, s4);
    await expect(menu(a), 'all stacked: no menu').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
