/**
 * A bomberman room end to end through the real UI: make it, two seats join, the room's own
 * `game` slot mounts a stub bundle with the room's own context, and leaving the room unmounts it.
 *
 * No Forge jar needed — bomberman's match never reaches this server (the wave file's Settled
 * section) — and no real bomberman bundle either: hadoku-bomberman has no licence and a private
 * repo (never copied here), so `/bomberman/embed/bomberman-embed.js` is intercepted with
 * Playwright's own `context.route` and fulfilled from `e2e/fixtures/bomberman-embed.fixture.js`,
 * a stub `GameBundleModule` that echoes the `GameBundleContext` it is handed into the DOM — same
 * same-origin dynamic-`import()` path production uses, just served by the test instead of the
 * (nonexistent, in this harness) bomberman service.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { roomIdFromAddress } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { openCreateRoom } from './play/rooms.ts';

const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/bomberman-embed.fixture.js');

/** Serve the stub bundle for every request the room's `BundleSlot` makes, same origin, any port. */
async function stubBombermanEmbed(context: BrowserContext): Promise<void> {
  await context.route('**/bomberman/embed/bomberman-embed.js', (route) =>
    route.fulfill({ path: FIXTURE_PATH, contentType: 'text/javascript' }),
  );
}

const fixturePanel = (page: import('@playwright/test').Page) => page.getByTestId('bomberman-fixture');

test('a bomberman room: made, both seats join, the stub mounts with roomKey + both seats + isLeader, and leaving unmounts it', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    await stubBombermanEmbed(alice.context);
    await stubBombermanEmbed(bob.context);

    await alice.page.goto(`${PREFIX}/`);
    await openCreateRoom(alice.page);
    await alice.page.getByTestId('room-create-name').fill(`e2e bomberman ${Date.now()}`);
    await alice.page.getByTestId('room-create-type-bomberman').click();
    await expect(alice.page.getByTestId('room-create-type-bomberman')).toBeChecked();
    // Bomberman has no mode of its own: the Constructed mode row is not offered for it.
    await expect(alice.page.getByTestId('room-create-constructed-mode')).toHaveCount(0);
    await alice.page.getByTestId('room-create-submit').click();
    const roomId = await roomIdFromAddress(alice.page);

    await bob.page.goto(`${PREFIX}/#/room/${roomId}`);

    // Both seats: the leader's own context, and the one it was handed to another member.
    await expect(fixturePanel(alice.page)).toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(fixturePanel(alice.page)).toHaveAttribute('data-is-leader', 'true');
    await expect(fixturePanel(bob.page)).toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(fixturePanel(bob.page)).toHaveAttribute('data-is-leader', 'false');

    for (const page of [alice.page, bob.page]) {
      const seats = page.getByTestId('bomberman-fixture-seat');
      await expect(seats).toHaveCount(2);
      await expect(seats).toContainText(['e2e-alice', 'e2e-bob']);
    }

    // Leaving the room the way a player does, by the header's way home (an in-page navigation,
    // never a reload), unmounts the mounted bundle — not merely "the page changed", which a full
    // navigation would prove trivially and dishonestly.
    await alice.page.getByTestId('chrome-home').click();
    await expect.poll(() => alice.page.evaluate(() => window.location.pathname)).not.toContain('/room/');
    await expect(fixturePanel(alice.page)).toHaveCount(0);
    await expect
      .poll(() => alice.page.evaluate(() => (window as unknown as { __bombermanFixture?: { unmounts: number } }).__bombermanFixture?.unmounts ?? 0))
      .toBeGreaterThan(0);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
