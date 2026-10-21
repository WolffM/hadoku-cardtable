/**
 * A Constructed room's mode (`docs/planning/constructed-modes-plan.md`, the
 * operator, 2026-10-21): *"when creating a constructed room there should be an
 * optional additional setting to select this mode, if none is selected then
 * that's the first thing that happens when the room opens."*
 *
 * 1. Created as Classic, the room opens on the deck picker, as rooms always did.
 * 2. Created with no mode, the room shows only the mode row: the leader's to
 *    choose, disabled for everyone else. The leader picks Classic and the deck
 *    picker appears on both screens.
 * 3. The mode can change until somebody readies (ruling 8): once the leader is
 *    ready the row is disabled, and the server refuses a change with
 *    `mode-locked`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { roomIdFromHash } from './play/board.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

test.describe.configure({ mode: 'serial' });

interface Friend {
  context: BrowserContext;
  page: Page;
}

async function open(browser: Browser, name: string): Promise<Friend> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  return { context, page: await context.newPage() };
}

const modeRadio = (page: Page, mode: 'classic' | 'gauntlet' | 'random') => page.getByTestId(`constructed-mode-${mode}`);

test('created as Classic, the room opens on the deck picker', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e classic ${Date.now()}`, mode: 'classic' });
    await roomIdFromHash(alice.page);
    await expect(alice.page.getByTestId('constructed')).toBeVisible();
    await expect(modeRadio(alice.page, 'classic')).toBeChecked();
    await expect(alice.page.getByTestId('deck-mine')).toBeVisible();
    await expect(alice.page.getByTestId('room-players')).toBeVisible();
  } finally {
    await alice.context.close();
  }
});

test('created with no mode, only the mode row shows; the leader picks Classic and the deck picker appears', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  const bob = await open(browser, 'bob');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e no mode ${Date.now()}`, mode: null });
    const roomId = await roomIdFromHash(alice.page);
    await bob.page.goto(`${PREFIX}/#/room/${roomId}`);

    for (const page of [alice.page, bob.page]) {
      await expect(page.getByTestId('constructed-mode')).toBeVisible();
      for (const mode of ['classic', 'gauntlet', 'random'] as const) await expect(modeRadio(page, mode)).not.toBeChecked();
      await expect(page.getByTestId('deck-mine')).toHaveCount(0);
      await expect(page.getByTestId('room-players')).toHaveCount(0);
    }
    await expect(modeRadio(alice.page, 'classic')).toBeEnabled();
    await expect(modeRadio(bob.page, 'classic'), 'only the leader chooses the mode').toBeDisabled();

    await modeRadio(alice.page, 'classic').click();
    for (const page of [alice.page, bob.page]) {
      await expect(modeRadio(page, 'classic')).toBeChecked();
      await expect(page.getByTestId('deck-mine')).toBeVisible();
    }
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

test('the mode is fixed once somebody is ready: the row is disabled and the server answers mode-locked', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e mode lock ${Date.now()}`, mode: 'classic' });
    const roomId = await roomIdFromHash(alice.page);

    // Before anyone is ready the leader may move it, and back.
    await modeRadio(alice.page, 'random').click();
    await expect(modeRadio(alice.page, 'random')).toBeChecked();
    await expect(alice.page.getByTestId('deck-mine')).toHaveCount(0);
    await modeRadio(alice.page, 'classic').click();
    await expect(alice.page.getByTestId('deck-mine')).toBeVisible();

    await expect(alice.page.getByTestId('deck-random')).toBeEnabled();
    await alice.page.getByTestId('deck-random').click();
    await expect(alice.page.getByTestId('ready-toggle')).toBeEnabled();
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');

    for (const mode of ['classic', 'gauntlet', 'random'] as const) await expect(modeRadio(alice.page, mode)).toBeDisabled();
    const refused = await alice.context.request.patch(`${EDGE_ORIGIN}${PREFIX}/api/rooms/${roomId}`, { data: { mode: 'gauntlet' } });
    expect(refused.status()).toBe(409);
    expect(await refused.text()).toContain('mode-locked');
    await expect(modeRadio(alice.page, 'classic')).toBeChecked();
  } finally {
    await alice.context.close();
  }
});
