/**
 * Wave 71 §G's acceptance sequence (`docs/planning/wave71-2026-10-17.md`):
 *
 *   A room gets a second table. Alice plays the AI at table 1 and Bob plays
 *   the AI at table 2. Carol, unseated, is carried to table 1's board once,
 *   goes back to the room and stays there, then opens table 2's. Since
 *   2026-10-19 there is no strip over the board, and each table's board has a
 *   chat of its own, apart from the room's lobby chat.
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
 * ## Proving "the same room chat" — two attempts that do not work here, first
 *
 * This e2e harness (`play/harness.ts`) runs OUR server and OUR Forge, and
 * nothing else — there is no watchparty backend behind `/watchparty` here
 * (production's is a separate microservice, proxied in by hadoku_site's
 * edge). So neither of the two obvious proofs holds up:
 *
 *  - **Reading the wire.** `RoomChrome` joins watchparty's room with a
 *    `room_key` field (`dist/room-chrome.js`'s `Wo({ room_key: e, … })`), over
 *    socket.io. Captured on carol's page (every websocket frame sent, every
 *    polling POST body) across a full run here: zero. The socket never reaches
 *    `connect` — there is nothing at `/watchparty` for it to connect TO — so
 *    the queued `join` emit never flushes onto a wire this spec can watch.
 *  - **Sending a real message.** The compose box (`getByPlaceholder('Send a
 *    message')`) is real and typeable, and a message submitted through it
 *    does not throw — but it never reaches a second page either, for the same
 *    reason: there is no shared backend for two browsers to meet at.
 *
 * What DOES fire with no live backend at all: the join is logged, not just
 * sent — `d("room-chrome", "Joining room", { roomKey: e, … })`
 * (`room-chrome.js`), a synchronous `console.log` the moment the effect runs,
 * gated on watchparty's own debug flag (`localStorage['wp:debug']`, read
 * fresh on each call — `Yr()` in the bundle). Set BEFORE this spec's first
 * navigation (`context.addInitScript`, so it is there for the react app's
 * very first render) and read back off carol's `console` events, this is a
 * direct read of the exact prop `RoomShell` computed — `roomIdFor`'s answer,
 * the thing wave 71 §G changed — with no dependency on a live connection at
 * all. Before §G this would show one DISTINCT key per match (`cardtable-m-
 * <matchId>`); after it, one key for the whole sequence (`cardtable-<roomId>`),
 * because the room id this spec's three boards share never changes.
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

/** `@wolffm/watchparty-ui`'s chat compose box — no `data-testid`, but a stable accessible placeholder. */
const chatBoxOf = (page: Page) => page.getByPlaceholder('Send a message');

/**
 * Every `roomKey` watchparty's `RoomChrome` logs joining, on `page`, from now
 * on — see the header for why this is a console read and not a wire read.
 * `wp:debug` has to be set before the FIRST navigation for the react app's
 * own first render to see it, so this both arms the flag (via
 * `addInitScript`, covering every navigation this page makes from here on)
 * and starts listening, in one call.
 */
async function watchRoomChromeJoins(page: Page): Promise<string[]> {
  await page.context().addInitScript(() => {
    try {
      window.localStorage.setItem('wp:debug', 'true');
    } catch {
      // No localStorage (a locked-down profile): the flag stays off and this
      // spec's capture stays empty, which is a skip-worthy result, not a crash.
    }
  });
  const keys: string[] = [];
  page.on('console', (msg) => {
    const m = /"roomKey":"([^"]+)"/.exec(msg.text());
    if (m) keys.push(m[1]!);
  });
  return keys;
}

test('a room with two live tables: a watcher is carried in once, stays in the room by choice, and each table’s board has its own chat, apart from the room’s', async ({ browser }) => {
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
    //
    // `goto` only waits for the page to load, not for `ConstructedScreen`'s own
    // join-on-mount effect (`ConstructedScreen.tsx`'s "Entering a room joins
    // it") to resolve — every table-scoped route 404s "no such room" for a
    // caller who is not a member yet (`routes.ts`'s `tableFor`), and the very
    // first run of this spec raced exactly that and 404'd on the deck PUT. So
    // this joins explicitly, through the same `POST …/join` the UI's own
    // effect calls, and gates the PUT on THAT answering rather than on a
    // timer — a join is idempotent (`rooms.ts`'s `/join` handler re-joins a
    // member who asks again), so this never fights the UI's own background join.
    await bob.page.goto(roomUrl);
    const joined = await sendJson(bob.page, 'POST', `${stack.origin}${PREFIX}/api/rooms/${roomId}/join`, {});
    expect(joined.status, `bob joining the room: ${JSON.stringify(joined.body)}`).toBe(200);
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

    // ── carol: unseated, carried to table 1 once, and each board its own chat ──
    const carol = await openFriend(browser, 'carol');
    await resizeWindow(carol.page, { width: 1280, height: 800 });
    const roomChromeJoins = await watchRoomChromeJoins(carol.page);
    await carol.page.goto(roomUrl);
    await carol.page.waitForURL(new RegExp(`#/match/${matchId1}$`), { timeout: 60_000 });
    await expect(carol.page.locator('[aria-label="Game board"]'), 'carol was carried to table 1, as a watcher').toBeVisible({ timeout: 30_000 });
    await expect(chatBoxOf(carol.page), 'carol’s chat panel is up on table 1’s board').toBeVisible({ timeout: 30_000 });
    await expect(carol.page.getByTestId('board-strip'), 'no strip over the board (the operator, 2026-10-19)').toHaveCount(0);

    // Back in the room by choice (in-page, as a link would): she stays there, with the way back in.
    // The operator, 2026-10-19: "the initial force into the game should only happen once".
    await carol.page.evaluate((hash) => (window.location.hash = hash), `#/room/${roomId}`);
    await expect(carol.page.getByTestId('room-match-link'), 'the room offers the game it is playing').toBeVisible({ timeout: 15_000 });
    await expect(carol.page.getByTestId('room-match-link')).toHaveText('Watch');
    await carol.page.waitForTimeout(2_000);
    expect(carol.page.url(), 'not carried back into the game').toMatch(new RegExp(`#/room/${roomId}$`));

    // Table 2's board, by its own link.
    const toTable2 = Date.now();
    await carol.page.evaluate((hash) => (window.location.hash = hash), `#/match/${matchId2}`);
    await expect(carol.page.locator('[aria-label="Game board"]'), 'carol’s board is now table 2’s').toBeVisible({ timeout: 15_000 });
    console.log(`[w71-switch-ms] ${Date.now() - toTable2}`);
    // Switching away from table 1 did not touch alice's own game.
    await expect(alice.page.locator('[aria-label="Game board"]'), 'alice’s own board is untouched by carol’s switch').toBeVisible();

    // ── the game's chat is apart from the lobby's: one per table ────────
    // The operator, 2026-10-19: "can we make sure the game-chat is seperate from the lobby chat?"
    // See the header: watchparty's own debug log is read, not the wire.
    const wanted = [`cardtable-${roomId}-${table1}`, `cardtable-${roomId}`, `cardtable-${roomId}-${table2}`];
    await expect.poll(() => wanted.every((k) => roomChromeJoins.includes(k)), { timeout: 15_000, message: `carol’s chat joins: ${JSON.stringify(roomChromeJoins)}` }).toBe(true);
    console.log(`[w71-boards] carol’s RoomChrome join log: ${JSON.stringify(roomChromeJoins)}`);
  } finally {
    await stack.stop();
  }
});
