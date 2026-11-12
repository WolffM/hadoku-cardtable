/**
 * The relay's client half, end to end, through the real UI and the real relay socket
 * (`apps/server/src/play/relay-socket.ts`, `apps/server/src/play/runtimes/relay-match.ts`):
 * a test-only game type, `relay-test` (two seats, `runtime: 'relay'`), registered by
 * `plugins/relay.ts` behind `CARDTABLE_PLAY_PROBE=1` — never in production's registry — so this
 * runs on `play/harness.ts`'s stack, the one e2e posture that sets it.
 *
 * No real bundle either: a stub `GameBundleModule`
 * (`fixtures/relay-bundle/relay-test-embed.fixture.js`) is served same-origin by intercepting
 * `/relay-fixture/relay-test-embed.js` with Playwright's own `context.route` — the same technique
 * `bomberman.spec.ts` uses for its own stub. The client-side `relay-test` registration
 * (`apps/ui/src/rooms/BundleSlot.tsx`'s own gated block) needs one more thing bomberman's does
 * not: `window.__CARDTABLE_E2E_RELAY_TEST__`, set with `context.addInitScript` before the app's
 * own bundle ever evaluates — see that file's own doc for why.
 *
 * Alice makes the room (API, since no create-form button exists for a test-only type — the same
 * reason `createRoomByApi` exists for a streamed room), Bob joins it (seat 1), Carol joins third
 * (a watcher — the room is already full at two seats). Alice's message reaches Bob and Carol,
 * never back to herself; Carol's own send is refused (nothing is relayed to anyone); Alice, the
 * leader, ends the match, and Bob and Carol's panels both show it ended too.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';

const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/relay-bundle/relay-test-embed.fixture.js');

/** Serve the stub relay bundle for every request the room's `BundleSlot` makes, same origin, any port. */
async function stubRelayTestEmbed(context: BrowserContext): Promise<void> {
  await context.route('**/relay-fixture/relay-test-embed.js', (route) => route.fulfill({ path: FIXTURE_PATH, contentType: 'text/javascript' }));
}

/** `BundleSlot.tsx`'s own gated fixture registration (`registerGameType`/`registerGameRoomUi` for
 *  `relay-test`) reads this flag the moment its module evaluates — set before any page script
 *  runs, never only before `goto()`. */
async function flagRelayTestFixture(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    (window as unknown as { __CARDTABLE_E2E_RELAY_TEST__?: boolean }).__CARDTABLE_E2E_RELAY_TEST__ = true;
  });
}

/** A `relay-test` room the create form has no button for — `createRoomByApi`'s own technique
 *  (`play/rooms.ts`), widened to a game type that helper's own type does not name. */
async function createRelayTestRoom(friend: Friend, origin: string, name: string): Promise<string> {
  await friend.page.goto(`${origin}${PREFIX}/`);
  await friend.page.evaluate(async (body) => {
    const res = await fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST /api/rooms answered ${String(res.status)}`);
    const made = (await res.json()) as { id: string };
    window.location.hash = `#/room/${made.id}`;
  }, { name, gameType: 'relay-test', clientMode: 'builtin' });
  await friend.page.waitForFunction(() => /\/room\/[a-z0-9-]+$/.test(window.location.hash), null, { timeout: 30_000 });
  const hash = await friend.page.evaluate(() => window.location.hash);
  const m = /\/room\/([a-z0-9-]+)$/.exec(hash);
  if (m === null) throw new Error(`no room id in ${hash}`);
  return m[1]!;
}

const panel = (f: Friend) => f.page.getByTestId('relay-fixture');
const messages = (f: Friend) => f.page.getByTestId('relay-fixture-received').getByTestId('relay-fixture-message');
const ended = (f: Friend) => f.page.getByTestId('relay-fixture-ended');

test(titled('a relay-test room: two seats and a watcher talk over ctx.channel — the leader\'s message skips her own screen, the watcher cannot send, and ending it shows on every screen'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const carol = await openFriend(browser, 'carol');
    for (const f of [alice, bob, carol]) {
      await stubRelayTestEmbed(f.context);
      await flagRelayTestFixture(f.context);
    }

    const roomId = await createRelayTestRoom(alice, stack.origin, `e2e relay-test ${Date.now()}`);
    await bob.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await carol.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);

    await expect(panel(alice), "alice's own fixture mounts, seated").toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(panel(alice)).toHaveAttribute('data-is-leader', 'true');
    await expect(panel(alice)).toHaveAttribute('data-my-seat', '0');
    await expect(panel(bob), "bob's own fixture mounts, seated").toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(panel(bob)).toHaveAttribute('data-my-seat', '1');
    await expect(panel(carol), "carol's own fixture mounts, a watcher").toHaveAttribute('data-room-key', roomId, { timeout: 15_000 });
    await expect(panel(carol)).toHaveAttribute('data-my-seat', '');

    // Every seat (never a watcher) gets a channel at all.
    for (const f of [alice, bob, carol]) await expect(panel(f)).toHaveAttribute('data-has-channel', 'true');

    // Alice's message reaches bob and carol, never back to herself.
    await alice.page.getByTestId('relay-fixture-send').click();
    await expect(messages(bob), 'bob hears alice').toHaveCount(1, { timeout: 15_000 });
    await expect(messages(carol), 'carol (the watcher) hears alice too').toHaveCount(1, { timeout: 15_000 });
    await expect(messages(alice), 'alice never hears her own send').toHaveCount(0);

    // Carol's own send is refused: nothing is relayed to anyone.
    await carol.page.getByTestId('relay-fixture-send').click();
    await alice.page.waitForTimeout(500);
    await expect(messages(bob), "bob hears nothing more from carol's refused send").toHaveCount(1);
    await expect(messages(alice)).toHaveCount(0);

    // The leader ends it; every screen shows it ended.
    await alice.page.getByTestId('relay-fixture-end').click();
    await expect(ended(alice), "alice's own screen shows it ended").toBeVisible({ timeout: 15_000 });
    await expect(ended(bob), "bob's screen shows it ended too").toBeVisible({ timeout: 15_000 });
    await expect(ended(carol), "carol's screen shows it ended too").toBeVisible({ timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});
