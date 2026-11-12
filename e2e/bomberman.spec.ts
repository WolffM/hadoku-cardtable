/**
 * A bomberman room end to end through the real UI and the real relay: make it, two seats join,
 * the room's own `game` slot mounts a stub bundle with the room's own context and a
 * `ctx.channel`, the seats talk over it, one drops and comes back inside bomberman's seat hold,
 * the leader's `{ t: 'over', winners }` shows as the room's result (on a page reloaded after the
 * end too), and leaving the room unmounts the bundle.
 *
 * Bomberman is `runtime: 'relay'` (`@hadoku/shared`'s `BOMBERMAN_GAME_TYPE_SPEC`), so its room's
 * match is a `RelayMatch` and this runs on `play/harness.ts`'s stack, as `relay-fixture.spec.ts`
 * does. No real bomberman bundle: hadoku-bomberman's code never enters this repo, so
 * `/bomberman/embed/bomberman-embed.js` is intercepted with Playwright's own `context.route` and
 * fulfilled from `e2e/fixtures/bomberman-embed.fixture.js`, a stub `GameBundleModule` that echoes
 * the `GameBundleContext` it is handed into the DOM and reads `ctx.channel` — same same-origin
 * dynamic-`import()` path production uses.
 *
 * `[bomberman]` lines are the evidence.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { makeTitled, roomIdFromAddress, serverLog } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';

const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/bomberman-embed.fixture.js');

/** Bomberman's own seat hold, which the spec carries to the relay (`BOMBERMAN_GAME_TYPE_SPEC`). */
const SEAT_HOLD_MS = 120_000;

/** Serve the stub bundle for every request the room's `BundleSlot` makes, same origin, any port. */
async function stubBombermanEmbed(context: BrowserContext): Promise<void> {
  await context.route('**/bomberman/embed/bomberman-embed.js', (route) =>
    route.fulfill({ path: FIXTURE_PATH, contentType: 'text/javascript' }),
  );
}

const fixturePanel = (page: Page) => page.getByTestId('bomberman-fixture');
const messages = (page: Page) => page.getByTestId('bomberman-fixture-received').getByTestId('bomberman-fixture-message');

test(titled('a bomberman room plays over the relay: both seats get a channel and talk, a seat drops and returns inside the hold, the leader\'s over is the room\'s result, and leaving unmounts it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await stubBombermanEmbed(alice.context);
    await stubBombermanEmbed(bob.context);

    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await openCreateRoom(alice.page);
    await alice.page.getByTestId('room-create-name').fill(`e2e bomberman ${Date.now()}`);
    await alice.page.getByTestId('room-create-type-bomberman').click();
    await expect(alice.page.getByTestId('room-create-type-bomberman')).toBeChecked();
    // Bomberman has no mode of its own: the Constructed mode row is not offered for it.
    await expect(alice.page.getByTestId('room-create-constructed-mode')).toHaveCount(0);
    await alice.page.getByTestId('room-create-submit').click();
    const roomId = await roomIdFromAddress(alice.page);

    let bobPage = bob.page;
    await bobPage.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);

    // Both seats: the leader's own context, and the one it was handed to another member.
    await expect(fixturePanel(alice.page)).toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(fixturePanel(alice.page)).toHaveAttribute('data-is-leader', 'true');
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-is-leader', 'false');
    for (const page of [alice.page, bobPage]) {
      const seats = page.getByTestId('bomberman-fixture-seat');
      await expect(seats).toHaveCount(2);
      await expect(seats).toContainText(['e2e-alice', 'e2e-bob']);
      // The stub reads ctx.channel: a relay room hands every seat one.
      await expect(fixturePanel(page)).toHaveAttribute('data-has-channel', 'true');
    }
    await expect(fixturePanel(alice.page)).toHaveAttribute('data-my-seat', '0');
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-my-seat', '1');

    // The two seats exchange a message, each way, never hearing their own.
    await alice.page.getByTestId('bomberman-fixture-send').click();
    await expect(messages(bobPage), 'bob hears alice').toHaveCount(1, { timeout: 15_000 });
    await bobPage.getByTestId('bomberman-fixture-send').click();
    await expect(messages(alice.page), 'alice hears bob').toHaveCount(1, { timeout: 15_000 });
    await expect(messages(bobPage)).toContainText(['"from":0']);
    await expect(messages(alice.page)).toContainText(['"from":1']);

    // Bob drops (his page goes) and comes back inside the hold: the relay holds his seat for
    // bomberman's own seat hold, and he is back on it, hearing alice again.
    const relay = () => serverLog(stack).filter((r) => r.matchId === roomId && typeof r.evt === 'string' && r.evt.startsWith('relay-seat-'));
    await bobPage.close();
    await expect.poll(() => relay().filter((r) => r.evt === 'relay-seat-held'), { timeout: 15_000 }).toHaveLength(1);
    const held = relay().find((r) => r.evt === 'relay-seat-held');
    expect(held?.graceMs, "bomberman's seat hold reached the relay match").toBe(SEAT_HOLD_MS);
    bobPage = await bob.context.newPage();
    await bobPage.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-has-channel', 'true', { timeout: 15_000 });
    await expect.poll(() => relay().filter((r) => r.evt === 'relay-seat-back').map((r) => r.seat), { timeout: 15_000 }).toEqual([held?.seat]);
    expect(relay().filter((r) => r.evt === 'relay-seat-left'), 'nobody left the match').toEqual([]);
    await alice.page.getByTestId('bomberman-fixture-send').click();
    await expect(messages(bobPage), 'bob, back, hears alice again').toHaveCount(1, { timeout: 15_000 });

    // The leader's bundle ends the match, bob (seat 1) the winner: the room shows it on both screens.
    await alice.page.evaluate(() => {
      (window as unknown as { __bombermanFixture: { overWinners: number[] } }).__bombermanFixture.overWinners = [1];
    });
    await alice.page.getByTestId('bomberman-fixture-over').click();
    for (const page of [alice.page, bobPage]) {
      await expect(page.getByTestId('room-bundle-result')).toHaveText('e2e-bob won', { timeout: 15_000 });
      await expect(page.getByTestId('room-bundle-result')).toHaveAttribute('data-winners', '1');
    }
    // The result on reload: bob's page loads again after the end and still shows it.
    await bobPage.reload();
    await expect(fixturePanel(bobPage)).toHaveAttribute('data-has-channel', 'true', { timeout: 15_000 });
    await expect(bobPage.getByTestId('room-bundle-result'), 'bob, reloaded after the end, sees the result').toHaveText('e2e-bob won', { timeout: 15_000 });
    console.log(`[bomberman] room=${roomId} relay=${JSON.stringify(relay())} ended=${JSON.stringify(serverLog(stack).filter((r) => r.evt === 'relay-ended' && r.matchId === roomId))}`);

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
    await stack.stop();
  }
});
