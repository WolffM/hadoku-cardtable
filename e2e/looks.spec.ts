/**
 * One avatar, everywhere (the operator, 2026-11-05): *"picture/character are the
 * same thing and all over the entire site it's the same avatar. we must display
 * all customizations everywhere."*
 *
 * Alice wears an uploaded picture, an overlay and a name effect. Bob sees all
 * three on her seat in the room, and again on her face on the board.
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

test(titled('a picture, an overlay and a name effect show on the room seat and on the board face, to the other player'), async ({ browser }) => {
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
    // And on her own board, the same.
    await alice.page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 120_000 });
    const mine = alice.page.locator('[data-player-face][data-viewer]');
    await expect(mine.getByTestId('seat-avatar'), 'alice’s own board draws her picture').toHaveAttribute('src', PICTURE, { timeout: 30_000 });
    await expectDecorOver(alice.page, mine.getByTestId('seat-avatar'), 'alice, her own board face');
  } finally {
    await stack.stop();
  }
});
