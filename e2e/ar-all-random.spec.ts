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
