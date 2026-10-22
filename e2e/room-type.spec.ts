/**
 * A room's type changes inside the room (the operator, 2026-10-21, of a
 * finished Gauntlet: *"after a match is concluded i should be able to start a
 * new match and standup or even convert the room to a new type"*; asked about
 * a Constructed / Draft switch above the mode row: *"sure we can do that"*).
 *
 * 1. A Constructed room: the leader's type radio is live, everybody else's is
 *    disabled. The leader picks Draft and both screens show the draft lobby;
 *    the leader picks Constructed and both are back on the mode row, the mode
 *    unchosen. Each screen fits 1280×800 at the smallest, default and largest
 *    UI scale.
 * 2. The type is locked when the mode is: once a seated player is ready the
 *    radio is disabled, and the server answers a direct switch `mode-locked`.
 *
 * `[room-type]` lines are the evidence: the room screen's box against the
 * window at each scale.
 */
import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX } from './identities.ts';
import { resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

test.describe.configure({ mode: 'serial' });

const typeRadio = (page: Page, type: 'constructed-1v1' | 'draft') => page.getByTestId(`room-game-type-${type}`);
/** `settings/ui-scale.ts`'s `UI_SCALE`: its least, its default, its most. */
const SCALES = ['0.8', '1', '1.25'] as const;

/** The room at 1280×800, at every scale: no page scroll either way, and the type row in the window, above the mode row. */
async function fitsEveryScale(page: Page, what: string): Promise<void> {
  await resizeWindow(page, { width: 1280, height: 800 });
  for (const scale of SCALES) {
    await page.evaluate((v) => document.documentElement.style.setProperty('--ui-scale', v), scale);
    const fit = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="room-game-type"]')!.getBoundingClientRect();
      const modes = document.querySelector('[data-testid="constructed-mode"]')?.getBoundingClientRect() ?? null;
      const doc = document.documentElement;
      return { row: { right: row.right, bottom: row.bottom }, modesTop: modes?.top ?? null, docW: doc.scrollWidth, docH: doc.scrollHeight, w: innerWidth, h: innerHeight };
    });
    console.log(`[room-type] ${what} at ${scale}: ${JSON.stringify(fit)}`);
    expect(fit.docW, `no sideways scroll, ${what} at ${scale}`).toBeLessThanOrEqual(fit.w);
    expect(fit.docH, `no page scroll, ${what} at ${scale}`).toBeLessThanOrEqual(fit.h);
    expect(fit.row.right, `the type row in the window, ${what} at ${scale}`).toBeLessThanOrEqual(fit.w);
    expect(fit.row.bottom, `the type row in the window, ${what} at ${scale}`).toBeLessThanOrEqual(fit.h);
    if (fit.modesTop !== null) expect(fit.row.bottom, `the type row above the mode row, ${what} at ${scale}`).toBeLessThanOrEqual(fit.modesTop);
  }
  await page.evaluate(() => document.documentElement.style.removeProperty('--ui-scale'));
}

test('the leader turns a Constructed room into a Draft room and back, from inside it', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e room type ${Date.now()}`, mode: 'classic' });
    const roomId = await roomIdFromHash(alice.page);
    await bob.page.goto(`${PREFIX}/#/room/${roomId}`);

    for (const page of [alice.page, bob.page]) {
      await expect(page.getByTestId('deck-mine')).toBeVisible();
      await expect(typeRadio(page, 'constructed-1v1')).toBeChecked();
    }
    await expect(typeRadio(alice.page, 'draft')).toBeEnabled();
    await expect(typeRadio(bob.page, 'draft'), 'only the leader changes the type').toBeDisabled();
    await fitsEveryScale(alice.page, 'constructed, classic');

    await typeRadio(alice.page, 'draft').click();
    for (const page of [alice.page, bob.page]) {
      await expect(page.getByTestId('draft-lobby')).toBeVisible();
      await expect(typeRadio(page, 'draft')).toBeChecked();
      await expect(page.getByTestId('constructed-mode')).toHaveCount(0);
      await expect(page.getByTestId('deck-mine')).toHaveCount(0);
    }
    await expect(typeRadio(bob.page, 'constructed-1v1')).toBeDisabled();
    await fitsEveryScale(alice.page, 'draft lobby');

    await typeRadio(alice.page, 'constructed-1v1').click();
    for (const page of [alice.page, bob.page]) {
      await expect(page.getByTestId('constructed-mode')).toBeVisible();
      await expect(typeRadio(page, 'constructed-1v1')).toBeChecked();
      await expect(page.getByTestId('draft-lobby')).toHaveCount(0);
      for (const mode of ['classic', 'gauntlet', 'random']) await expect(page.getByTestId(`constructed-mode-${mode}`)).not.toBeChecked();
    }
    await fitsEveryScale(alice.page, 'constructed, no mode');
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

test('the type is fixed when the mode is: once somebody is ready the radio is disabled and the server answers mode-locked', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e type lock ${Date.now()}`, mode: 'classic' });
    const roomId = await roomIdFromHash(alice.page);

    await expect(alice.page.getByTestId('deck-random')).toBeEnabled();
    await alice.page.getByTestId('deck-random').click();
    await expect(alice.page.getByTestId('ready-toggle')).toBeEnabled();
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');

    for (const type of ['constructed-1v1', 'draft'] as const) await expect(typeRadio(alice.page, type)).toBeDisabled();
    const refused = await alice.context.request.patch(`${EDGE_ORIGIN}${PREFIX}/api/rooms/${roomId}`, { data: { gameType: 'draft' } });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: 'mode-locked' });
    await expect(typeRadio(alice.page, 'constructed-1v1')).toBeChecked();
  } finally {
    await alice.context.close();
  }
});
