/**
 * The draft, the deck builder, the game and the sideboard have no top bar: Home, the theme picker,
 * the settings and the page's links are in the chat's toolbar (watchparty's own, `RoomChrome`'s
 * `toolbar`), and the screen starts at the top of the window. Looking at the front page or the room
 * (its lobby, its page in rounds, a table's page) keeps the bar.
 *
 * One real pod of two walks all of it: the front page and the room's lobby (bar), the draft, the
 * deck builder, the room's page in rounds and a table's page (bar again), the board, its result and
 * the sideboard between games, and the same step entered from the table's page.
 *
 * `[pt-toolbar]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { trimMainDeck } from './deckBuilder.ts';
import { PREFIX } from './identities.ts';
import { arrangePod, draftUntilDone, readyPod } from './podSeats.ts';
import { enterFromTablePage, makeTitled, resizeWindow, ROOM_PAGE, roomIdFromAddress, sideboardFromTablePage, toMyTable } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openMyTable, submitCreateRoom } from './play/rooms.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;

const say = (line: string): void => console.log(`[pt-toolbar] ${line}`);

/** The top bar's own Home (the app's name) and its two links. */
const topBarHome = (page: Page) => page.getByTestId('chrome-home');
const topBarLinks = (page: Page) => page.locator('[data-testid="header-discord"], [data-testid="header-github"]');

/** The chat toolbar's controls, by the names a player is told: found in the room's frame, not by its classes. */
const room = (page: Page) => page.getByTestId('room-shell');
const toolbar = (page: Page) => ({
  home: room(page).getByRole('button', { name: 'Home', exact: true }),
  theme: room(page).getByRole('button', { name: 'Choose theme', exact: true }),
  settings: room(page).getByRole('button', { name: /^User settings/ }),
  discord: room(page).getByRole('link', { name: 'Discord', exact: true }),
  github: room(page).getByRole('link', { name: 'GitHub', exact: true }),
});

const top = async (page: Page, testId: string): Promise<number> => {
  const box = await page.getByTestId(testId).first().boundingBox();
  if (box === null) throw new Error(`${testId} has no box`);
  return box.y;
};

/** A page with no top bar: the toolbar carries its controls, the settings open from it, and `screenId` starts where the page does. */
async function assertToolbarPage(p: Player, where: string, screenId: string): Promise<void> {
  const page = p.page;
  const who = `${p.name} (${where})`;
  await expect(page.getByTestId(screenId).first(), `${who}: the screen is up`).toBeVisible({ timeout: UI_TIMEOUT });
  await expect(topBarHome(page), `${who}: no top bar`).toHaveCount(0);
  await expect(topBarLinks(page), `${who}: no top-bar links`).toHaveCount(0);
  const bar = toolbar(page);
  for (const [name, control] of Object.entries(bar)) await expect(control, `${who}: the chat toolbar has ${name}`).toBeVisible({ timeout: UI_TIMEOUT });
  await expect(bar.settings, `${who}: one settings gear on the page`).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^User settings/ }), `${who}: and no other anywhere`).toHaveCount(1);
  await expect(room(page).getByRole('button', { name: /media/i }), `${who}: no media loader`).toHaveCount(0);
  expect(await bar.discord.getAttribute('href'), `${who}: Discord is a link out`).toMatch(/^https:\/\/discord\.gg\//);
  expect(await bar.github.getAttribute('href'), `${who}: GitHub is a link out`).toMatch(/^https:\/\/github\.com\//);

  const pageTop = await top(page, 'room-shell');
  const screenTop = await top(page, screenId);
  say(`${who}: page content starts at ${pageTop}, ${screenId} at ${screenTop}`);
  expect(pageTop, `${who}: the page's content starts at the top of the window`).toBe(0);
  expect(screenTop, `${who}: ${screenId} starts where the page's content does`).toBe(pageTop);

  await openSettings(page);
  await closeSettings(page);
}

/** A page that keeps its top bar: the bar's Home and links, and no toolbar in the chat. */
async function assertTopBarPage(p: Player, where: string): Promise<void> {
  const who = `${p.name} (${where})`;
  await expect(topBarHome(p.page), `${who}: the top bar`).toBeVisible({ timeout: UI_TIMEOUT });
  await expect(topBarLinks(p.page), `${who}: its Discord and GitHub links`).toHaveCount(2);
  await expect(toolbar(p.page).home, `${who}: no Home in the chat`).toHaveCount(0);
  await expect(p.page.getByRole('button', { name: /^User settings/ }), `${who}: one settings gear, the bar's`).toHaveCount(1);
}

test(
  titled('the draft, the deck builder, the game and the sideboard have no top bar, and the chat toolbar carries its controls'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    try {
      const alice = await openFriend(browser, 'alice');
      const bob = await openFriend(browser, 'bob');
      const players = [alice, bob];

      await alice.page.goto(`${origin}${PREFIX}/`);
      await assertTopBarPage(alice, 'front page');
      await submitCreateRoom(alice.page, { name: `e2e toolbar ${Date.now()}`, gameType: 'draft' });
      const roomId = await roomIdFromAddress(alice.page);
      const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
      await bob.page.goto(roomUrl);
      await expect(bob.page.getByTestId('draft-lobby'), 'bob: joined the room').toBeVisible({ timeout: UI_TIMEOUT });

      // Each page's own member id, so "which seat is mine" resolves (`e2e/w72-pod.spec.ts` says why).
      const roomBody = (await alice.page.evaluate(
        (id) => fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
        roomId,
      )) as { members: { id: string; name: string }[] };
      for (const p of players) {
        const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
        if (me === undefined) throw new Error(`${p.name}: not found among the room’s own members`);
        await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: `e2e-${p.name}` } }));
        await p.page.reload();
        await resizeWindow(p.page, { width: 1280, height: 800 });
      }

      /* ── the room's lobby keeps its bar ─────────────────────────────── */
      for (const p of players) await expect(p.page.getByTestId('pod-seats'), `${p.name}: the pod's seats are up`).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(room(alice.page), 'alice: the room’s chat is drawn').toBeVisible({ timeout: UI_TIMEOUT });
      await assertTopBarPage(alice, 'room lobby');

      await arrangePod([
        [alice.page, 0],
        [bob.page, 1],
      ]);
      for (const seat of [2, 3, 4, 5, 6, 7]) await alice.page.locator(`[data-testid="pod-seat-close"][data-seat="${seat}"]`).click();
      await expect(alice.page.locator('[data-testid^="pod-seat-"][data-closed]')).toHaveCount(6);
      for (const p of players) await readyPod(p.page);

      /* ── the draft ──────────────────────────────────────────────────── */
      for (const p of players) await assertToolbarPage(p, 'draft', 'pod');
      await expect(alice.page.getByTestId('draft-screen'), 'alice: the pack is up').toBeVisible({ timeout: UI_TIMEOUT });
      expect(await top(alice.page, 'draft-screen'), 'alice: the draft is not pushed down by a bar that left late').toBeLessThan(40);

      await Promise.all(players.map((p) => draftUntilDone(p.page)));

      /* ── the deck builder ───────────────────────────────────────────── */
      for (const p of players) {
        await expect(p.page.getByTestId('deck-editor'), `${p.name}: the finished draft opens the editor`).toBeVisible({ timeout: UI_TIMEOUT });
        await assertToolbarPage(p, 'deck builder', 'deck');
      }
      // Loaded cold, as a link or a reload opens it: still no bar once it is drawn.
      await bob.page.reload();
      await assertToolbarPage(bob, 'deck builder, reloaded', 'deck');
      for (const p of players) {
        await trimMainDeck(p.page, 40, p.name);
        await p.page.getByTestId('play-deck').click();
        await p.page.waitForURL(ROOM_PAGE, { timeout: UI_TIMEOUT });
      }

      /* ── looking at the room: its page and a table's page keep the bar ── */
      for (const p of players) {
        await expect(p.page.getByTestId('pod-rounds'), `${p.name}: round 1, on the room’s page`).toBeVisible({ timeout: UI_TIMEOUT });
        await assertTopBarPage(p, 'room page, in rounds');
      }
      const led = [await toMyTable(alice.page, UI_TIMEOUT), await toMyTable(bob.page, UI_TIMEOUT)];
      expect(led[0], 'alice: first to her table, she waits on its page').toBe('table');
      await expect(alice.page.getByTestId('table-page'), 'alice: the table page').toBeVisible({ timeout: UI_TIMEOUT });
      await assertTopBarPage(alice, 'table page');

      /* ── the game: no top bar, for the whole of it ──────────────────── */
      for (const [i, p] of players.entries()) {
        if (led[i] === 'table') await enterFromTablePage(p.page, MATCH_URL, UI_TIMEOUT);
        else await p.page.waitForURL(MATCH_URL, { timeout: UI_TIMEOUT });
        await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: at their table`).toBeVisible({ timeout: UI_TIMEOUT });
      }
      for (const p of players) await assertToolbarPage(p, 'game board', 'match');

      /* ── the result and the sideboard, between games ────────────────── */
      await bob.page.getByTestId('live-concede').click();
      await bob.page.getByTestId('live-concede-yes').click();
      for (const p of players) await expect(p.page.getByTestId('game-result'), `${p.name}: game 1 is over`).toBeVisible({ timeout: UI_TIMEOUT });
      await assertToolbarPage(alice, 'game result', 'match');
      for (const p of players) {
        await p.page.getByTestId('game-result-next').click({ timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('sideboard-step'), `${p.name}: Next opens the sideboard step`).toBeVisible({ timeout: UI_TIMEOUT });
      }
      await assertToolbarPage(alice, 'sideboard, in the match', 'match');

      // The same step from the room: the table's page keeps the bar, its sideboard screen has none.
      await openMyTable(bob.page, roomUrl);
      await assertTopBarPage(bob, 'table page, between games');
      await sideboardFromTablePage(bob.page, UI_TIMEOUT);
      await assertToolbarPage(bob, 'sideboard, from the room', 'table-sideboard-page');

      /* ── Home goes where the top bar's does, and the bar is back there ── */
      await toolbar(bob.page).home.click();
      await expect(bob.page.getByTestId('pod'), 'bob: left the room’s screens').toHaveCount(0);
      await assertTopBarPage(bob, 'front page, by the toolbar’s Home');
      say('the draft, the deck builder, the game and the sideboard draw with no top bar; the front page, the room and a table’s page keep it');
    } finally {
      // `stack.stop()` closes every `openFriend` context itself (`e2e/w72-pod.spec.ts`).
      await stack.stop();
    }
  },
);
