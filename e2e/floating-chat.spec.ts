/*
 * The operator, 2026-11-11: "let's get the floating chat display from watchparty for when people
 * have the chat hidden."
 *
 * With the chat column hidden, the room's latest lines fade over the table: watchparty's own
 * over-video overlay (`FloatingChat`), drawn by `RoomChrome` beside its collapsed rail. It must
 * never take a click from the board, and with the column open nothing floats, so a line is never
 * shown twice.
 *
 * Scenario `af141-mox-opal`, for nothing but a board both seats share: a match no room holds admits
 * both players to its chat (`games/magic/server/src/room/serve.ts`).
 *
 * A line is drawn as its sender looks (the operator, 2026-11-16: "make sure that everything about the
 * avatars, decorations and styling is properly hooked up"). Bob wears a picture, an overlay and a name
 * effect; alice wears nothing, so her line is her character's portrait and a plain name. Watchparty draws
 * both; what cardtable owes it is each person's look on the chat roster (`serve.ts`'s `account`).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { FRIENDS } from './identities.ts';
import { dress, servePictures } from './looks.ts';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const CHROME = '.wp-room-chrome';
const FLOATING = '[data-testid="floating-chat"]';
const chatBox = (page: Page) => page.getByPlaceholder('Send a message');
const PICTURES = 'https://cdn.e2e-floating.test';
const PICTURE = `${PICTURES}/bob.svg`;

/** The one line carrying `text`, as a chat row: the avatar beside it is a sibling of the text's column. */
const lineOf = (within: Locator, text: string): Locator => within.locator('div').filter({ hasText: text }).filter({ has: within.page().locator('.hc-av') }).last();

/** Bob's look on a line: his picture, the halo drawn over it at its size, and his name in its effect. */
async function expectBobDressed(line: Locator, where: string): Promise<void> {
  await expect(line.locator(`.hc-av img[src="${PICTURE}"]`), `${where}: bob's picture`).toBeVisible();
  const overlay = line.locator('.hc-av .hc-ol');
  await expect(overlay, `${where}: his overlay is drawn`).toHaveCount(1);
  const [face, halo] = await Promise.all([line.locator('.hc-av').boundingBox(), overlay.boundingBox()]);
  expect(halo, `${where}: the overlay has a box`).not.toBeNull();
  expect(Math.abs(halo!.x + halo!.width / 2 - (face!.x + face!.width / 2)), `${where}: the overlay is centred on his face`).toBeLessThanOrEqual(2);
  await expect(line.locator('.hc-name').first(), `${where}: his name wears its effect`).toBeVisible();
}

/** The composer refuses a send inside its one-second cooldown and keeps the text, so press until it takes it. */
async function say(page: Page, text: string): Promise<void> {
  await chatBox(page).fill(text);
  await expect(async () => {
    await chatBox(page).press('Enter');
    await expect(chatBox(page)).toHaveValue('', { timeout: 500 });
  }, `the composer sent “${text}”`).toPass({ timeout: 10_000 });
}

test(titled('chat hidden, the latest lines float over the table and never take a click; chat shown, nothing floats'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af141-mox-opal', {
      // Before bob opens the match, so the roster takes him as he is dressed.
      beforeAlice: async (page) => {
        await servePictures(page.context(), PICTURES);
        await servePictures(page.context(), `${stack.origin}/watchparty/media/sprites`);
        await dress(page.context().request, stack.origin, FRIENDS.bob.key, {
          source: 'upload',
          url: PICTURE,
          sprite: 'sage',
          name: FRIENDS.bob.name,
          cosmetics: { overlay: 'overlay.halo', effect: 'effect.glint' },
        });
      },
    });
    const a = alice.page;
    await expect(a.locator('style#hadoku-cosmetics'), 'the cosmetics sheet is in the page').toHaveCount(1);
    for (const page of [a, bob.page]) await expect(chatBox(page), 'the chat is open beside the board').toBeVisible({ timeout: 20_000 });

    const whileOpen = `while open ${Date.now()}`;
    await say(bob.page, whileOpen);
    await expect(a.locator(CHROME).getByText(whileOpen), 'alice reads it in the column').toBeVisible({ timeout: 20_000 });
    await expect(a.locator(FLOATING), 'and nowhere else').toHaveCount(0);
    await expectBobDressed(lineOf(a.locator(CHROME), whileOpen), 'the column');

    await a.locator(`${CHROME} button[aria-label="Hide chat"]`).click();
    await expect(chatBox(a)).toHaveCount(0);
    const whileHidden = `while hidden ${Date.now()}`;
    await say(bob.page, whileHidden);
    const floating = a.locator(FLOATING);
    await expect(floating.getByText(whileHidden), 'bob’s line floats over alice’s table').toBeVisible({ timeout: 20_000 });
    await expectBobDressed(lineOf(floating, whileHidden), 'the floating line');

    // Alice's own line floats too, as she looks: her character's portrait and a plain name.
    const hers = `hers ${Date.now()}`;
    await a.locator(`${CHROME} button[aria-label="Show chat"]`).click();
    await say(a, hers);
    await a.locator(`${CHROME} button[aria-label="Hide chat"]`).click();
    const herLine = lineOf(a.locator(FLOATING), hers);
    await expect(herLine.locator('.hc-av img'), 'alice’s portrait').toHaveAttribute('src', /\/watchparty\/media\/sprites\/square_[a-z_]+\.png/);
    await expect(herLine.locator('.hc-av img'), 'and it loaded').toHaveJSProperty('complete', true);
    expect(await herLine.locator('.hc-av img').evaluate((img: HTMLImageElement) => img.naturalWidth), 'a portrait, not a broken image').toBeGreaterThan(0);
    await expect(herLine.locator('.hc-av .hc-ol'), 'she wears no overlay').toHaveCount(0);
    await expect(herLine.locator('.hc-name'), 'and a plain name').toHaveCount(0);

    const box = (await floating.boundingBox())!;
    const table = (await a.locator('.wp-room-chrome-frame__content').boundingBox())!;
    expect(box.x, 'inside the table, not over the rail').toBeGreaterThanOrEqual(table.x);
    expect(box.x + box.width).toBeLessThanOrEqual(table.x + table.width);
    expect(box.y).toBeGreaterThanOrEqual(table.y);
    expect(box.y + box.height).toBeLessThanOrEqual(table.y + table.height);
    const hit = await a.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { overlay: !!el?.closest('[data-testid="floating-chat"]'), table: !!el?.closest('.wp-room-chrome-frame__content') };
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(hit, 'a press over the lines lands on the table').toEqual({ overlay: false, table: true });

    await a.locator(`${CHROME} button[aria-label="Show chat"]`).click();
    await expect(chatBox(a)).toBeVisible();
    await expect(a.locator(FLOATING), 'shown again, nothing floats').toHaveCount(0);
    const reopened = `reopened ${Date.now()}`;
    await say(bob.page, reopened);
    await expect(a.locator(CHROME).getByText(reopened)).toBeVisible({ timeout: 20_000 });
    await expect(a.locator(FLOATING)).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
