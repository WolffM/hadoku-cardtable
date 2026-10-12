/**
 * The operator, 2026-10-12: *"when multiple copies of the same creature or token are stacked let's
 * show an xN on top so it's clear how many there are."*
 *
 * Alice piles her three Goblin tokens with real pointer drags: the pile wears ×3, on her screen and
 * on bob's, inside the top card's face. She takes one off: ×2 on both. She puts her Grizzly Bears on
 * the pile: a pile that mixes cards is not copies, so no count on either screen.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, onTopPoint, pointerDrag } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Alice's battlefield, on her own screen (`you`) or on bob's (`them`). */
const field = (page: Page, side: 'you' | 'them') =>
  page.locator(`.seat${side === 'you' ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"]`);
const card = (page: Page, side: 'you' | 'them', id: string) => field(page, side).locator(`li.board-card[data-card-id="${id}"]`);
/** The count a pile's base wears, or '' when it wears none. */
const countOn = (page: Page, side: 'you' | 'them', id: string) =>
  card(page, side, id)
    .locator(':scope > .board-card__copies')
    .evaluateAll((els) => els.map((e) => e.textContent ?? '').join(''));

/** Where the count sits against the face it is drawn on, and whether all of it is on screen. */
const placement = (page: Page, side: 'you' | 'them', id: string) =>
  card(page, side, id).evaluate((li) => {
    const badge = li.querySelector(':scope > .board-card__copies')!.getBoundingClientRect();
    const face = li.querySelector(':scope > .board-card__face')!.getBoundingClientRect();
    const zone = li.closest('[data-zone="battlefield"]')!.getBoundingClientRect();
    const inside = (a: DOMRect, b: DOMRect) => a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
    const at = document.elementFromPoint(badge.left + badge.width / 2, badge.top + badge.height / 2);
    return {
      badge: `${Math.round(badge.left)},${Math.round(badge.top)} ${Math.round(badge.width)}×${Math.round(badge.height)}`,
      face: `${Math.round(face.left)},${Math.round(face.top)} ${Math.round(face.width)}×${Math.round(face.height)}`,
      inFace: inside(badge, face),
      inZone: inside(badge, zone),
      // The badge takes no pointer, so the hit is what lies under it: its own card, and nothing from outside the pile.
      onTop: at?.closest('li.board-card') === li,
    };
  });

test(titled('a pile of copies wears ×N on both screens; it follows a card leaving, and a mixed pile wears none'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'xn-copies');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    const a = alice.page;
    const goblins = field(a, 'you').locator('li.board-card[data-token]');
    await expect(goblins, 'alice’s three Goblin tokens, each its own pile').toHaveCount(3, { timeout: 30_000 });
    const [g1, g2, g3] = (await goblins.evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')!))) as [string, string, string];
    const bears = (await field(a, 'you').locator('li.board-card:not([data-token])', { has: a.locator('.card__name', { hasText: 'Grizzly Bears' }) }).getAttribute('data-card-id'))!;
    console.log(`[xn] goblins ${g1} ${g2} ${g3}, bears ${bears}`);
    await expect(field(a, 'you').locator('.board-card__copies'), 'nothing piled, nothing counted').toHaveCount(0);

    // Three copies piled: ×3 on both screens, drawn inside the top card's face, on top of everything.
    await pointerDrag(a, card(a, 'you', g2), onTopPoint(await boxOf(card(a, 'you', g1))));
    await expect(card(a, 'you', g1), 'two Goblins in one pile').toHaveAttribute('data-pile-size', '2');
    await pointerDrag(a, card(a, 'you', g3), onTopPoint(await boxOf(card(a, 'you', g1))));
    await expect(card(a, 'you', g1), 'three Goblins in one pile').toHaveAttribute('data-pile-size', '3');
    await expect.poll(() => countOn(a, 'you', g1), { message: 'alice’s pile of three Goblins says ×3' }).toBe('×3');
    await expect.poll(() => countOn(bob.page, 'them', g1), { timeout: 10_000, message: 'bob sees ×3 on alice’s pile' }).toBe('×3');
    for (const [who, page, side] of [['alice', a, 'you'], ['bob', bob.page, 'them']] as const) {
      const p = await placement(page, side, g1);
      console.log(`[xn] ×3 on ${who}'s screen: badge ${p.badge}, face ${p.face}, inFace=${p.inFace} inZone=${p.inZone} onTop=${p.onTop}`);
      expect(p, `${who}: the count is inside the top card’s face, wholly on screen, and nothing covers it`).toMatchObject({ inFace: true, inZone: true, onTop: true });
    }
    await expect(field(a, 'you').locator('.board-card__copies'), 'one count per pile').toHaveCount(1);

    // One leaves the pile (the top card, into the thin reorder strip at the Bears' left edge — its own column beside
    // them): ×2 on both screens; the one that left wears none.
    const bearsBox = await boxOf(card(a, 'you', bears));
    await pointerDrag(a, card(a, 'you', g1), { x: bearsBox.x + bearsBox.width * 0.05, y: bearsBox.y + bearsBox.height / 2 });
    const columns = await field(a, 'you')
      .locator('[data-tier="front"] > li.board-card')
      .evaluateAll((els) => els.map((e) => [e.getAttribute('data-card-id'), ...Array.from(e.querySelectorAll(':scope > ul > li.board-card'), (m) => m.getAttribute('data-card-id'))].join('+')));
    console.log(`[xn] front tier after the lift: ${columns.join(' | ')}`);
    await expect(card(a, 'you', g2), 'two Goblins left in the pile').toHaveAttribute('data-pile-size', '2');
    await expect.poll(() => countOn(a, 'you', g2), { message: 'alice’s pile says ×2' }).toBe('×2');
    await expect.poll(() => countOn(bob.page, 'them', g2), { timeout: 10_000, message: 'bob sees ×2' }).toBe('×2');
    expect(await countOn(a, 'you', g1), 'the Goblin that left is a lone card').toBe('');
    console.log(`[xn] after one left: alice "${await countOn(a, 'you', g2)}", bob "${await countOn(bob.page, 'them', g2)}"`);

    // The Bears on the pile: mixed, so no count on either screen.
    await pointerDrag(a, card(a, 'you', bears), onTopPoint(await boxOf(card(a, 'you', g2))));
    await expect(card(a, 'you', g2), 'two Goblins and the Bears in one pile').toHaveAttribute('data-pile-size', '3');
    await expect(card(bob.page, 'them', g2), 'bob sees the mixed pile').toHaveAttribute('data-pile-size', '3', { timeout: 10_000 });
    await expect(field(a, 'you').locator('.board-card__copies'), 'a mixed pile wears no count').toHaveCount(0);
    await expect(field(bob.page, 'them').locator('.board-card__copies'), 'nor on bob’s screen').toHaveCount(0);
    console.log('[xn] mixed pile (2 Goblins + Bears): no count on either screen');
  } finally {
    await stack.stop();
  }
});
