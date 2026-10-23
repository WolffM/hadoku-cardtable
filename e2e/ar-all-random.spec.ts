/**
 * All Random (the operator's ruling 3 and 4, 2026-10-21): a random era of the
 * room's pool, a DIFFERENT deck from it for each seat, and straight into the
 * game — no picking, no reveal. Against the AI (ruling 7) the AI's deck is
 * the second of the two.
 *
 * Alice makes an All Random Modern room, sits, and starts against the AI
 * without loading a deck. The match comes up on her board, and the server's
 * own deal (`room-random-dealt`) names one Modern era and two different
 * library decks that the catalog (`GET /api/tables/decks`) places in it.
 *
 * The room is made and the start asked through the API, the routes the room
 * screen calls, so this proves the server's deal on its own; the screen's mode
 * radio and options row have their own spec.
 *
 * `[ar]` lines are the evidence: the deal and the match it started.
 */
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';

const PREFIX = '/cardtable';
const forge = forgeAvailability();
const titled = makeTitled(forge);

async function sendJson(page: Page, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : { text } };
    },
    { method, url, body },
  );
}

/** The server's log rows of one event. */
function rows(stack: PlayStack, evt: string): Record<string, unknown>[] {
  return readFileSync(stack.serverLogFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`"evt":"${evt}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test(titled('All Random Modern against the AI deals two different decks of one Modern era and starts the match'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const api = `${stack.origin}${PREFIX}/api`;

    const made = await sendJson(alice.page, 'POST', `${api}/rooms`, { name: `e2e all random ${Date.now()}`, mode: 'random', modeOptions: { pool: 'modern' } });
    expect(made.status, `creating the room: ${JSON.stringify(made.body)}`).toBe(201);
    const roomId = made.body.id as string;
    const sat = await sendJson(alice.page, 'POST', `${api}/tables/rooms/${roomId}/sit`, {});
    expect(sat.status, `sitting: ${JSON.stringify(sat.body)}`).toBe(200);

    const started = await sendJson(alice.page, 'POST', `${api}/play/matches`, { room: roomId, bot: true });
    expect(started.status, `starting against the AI with no deck loaded: ${JSON.stringify(started.body)}`).toBe(201);
    const matchId = started.body.matchId as string;
    await alice.page.goto(`${stack.origin}${PREFIX}/#/match/${matchId}`);
    await expect(alice.page.locator('[aria-label="Game board"]'), "alice's board came up").toBeVisible({ timeout: 60_000 });

    const deal = rows(stack, 'room-random-dealt').find((r) => r.room === roomId);
    const start = rows(stack, 'room-match-started').find((r) => r.matchId === matchId);
    console.log(`[ar] deal ${JSON.stringify(deal)}`);
    console.log(`[ar] start ${JSON.stringify(start)}`);
    expect(deal, 'the server dealt the table').toBeDefined();
    expect(deal!.pool).toBe('modern');
    expect(deal!.opponent).toBe('ai');
    const [a, b] = deal!.decks as string[];
    expect(a, 'two different decks').not.toBe(b);

    const catalog = await sendJson(alice.page, 'GET', `${api}/tables/decks`);
    const byId = new Map((catalog.body.decks as { id: string; era: string; name: string }[]).map((d) => [d.id, d]));
    expect([byId.get(a!)?.era, byId.get(b!)?.era], 'both decks are of the dealt era').toEqual([deal!.era, deal!.era]);
    expect(String(deal!.era)).toMatch(/^modern-/);
    expect(start?.opponent).toBe('ai');
    // The start names the human seats' decks; the AI's is the deal's second (`tables.test.ts` reads it off the spec).
    expect(start?.decks, 'alice plays the first dealt deck').toEqual([byId.get(a!)?.name]);
  } finally {
    await stack.stop();
  }
});

/**
 * The operator, 2026-10-23: *"if rematch is clicked we go to sideboarding then the next game with the same
 * deck. re-randomize should only be considered when back in the lobby and a game is not inprogres anymore"*.
 * Alice, against the AI in an unlocked All Random room, concedes game 1 and presses Rematch: the sideboard
 * step, and game 2 of the series plays the same two decks: the server deals once, and the AI's deck hash holds.
 */
test(titled('All Random against the AI: a Rematch sideboards and game 2 plays the same two decks'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const api = `${stack.origin}${PREFIX}/api`;
    const made = await sendJson(alice.page, 'POST', `${api}/rooms`, { name: `e2e all random rematch ${Date.now()}`, mode: 'random', modeOptions: { pool: 'modern' } });
    expect(made.status, `creating the room: ${JSON.stringify(made.body)}`).toBe(201);
    const roomId = made.body.id as string;
    expect((await sendJson(alice.page, 'POST', `${api}/tables/rooms/${roomId}/sit`, {})).status).toBe(200);
    const started = await sendJson(alice.page, 'POST', `${api}/play/matches`, { room: roomId, bot: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const game1 = started.body.matchId as string;
    await alice.page.goto(`${stack.origin}${PREFIX}/#/match/${game1}`);
    await expect(alice.page.locator('[aria-label="Game board"]'), 'game 1').toBeVisible({ timeout: 60_000 });

    await alice.page.getByTestId('live-concede').click();
    await alice.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });
    await alice.page.getByTestId('game-result-rematch').click();
    await alice.page.getByTestId('game-result-next').click({ timeout: 30_000 });
    await alice.page.getByTestId('sideboard-ready').click({ timeout: 30_000 });
    await expect
      .poll(() => rows(stack, 'room-match-started').filter((r) => r.room === roomId).length, { timeout: 60_000, message: 'game 2 starts' })
      .toBe(2);
    const [first, second] = rows(stack, 'room-match-started').filter((r) => r.room === roomId);
    console.log(`[ar] rematch starts ${JSON.stringify([first, second])}`);
    console.log(`[ar] deals ${JSON.stringify(rows(stack, 'room-random-dealt').filter((r) => r.room === roomId))}`);
    expect(second!.matchId).not.toBe(game1);
    expect(rows(stack, 'room-random-dealt').filter((r) => r.room === roomId), 'one deal for the series').toHaveLength(1);
    // Alice's game 2 is her sideboard step's re-submission of the same 75 (a hold the server takes in
    // sideboarding only when it is the series' own cards, `sideboardIssue`), so its text is hers, not the deal's.
    expect(second!.botDeck, 'the AI plays the same deck').toBe(first!.botDeck);
    expect(second!.decks, 'her sideboarded 75 keeps its name').toEqual(first!.decks);
  } finally {
    await stack.stop();
  }
});
