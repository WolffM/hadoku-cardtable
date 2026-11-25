/*
 * Leaving a room, from the room's own page (the operator, 2026-11-24: *"leave buttons seem good
 * … And make sure clicking the top bar works as well. I'd expect both to work."*).
 *
 * Until then the top bar's title only navigated home and the player stayed a member of the room
 * they had walked out of. Now both the room's Leave and the top bar's title call the room's
 * `/leave` and then go to the front page, and the server's own member list is what says so —
 * read from the other player's page (`data-members`) and from the room record itself.
 *
 * Alice makes a room, Bob joins. Bob presses Leave; Bob comes back and clicks the top bar; Bob
 * comes back once more and Alice, the leader, presses Leave, which hands the room to Bob (the
 * kit's leader hand-over: Bob is now the one offered Close).
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled, roomIdFromAddress } from './play/board.ts';
import { openFriend, specVideoSlug, type Friend } from './play/browser.ts';
import { forgeAvailability, RUN_DIR, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

/** The room record's member names, as the server holds them, read with this page's own identity. */
async function memberNames(page: Page, roomId: string): Promise<string[]> {
  const body = (await page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as { members: { name: string }[] };
  return body.members.map((m) => m.name).sort();
}

async function enterRoom(f: Friend, origin: string, roomId: string): Promise<void> {
  await f.page.goto(`${origin}${PREFIX}/#/room/${roomId}`);
  await expect(f.page.getByTestId('room-leave'), `${f.name}: the room's Leave is drawn`).toBeVisible({ timeout: UI_TIMEOUT });
}

async function onFrontPage(f: Friend, how: string): Promise<void> {
  await expect.poll(() => f.page.evaluate(() => window.location.pathname), { message: `${f.name} left the room's page by ${how}`, timeout: UI_TIMEOUT }).not.toMatch(/\/room\//);
  await expect(f.page.getByTestId('constructed'), `${f.name}: the room is no longer drawn`).toHaveCount(0);
}

test(titled("a room's Leave and the top bar's title both leave the room, and the leader's Leave hands it on"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e leave ${Date.now()}` });
    const roomId = await roomIdFromAddress(alice.page);
    const aliceRoom = alice.page.getByTestId('constructed');

    // Leave, in the room's head row beside the room's own tools.
    await enterRoom(bob, stack.origin, roomId);
    await expect(aliceRoom, 'alice sees bob join').toHaveAttribute('data-members', '2', { timeout: UI_TIMEOUT });
    const head = bob.page.locator('.shell__head');
    await expect(head.locator('.shell__tools').getByTestId('room-leave')).toHaveText('Leave');
    // Beside the run's videos, so a `video: true` dispatch keeps it on a green run too (forge.yml).
    const shots = resolve(RUN_DIR, 'videos', specVideoSlug());
    mkdirSync(shots, { recursive: true });
    const shot = resolve(shots, 'room-leave-head.png');
    await bob.page.screenshot({ path: shot });
    console.log(`[room-leave] screenshot ${shot}`);
    await bob.page.getByTestId('room-leave').click();
    await onFrontPage(bob, 'Leave');
    await expect(aliceRoom, 'alice sees bob go: Leave ended his membership').toHaveAttribute('data-members', '1', { timeout: UI_TIMEOUT });
    expect(await memberNames(alice.page, roomId), 'the server holds alice alone').toEqual(['e2e-alice']);

    // The top bar's title, on the room's page, leaves the same way.
    await enterRoom(bob, stack.origin, roomId);
    await expect(aliceRoom).toHaveAttribute('data-members', '2', { timeout: UI_TIMEOUT });
    await bob.page.getByTestId('chrome-home').click();
    await onFrontPage(bob, 'the top bar');
    await expect(aliceRoom, 'alice sees bob go: the top bar ended his membership').toHaveAttribute('data-members', '1', { timeout: UI_TIMEOUT });
    expect(await memberNames(alice.page, roomId), 'the server holds alice alone again').toEqual(['e2e-alice']);

    // The leader's Leave: the room passes to whoever remains, who is now offered Close.
    await enterRoom(bob, stack.origin, roomId);
    await expect(aliceRoom).toHaveAttribute('data-members', '2', { timeout: UI_TIMEOUT });
    await expect(bob.page.getByTestId('room-close'), 'bob is not the leader yet').toHaveCount(0);
    await alice.page.getByTestId('room-leave').click();
    await onFrontPage(alice, 'Leave');
    await expect(bob.page.getByTestId('constructed'), 'bob sees alice go').toHaveAttribute('data-members', '1', { timeout: UI_TIMEOUT });
    await expect(bob.page.getByTestId('room-close'), 'the room passed to bob').toBeVisible({ timeout: UI_TIMEOUT });
    expect(await memberNames(bob.page, roomId)).toEqual(['e2e-bob']);
  } finally {
    await stack.stop();
  }
});
