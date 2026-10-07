/**
 * Presence (ledger Z5), against real Forge and two real browsers: alice moves
 * her pointer and lifts a card; bob's board shows her cursor with her name, a
 * card back while she holds it, and her arrow while she aims — and never the
 * card itself. The operator: *"we shouldn't reveal the card they want to play,
 * still keep it hidden until they actually commit it to the stack"* and *"we
 * should see the pointer even when they aren't holding a card."*
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offered } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const cursor = (page: Page) => page.locator('[data-board-overlay] .presence');
const back = (page: Page) => page.locator('[data-board-overlay] .presence__back');
const arrow = (page: Page) => page.locator('[data-board-overlay] .presence__arrow');

test(titled('bob sees alice’s pointer, a card back while she holds a card, her arrow while she aims — and never which card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered Memnite' }).not.toEqual([]);
    const memnite = (await offered(alice.page))[0]!;
    const name = (await alice.page.locator(`[data-board-card="${memnite}"] .card__name`).first().textContent())?.trim() ?? '';
    expect(name).not.toBe('');

    /* ── her pointer alone, over her own battlefield: on bob's board, over HER (his "them") battlefield ── */
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await alice.page.mouse.move(herField.x + herField.width * 0.3, herField.y + herField.height * 0.5, { steps: 6 });
    await expect(cursor(bob.page), 'bob sees her cursor').toHaveCount(1, { timeout: 10_000 });
    await expect(cursor(bob.page).locator('.presence__name')).toHaveText(/alice/i);
    const theirFieldOnBob = (await bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').boundingBox())!;
    await expect
      .poll(async () => {
        const c = await cursor(bob.page).boundingBox();
        return c === null ? null : { inX: c.x >= theirFieldOnBob.x && c.x <= theirFieldOnBob.x + theirFieldOnBob.width, inY: c.y >= theirFieldOnBob.y && c.y <= theirFieldOnBob.y + theirFieldOnBob.height };
      }, { timeout: 5_000, message: 'her pointer lands inside her battlefield as bob draws it' })
      .toEqual({ inX: true, inY: true });
    await expect(back(bob.page), 'nothing held yet').toHaveCount(0);

    /* ── she lifts Memnite and carries it over her battlefield: a back under her cursor, not Memnite ── */
    const cardBox = (await alice.page.locator(`[data-board-card="${memnite}"]`).boundingBox())!;
    await alice.page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await alice.page.mouse.down();
    await expect(alice.page.locator(`[data-board-card="${memnite}"]`), 'the press lifted it').toHaveAttribute('data-cast-lift', 'lifted');
    await alice.page.mouse.move(herField.x + herField.width * 0.5, herField.y + herField.height * 0.5, { steps: 10 });
    await expect(back(bob.page), 'bob sees a card back under her cursor').toHaveCount(1, { timeout: 10_000 });
    const bobHtml = await bob.page.locator('[data-board-overlay]').innerHTML();
    expect(bobHtml, 'and nothing in what is drawn for him names the card').not.toContain(name);
    expect(bobHtml).not.toContain(`data-card-id`);

    /* ── she brings it back to her hand and lets go: the back is gone, the card never showed ── */
    const herHand = (await alice.page.locator('.seat[data-viewer] [data-zone="hand"]').boundingBox())!;
    await alice.page.mouse.move(herHand.x + herHand.width / 2, herHand.y + herHand.height / 2, { steps: 10 });
    await alice.page.mouse.up();
    await expect(back(bob.page), 'the back is gone once she let go').toHaveCount(0, { timeout: 10_000 });
    await expect(bob.page.locator('[data-zone="stack"]'), 'and nothing reached the stack').toHaveAttribute('data-count', '0');

    /* ── her pointer leaves the board: the cursor is taken down ── */
    await alice.page.mouse.move(2, 2);
    await expect(cursor(bob.page), 'her cursor goes when she leaves the board').toHaveCount(0, { timeout: 10_000 });
    void arrow;
  } finally {
    await stack.stop();
  }
});
