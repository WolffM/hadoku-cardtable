/**
 * The operator, 2026-10-21: *"if a match was not brought to victory/defeat then
 * it was not finished."* A concede is a defeat, so it counts.
 *
 * Alice plays the AI in an All Random room (no deck to load). Mid-game she
 * leaves the room and closes the board. Nothing ends the game for her: Forge
 * declares no winner, the server stops the match once nobody has come back
 * (`match-not-rejoined`, the 5 s departure grace plus the 5 min rejoin grace),
 * and neither a game report nor a series game is recorded. Then, in a second
 * room, she concedes: Forge calls it, the AI's seat wins the series game, and
 * a report is built (`stats-disabled` is the reporter's word for "handed a
 * report", since this stack has no stats key).
 *
 * `[un]` lines are the evidence: the server's own rows for each match.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, says, serverLog } from './play/board.ts';
import { answerConfirm } from './play/confirm.ts';
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

/** Every server row about one match, by `evt` (play, tables, stats) or `event` (the lobby). */
function rowsOf(stack: PlayStack, matchId: string): Record<string, unknown>[] {
  return serverLog(stack).filter((r) => r.matchId === matchId);
}

const evts = (rows: Record<string, unknown>[]): string[] => rows.map((r) => String(r.evt ?? r.event));

/** The rows worth reading in the evidence: not the per-frame and per-press traffic. */
const story = (rows: Record<string, unknown>[]): string[] => evts(rows).filter((e) => !/frame|command|client|button|passed|withheld|forwarded|offered|decided/.test(e));

/** A room of one, seated, playing the AI on a running board. */
async function againstTheAi(page: Page, stack: PlayStack, name: string): Promise<{ roomId: string; matchId: string }> {
  const api = `${stack.origin}${PREFIX}/api`;
  await page.goto(`${stack.origin}${PREFIX}/`);
  const made = await sendJson(page, 'POST', `${api}/rooms`, { name: `${name} ${Date.now()}`, mode: 'random', modeOptions: { pool: 'modern' } });
  expect(made.status, `creating the room: ${JSON.stringify(made.body)}`).toBe(201);
  const roomId = made.body.id as string;
  expect((await sendJson(page, 'POST', `${api}/tables/rooms/${roomId}/sit`, {})).status).toBe(200);
  const started = await sendJson(page, 'POST', `${api}/play/matches`, { room: roomId, bot: true });
  expect(started.status, `starting against the AI: ${JSON.stringify(started.body)}`).toBe(201);
  const matchId = started.body.matchId as string;
  await page.goto(`${stack.origin}${PREFIX}/#/match/${matchId}`);
  await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
  // Past the toss and the keep, into turn 1: a game under way, not one still being dealt.
  await expect
    .poll(
      async () => {
        const turn = (await page.getByTestId('live-turn-n').textContent()) ?? '';
        if (/^\d+$/.test(turn)) return turn;
        const choose = page.getByTestId('live-play-or-draw-play');
        if (await choose.isVisible()) await choose.click({ timeout: 2_000 });
        else if (/keep your hand/i.test(await says(page))) await answerConfirm(page, 'yes');
        return turn;
      },
      { message: 'the game reaches turn 1', timeout: 90_000, intervals: [500] },
    )
    .toMatch(/^\d+$/);
  return { roomId, matchId };
}

test(titled('a game the player walked away from is not finished: no report, no series game; a concede still records the loss'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(10 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const api = `${stack.origin}${PREFIX}/api`;

    // ── She leaves mid-game ──
    const left = await againstTheAi(alice.page, stack, 'e2e walked away');
    console.log(`[un] leaving ${left.matchId} on turn ${await alice.page.getByTestId('live-turn-n').textContent()}`);
    const leave = await sendJson(alice.page, 'POST', `${api}/rooms/${left.roomId}/leave`, {});
    expect(leave.status, `leaving: ${JSON.stringify(leave.body)}`).toBe(200);
    await alice.page.goto('about:blank');
    await expect
      .poll(() => evts(rowsOf(stack, left.matchId)), { message: 'the server stops the match nobody came back to', timeout: 7 * 60_000, intervals: [5_000] })
      .toContain('match-not-rejoined');
    await alice.page.waitForTimeout(2_000);
    const walked = rowsOf(stack, left.matchId);
    console.log(`[un] walked away: ${JSON.stringify(story(walked))}`);
    expect(evts(walked), 'Forge declared no winner').not.toContain('game-over');
    expect(evts(walked), 'the table records no game').not.toContain('table-game-over');
    expect(evts(walked), 'the lobby records no game').not.toContain('table-game-recorded');
    expect(evts(serverLog(stack)), 'no game report was built').not.toContain('stats-disabled');

    // ── She concedes ──
    const conceded = await againstTheAi(alice.page, stack, 'e2e conceded');
    await alice.page.getByTestId('live-concede').click();
    await alice.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => evts(rowsOf(stack, conceded.matchId)), { timeout: 15_000 }).toContain('table-game-over');
    const rows = rowsOf(stack, conceded.matchId);
    console.log(`[un] conceded: ${JSON.stringify(story(rows))} ${JSON.stringify(rows.find((r) => r.evt === 'table-game-over'))}`);
    expect(rows.find((r) => r.evt === 'table-game-over')?.winner, 'the AI seat won the game she conceded').toBe(1);
    await expect.poll(() => evts(serverLog(stack)), { message: 'a game report was built', timeout: 10_000 }).toContain('stats-disabled');
  } finally {
    await stack.stop();
  }
});
