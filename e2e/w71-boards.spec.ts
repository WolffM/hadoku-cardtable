/**
 * Wave 71 §G's acceptance sequence (`docs/planning/wave71-2026-10-17.md`):
 *
 *   A room gets a second table. Alice plays the AI at table 1 and Bob plays
 *   the AI at table 2. Carol, unseated, opens table 1's board, switches to
 *   table 2's from the strip, and switches back. Her chat panel is the same
 *   room chat on all three boards.
 *
 * This lane (G) owns the board strip and the chat key; lane D owns the
 * tables themselves (`apps/server/src/room/lobby.ts`, `http/routes.ts`) and
 * had not landed when this spec was written — the wave file says to write it
 * now and run it after D lands. Two pieces below are therefore D's CONTRACT,
 * not its code, and are the one thing to re-check if this spec reds on a run
 * where `check` is otherwise green:
 *
 *   - `POST /api/tables/rooms/:roomId/tables` adds a table and answers the
 *     new `RoomTable` (its `id` is read straight off the body below).
 *   - every table-scoped route — the add above, `PUT …/deck`, and
 *     `POST /api/play/matches` — takes the table as an optional `table` field
 *     in its JSON body, per the wire contract's own wording ("Table-scoped
 *     routes take the table as an optional table body field").
 *
 * Both tables are solo-vs-bot, not two-player, because the acceptance text
 * only needs two LIVE tables for the strip to appear — a real second human
 * at table 2 is Bob, but he never needs Forge's UI, so his half of the setup
 * goes through the API the same way `e2e/play/rooms.ts`'s `createRoomByApi`
 * already bypasses the UI for a shape it does not offer.
 *
 * ## Proving "the same room chat", without guessing at a third party's DOM
 *
 * `@wolffm/watchparty-ui`'s chat is not ours to put a `data-testid` on, and
 * its shipped bundle (read out of `dist/chunks/Room-*.js` for this spec) has
 * none on its message list either. What IS stable, because the chrome itself
 * depends on the server understanding it, is the wire: `RoomChrome` joins
 * watchparty's own room with a `room_key` field (`dist/room-chrome.js`'s
 * `Wo({ room_key: e, … })`), sent once per `roomKey` the component is given,
 * over whichever transport socket.io is using (websocket or long-polling, the
 * same two this app's own match socket can start on — `openFriend`'s capture
 * comment says why). So this spec watches CAROL's page for every `room_key`
 * her browser ever sends, across all three boards, and asserts there is
 * exactly one DISTINCT value and that it is the ROOM's key
 * (`cardtable-<roomId>`) — never the match's. Before wave 71 §G this would
 * have been two keys, one per match id, because `RoomShell` tore the chrome
 * down and rebuilt it on every board switch; the mutation test for that is
 * `RoomShell.test.ts`'s unit test, not this file.
 */
import { expect, test, type Page } from '@playwright/test';

import { openFriend } from './play/browser.ts';
import { resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';
import { twoLegalDecks } from './play/enter.ts';

const PREFIX = '/cardtable';
const forge = forgeAvailability();

async function sendJson(page: Page, method: 'POST' | 'PUT', url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let json: Record<string, unknown>;
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        json = {};
      }
      return { status: res.status, body: json };
    },
    { method, url, body },
  );
}

/** Which of a room's tables carries `matchId` — the add-table response only ever hands back the NEW table's id, so table 1's own id is read off the room the same raw way `MatchScreen.tsx` reads `tables`. */
async function tableIdFor(page: Page, origin: string, roomId: string, matchId: string): Promise<string> {
  const body = await page.evaluate(
    async ({ origin, roomId }) => {
      const res = await fetch(`${origin}/cardtable/api/rooms/${roomId}`, { credentials: 'same-origin' });
      return (await res.json()) as unknown;
    },
    { origin, roomId },
  );
  const tables = (body as { tables?: { id: string; matchId: string | null }[] }).tables ?? [];
  const found = tables.find((t) => t.matchId === matchId);
  if (found === undefined) throw new Error(`no table in room ${roomId} has matchId ${matchId} (tables: ${JSON.stringify(tables)})`);
  return found.id;
}

/** Every `room_key` Carol's browser ever sends, over either transport, for as long as `page` lives. */
function watchRoomKeys(page: Page): string[] {
  const keys: string[] = [];
  const takeFrom = (text: string): void => {
    const m = /"room_key":"([^"]+)"/.exec(text);
    if (m) keys.push(m[1]!);
  };
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => takeFrom(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')));
  });
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const data = req.postData();
    if (data !== null) takeFrom(data);
  });
  return keys;
}

test('a room with two live tables shows the strip, switching boards never drops the room chat, and a player’s own board is never conceded by picking another', async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);

  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const choice = await twoLegalDecks(alice.context.request, stack.origin);

    // ── the room, and its second table ──────────────────────────────────
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    await openCreateRoom(alice.page);
    await alice.page.getByTestId('room-create-name').fill(`e2e w71 boards ${Date.now()}`);
    await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
    await alice.page.getByTestId('room-create-submit').click();
    await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    const roomUrl = alice.page.url();
    const roomId = roomUrl.split('/room/')[1]!;

    const added = await sendJson(alice.page, 'POST', `${stack.origin}${PREFIX}/api/tables/rooms/${roomId}/tables`, {});
    expect(added.status, `adding a second table: ${JSON.stringify(added.body)}`).toBe(201);
    const table2 = added.body.id as string;
    expect(table2, 'the new table carries an id').toBeTruthy();

    // ── table 1: alice vs the AI, through the product ───────────────────
    await alice.page.getByTestId('format').selectOption(choice.format);
    await expect(alice.page.getByTestId('deck-mine')).toBeEnabled({ timeout: 15_000 });
    await alice.page.getByTestId('deck-mine').locator(`[data-deck-id="${choice.decks[0]}"]`).click();
    await expect(alice.page.getByTestId('play-vs-bot'), 'alice may start the AI once her deck is legal').toBeEnabled({ timeout: 15_000 });
    await alice.page.getByTestId('play-vs-bot').click();
    const matchRe1 = /#\/match\/(m-[0-9a-f]{12})$/;
    await alice.page.waitForURL(matchRe1, { timeout: 60_000 });
    const matchId1 = matchRe1.exec(alice.page.url())?.[1];
    if (matchId1 === undefined) throw new Error(`no match id in ${alice.page.url()}`);
    await expect(alice.page.locator('[aria-label="Game board"]'), 'alice’s own board came up at table 1').toBeVisible({ timeout: 30_000 });
    const table1 = await tableIdFor(alice.page, stack.origin, roomId, matchId1);

    // ── table 2: bob vs the AI, through the API — no UI offers table 2 yet
    // (wave 72's multi-table lobby), so this is the same bypass
    // `createRoomByApi` already uses for a shape the form does not make.
    await bob.page.goto(roomUrl);
    const deckLoad = await sendJson(bob.page, 'PUT', `${stack.origin}${PREFIX}/api/tables/rooms/${roomId}/deck`, {
      deck: { library: choice.decks[1] },
      table: table2,
    });
    expect(deckLoad.status, `bob’s deck at table 2: ${JSON.stringify(deckLoad.body)}`).toBe(200);
    const vsBot = await sendJson(bob.page, 'POST', `${stack.origin}${PREFIX}/api/play/matches`, { room: roomId, bot: true, table: table2 });
    expect(vsBot.status, `bob vs the AI at table 2: ${JSON.stringify(vsBot.body)}`).toBe(201);
    const matchId2 = vsBot.body.matchId as string;
    expect(matchId2, 'table 2’s match carries an id').toBeTruthy();
    await bob.page.goto(`${stack.origin}${PREFIX}/#/match/${matchId2}`);
    await expect(bob.page.locator('[aria-label="Game board"]'), 'bob’s own board came up at table 2').toBeVisible({ timeout: 30_000 });

    // ── carol: unseated, carried to table 1, then the strip ─────────────
    const carol = await openFriend(browser, 'carol');
    await resizeWindow(carol.page, { width: 1280, height: 800 });
    const roomKeys = watchRoomKeys(carol.page);
    await carol.page.goto(roomUrl);
    await carol.page.waitForURL(new RegExp(`#/match/${matchId1}$`), { timeout: 60_000 });
    await expect(carol.page.locator('[aria-label="Game board"]'), 'carol was carried to table 1, as a watcher').toBeVisible({ timeout: 30_000 });

    const strip = carol.page.getByTestId('board-strip');
    await expect(strip, 'two live tables draw the strip').toBeVisible({ timeout: 15_000 });
    await expect(carol.page.getByTestId('board-strip-entry')).toHaveCount(2);
    const entryFor = (table: string) => carol.page.locator(`[data-testid="board-strip-entry"][data-table-id="${table}"]`);

    // Switch to table 2 — timed, picking to the new board's first frame.
    const toTable2 = Date.now();
    await entryFor(table2).click();
    await carol.page.waitForURL(new RegExp(`#/match/${matchId2}$`), { timeout: 15_000 });
    await expect(carol.page.locator('[aria-label="Game board"]'), 'carol’s board is now table 2’s').toBeVisible({ timeout: 15_000 });
    const switchToTable2Ms = Date.now() - toTable2;
    console.log(`[w71-switch-ms] ${switchToTable2Ms}`);

    // Switching away from table 1 did not touch alice's own game.
    await expect(alice.page.locator('[aria-label="Game board"]'), 'alice’s own board is untouched by carol’s switch').toBeVisible();

    // Switch back — timed the same way, the other direction.
    const backToTable1 = Date.now();
    await entryFor(table1).click();
    await carol.page.waitForURL(new RegExp(`#/match/${matchId1}$`), { timeout: 15_000 });
    await expect(carol.page.locator('[aria-label="Game board"]'), 'carol’s board is table 1’s again').toBeVisible({ timeout: 15_000 });
    const switchBackMs = Date.now() - backToTable1;
    console.log(`[w71-switch-ms] ${switchBackMs}`);

    // ── her chat is the room's, not the match's, on all three boards ────
    await expect.poll(() => roomKeys.length, { timeout: 15_000, message: 'watchparty joined at least once' }).toBeGreaterThanOrEqual(1);
    const distinct = [...new Set(roomKeys)];
    console.log(`[w71-boards] room_key joins observed on carol’s page: ${JSON.stringify(roomKeys)}`);
    expect(distinct, 'carol’s chat is ONE watchparty room across all three boards, not one per match').toHaveLength(1);
    expect(distinct[0]).toBe(`cardtable-${roomId}`);
  } finally {
    await stack.stop();
  }
});
