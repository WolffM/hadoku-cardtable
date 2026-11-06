/**
 * One avatar, everywhere (the operator, 2026-11-05): *"picture/character are the
 * same thing and all over the entire site it's the same avatar. we must display
 * all customizations everywhere."*
 *
 * Alice wears an uploaded picture, an overlay and a name effect. Bob sees all
 * three on her seat in the room, and again on her face on the board; carol, who
 * was not there, sees them again in the game's replay.
 */

import { expect, test, type Locator } from '@playwright/test';

import { FRIENDS } from './identities.ts';
import { dress, expectDecorOver, servePictures } from './looks.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { seatBoth } from './play/enter.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { TURN_TEXT } from './play/turn.ts';

test.describe.configure({ mode: 'serial' });

const forge = forgeAvailability();
const titled = makeTitled(forge);

const PICTURES = 'https://cdn.e2e-looks.test';
const PICTURE = `${PICTURES}/alice.svg`;

test(titled('a picture, an overlay and a name effect show on the room seat, on the board face, and in the replay, to everyone else'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    for (const f of [alice, bob]) {
      await servePictures(f.context, PICTURES);
      await servePictures(f.context, `${stack.origin}/watchparty/media/sprites`);
    }
    await dress(alice.context.request, stack.origin, FRIENDS.alice.key, {
      source: 'upload',
      url: PICTURE,
      sprite: 'sage',
      name: FRIENDS.alice.name,
      cosmetics: { overlay: 'overlay.halo', effect: 'effect.glint' },
    });

    await seatBoth(alice, bob, stack.origin);

    // The room: alice's seat, as bob sees it.
    const seat = bob.page.locator('[data-testid^="room-seat-"]').filter({ has: bob.page.locator(`img[src="${PICTURE}"]`) });
    await expect(seat, 'bob sees alice’s picture on her seat').toHaveCount(1, { timeout: 30_000 });
    await expectDecorOver(bob.page, seat.locator(`img[src="${PICTURE}"]`), 'bob, alice’s seat');
    await expect(bob.page.locator('style#hadoku-cosmetics'), 'the app put the renderer’s sheet in the page, once').toHaveCount(1);
    await expect(seat.locator('.pod-seats__label[data-dressed] .hc-name'), 'alice’s name wears its effect').toHaveCount(1);
    // Bob wears nothing: his own seat is his character and a plain name.
    const bobSeat = bob.page.locator('[data-testid^="room-seat-"][data-mine]');
    await expect(bobSeat.locator('img')).toHaveAttribute('src', /square_[a-z]+\.png$/);
    await expect(bobSeat.locator('[data-dressed]')).toHaveCount(0);

    // The board: bob readies, the match starts, and alice's face is the same.
    await bob.page.getByTestId('ready-toggle').click();
    await bob.page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 120_000 });
    await expect(bob.page.getByTestId('live-turn-n')).toHaveText(TURN_TEXT, { timeout: 30_000 });
    const theirs: Locator = bob.page.locator('[data-player-face]:not([data-viewer])');
    await expect(theirs.getByTestId('seat-avatar'), 'bob’s board draws alice’s picture').toHaveAttribute('src', PICTURE, { timeout: 30_000 });
    await expectDecorOver(bob.page, theirs.getByTestId('seat-avatar'), 'bob, alice’s board face');
    await expect(theirs.locator('.face__name[data-dressed] .hc-name'), 'alice’s name on the board wears its effect').toHaveCount(1);
    // And the name the seat rail shows beside her face, the one a player reads.
    const rail = bob.page.locator('.seat:not([data-viewer]) .seat__name');
    await expect(rail.locator('[data-dressed] .hc-name'), 'alice’s name in the seat rail wears its effect').toBeVisible();
    await expect(bob.page.locator('.seat[data-viewer] .seat__name [data-dressed]'), 'bob’s plain name stays plain').toHaveCount(0);
    // And on her own board, the same.
    await alice.page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 120_000 });
    const mine = alice.page.locator('[data-player-face][data-viewer]');
    await expect(mine.getByTestId('seat-avatar'), 'alice’s own board draws her picture').toHaveAttribute('src', PICTURE, { timeout: 30_000 });
    await expectDecorOver(alice.page, mine.getByTestId('seat-avatar'), 'alice, her own board face');

    // The replay: bob concedes, and carol, who was not there, watches it with alice as she is now.
    const matchId = /#\/match\/(m-[0-9a-f]{12})$/.exec(bob.page.url())?.[1];
    if (matchId === undefined) throw new Error(`no match id in ${bob.page.url()}`);
    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result'), 'the game is over').toBeVisible({ timeout: 30_000 });
    // Asked as carol: a series that may go on withholds its games' replays from their own players.
    const carol = await openFriend(browser, 'carol');
    await expect
      .poll(async () => (await carol.context.request.get(`${stack.origin}/cardtable/api/replays/${matchId}`)).status(), { timeout: 30_000, message: 'the recording is served' })
      .toBe(200);
    await servePictures(carol.context, PICTURES);
    await servePictures(carol.context, `${stack.origin}/watchparty/media/sprites`);
    await carol.page.goto(`${stack.origin}/cardtable/#/replay/${matchId}`);
    await expect(carol.page.getByTestId('replay-bar'), 'the replay opens').toBeVisible({ timeout: 30_000 });
    const replayed = carol.page.locator('[data-player-face]').filter({ has: carol.page.locator(`img[src="${PICTURE}"]`) });
    await expect(replayed, 'the replay draws alice’s picture').toHaveCount(1, { timeout: 30_000 });
    await expectDecorOver(carol.page, replayed.getByTestId('seat-avatar'), 'carol, alice’s face in the replay');
    await expect(replayed.locator('.face__name[data-dressed] .hc-name'), 'alice’s name in the replay wears its effect').toHaveCount(1);
  } finally {
    await stack.stop();
  }
});
