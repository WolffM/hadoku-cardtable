/**
 * The operator, 2026-11-02: a game both players walked away from is kept for the rejoin grace, then
 * **parked** — its JVM stopped and the match let go of, its last turn-start snapshot kept on disk —
 * and *"resuming parked games, i would expect that to happen from a player's match history.
 * resuming then means creating a new room and reconstructing the game from snapshot."* A resumed
 * game played to the end counts like any finished game.
 *
 * Alice plays the AI in an All Random room, and closes the page once the game has a turn-start
 * snapshot. The server parks it (the 30 s departure grace, then a rejoin grace this stack shortens
 * to 20 s) and lets go of the match. From Your profile's Unfinished games she resumes it: a new
 * room, the board back at the start of the snapshot's turn. She concedes; Forge calls it, a report
 * is built (`stats-disabled` is the reporter's word for "handed a report" on a stack with no stats
 * key), and the game leaves her list.
 *
 * `[pk]` lines are the evidence: the server's own rows for each match.
 */
import { expect, test, type Page } from '@playwright/test';

import { livePrompt, makeTitled, serverLog } from './play/board.ts';
import { answerConfirm, confirmYes } from './play/confirm.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';

const PREFIX = '/cardtable';
const REJOIN_GRACE_MS = 20_000;
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

/** Every server row about one match, by `evt` (play, tables, parked) or `event` (the lobby). */
const rowsOf = (stack: PlayStack, matchId: string): Record<string, unknown>[] => serverLog(stack).filter((r) => r.matchId === matchId);
const evts = (rows: Record<string, unknown>[]): string[] => rows.map((r) => String(r.evt ?? r.event));
/** The rows worth reading in the evidence: not the per-frame and per-press traffic. */
const story = (rows: Record<string, unknown>[]): string[] => evts(rows).filter((e) => !/frame|command|client|button|passed|withheld|forwarded|offered|decided/.test(e));

/** Presses through the opening — play or draw, a keep, an opening-hand ask — until the board shows a turn. */
async function untilTurn(page: Page): Promise<string> {
  let shown = '';
  await expect
    .poll(
      async () => {
        shown = (await page.getByTestId('live-turn-n').textContent()) ?? '';
        if (/^\d+$/.test(shown)) return shown;
        const choose = page.getByTestId('live-play-or-draw-play');
        const submit = livePrompt(page).getByTestId('prompt-submit');
        if (await choose.isVisible()) await choose.click({ timeout: 2_000 });
        else if (await confirmYes(page).isVisible()) await answerConfirm(page, 'yes');
        else if (await submit.isVisible()) await submit.click({ timeout: 2_000 });
        return shown;
      },
      { message: 'the game reaches a turn', timeout: 90_000, intervals: [500] },
    )
    .toMatch(/^\d+$/);
  return shown;
}

test(titled('a game both players left is parked, resumed from Unfinished games at its turn’s start, and counted once it is finished'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge, { env: { CARDTABLE_PLAY_REJOIN_GRACE_MS: String(REJOIN_GRACE_MS) } });
  try {
    const alice = await openFriend(browser, 'alice');
    const api = `${stack.origin}${PREFIX}/api`;

    // ── A game against the AI, under way ──
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const made = await sendJson(alice.page, 'POST', `${api}/rooms`, { name: `e2e parked ${Date.now()}`, mode: 'random', modeOptions: { pool: 'modern' } });
    expect(made.status, `creating the room: ${JSON.stringify(made.body)}`).toBe(201);
    const roomId = made.body.id as string;
    expect((await sendJson(alice.page, 'POST', `${api}/tables/rooms/${roomId}/sit`, {})).status).toBe(200);
    const started = await sendJson(alice.page, 'POST', `${api}/play/matches`, { room: roomId, bot: true });
    expect(started.status, `starting against the AI: ${JSON.stringify(started.body)}`).toBe(201);
    const first = started.body.matchId as string;
    await alice.page.goto(`${stack.origin}${PREFIX}/#/match/${first}`);
    await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
    await untilTurn(alice.page);
    await expect
      .poll(() => evts(rowsOf(stack, first)), { message: 'a turn-start snapshot to go back to', timeout: 60_000, intervals: [1_000] })
      .toContain('turn-snapshot');

    // ── She walks away: parked, and let go of ──
    await alice.page.goto('about:blank');
    await expect
      .poll(() => evts(rowsOf(stack, first)), { message: 'the game nobody came back to is parked', timeout: 30_000 + REJOIN_GRACE_MS + 60_000, intervals: [2_000] })
      .toContain('match-parked');
    const parked = rowsOf(stack, first).find((r) => r.evt === 'match-parked') as { turn: number };
    await expect.poll(() => evts(rowsOf(stack, first)), { message: 'the registry lets go of it', timeout: 10_000 }).toContain('match-freed');
    console.log(`[pk] parked: ${JSON.stringify(story(rowsOf(stack, first)))} at turn ${parked.turn}`);
    expect(evts(rowsOf(stack, first)), 'Forge declared no winner').not.toContain('game-over');

    // ── Resumed from her Unfinished games ──
    await alice.page.goto(`${stack.origin}${PREFIX}/#/profile`);
    const game = alice.page.getByTestId('unfinished-game');
    await expect(game).toHaveCount(1, { timeout: 30_000 });
    await expect(game).toContainText(`Turn ${parked.turn}`);
    await alice.page.getByTestId('unfinished-resume').click();
    await expect.poll(() => serverLog(stack).some((r) => r.evt === 'parked-resume' && r.matchId === first), { message: 'the game is resumed', timeout: 60_000 }).toBe(true);
    const resume = serverLog(stack).find((r) => r.evt === 'parked-resume' && r.matchId === first) as { as: string; room: string };
    expect(resume.room, 'a new room').not.toBe(roomId);
    // The room carries its seated player into the game.
    await expect
      .poll(
        async () => {
          if (await alice.page.locator('[aria-label="Game board"]').isVisible()) return true;
          const link = alice.page.getByTestId('room-match-link');
          if (await link.isVisible()) await link.click({ timeout: 2_000 });
          return false;
        },
        { message: 'the resumed board', timeout: 60_000, intervals: [500] },
      )
      .toBe(true);
    expect(alice.page.url(), 'on the resumed match').toContain(resume.as);
    await expect(alice.page.getByTestId('live-turn-n'), 'back at the start of the parked turn').toHaveText(String(parked.turn), { timeout: 60_000 });
    console.log(`[pk] resumed as ${resume.as} in ${resume.room}: ${JSON.stringify(story(rowsOf(stack, resume.as)))}`);

    // ── Played to the end: counted, and finished with ──
    await alice.page.getByTestId('live-concede').click();
    await alice.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => evts(rowsOf(stack, resume.as)), { timeout: 15_000 }).toContain('table-game-over');
    expect(rowsOf(stack, resume.as).find((r) => r.evt === 'table-game-over')?.winner, 'the AI seat won the game she conceded').toBe(1);
    await expect.poll(() => evts(serverLog(stack)), { message: 'a game report was built', timeout: 10_000 }).toContain('stats-disabled');
    expect(rowsOf(stack, resume.as).filter((r) => r.evt === 'stats-skipped'), 'the resumed game was reported, not skipped').toEqual([]);
    await expect.poll(() => evts(rowsOf(stack, first)), { message: 'the parked record is finished with', timeout: 10_000 }).toContain('parked-finished');
    expect((await sendJson(alice.page, 'GET', `${api}/play/parked`)).body.games, 'nothing left unfinished').toEqual([]);
  } finally {
    await stack.stop();
  }
});
