/**
 * A tournament's table page and hub, as the operator found them in a Gauntlet tournament vs an AI
 * (2026-10-23):
 * - *"why is this not showing the AIs name and avatar anymore? it was showing in the lobby"*: the AI
 *   entrant is named on the table page and in the hub's bracket as it was in the lobby's seat;
 * - *"'Round 1 of 3' it's not obvious that clicking this would take you back to the lobby"*: the
 *   round is a heading, and Back to lobby is its own button beside it;
 * - *"the box with the ready button in it looks awkward, can we instead retain the logic of the
 *   ready button from the lobby?"*: the table's start waits on the lobby's own Ready, beside the
 *   table's seats, and pressing it starts the draw.
 *
 * One browser, one AI entrant: a 2-entrant field, one round. Needs a Forge build (the Gauntlet's eras
 * come from its decks); without one the test SKIPS with a title that says why.
 */

import { expect, test } from '@playwright/test';

import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;

test(titled('a tournament table page names its AI, heads with its round beside Back to lobby, and starts on the lobby’s Ready'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const api = async <T>(method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<{ status: number; body: T }> => {
      const res = await alice.context.request.fetch(`${stack.origin}${PREFIX}/api${path}`, { method, data: data ?? {} });
      return { status: res.status(), body: (await res.json()) as T };
    };
    const created = await api<{ id: string }>('POST', '/rooms', { name: `e2e tournament table page ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    expect((await api('PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } })).status).toBe(200);
    expect((await api('POST', `/rooms/${roomId}/pod/sit`, { seat: 0 })).status).toBe(200);
    expect((await api('POST', `/rooms/${roomId}/pod/ai`, { seat: 1, on: true })).status).toBe(200);

    // The lobby's own AI seat: its name, as the lobby draws it.
    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    const aiSeat = alice.page.getByTestId('pod-seat-1');
    await expect(aiSeat, 'the lobby seats the AI').toHaveAttribute('data-ai', '', { timeout: UI_TIMEOUT });
    const aiName = ((await aiSeat.locator('.pod-seats__label').textContent()) ?? '').trim();
    console.log(`[tournament-table-page] lobby AI seat: ${aiName}`);
    expect(aiName, 'the AI seat has a character’s name').not.toMatch(/^(AI|)$/);

    // My Ready locks the field: carried to my round's table page.
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('table-page'), 'paired: carried to my table').toBeVisible({ timeout: UI_TIMEOUT });

    const labels = await alice.page.getByTestId('table-seats').locator('.pod-seats__label').allTextContents();
    console.log(`[tournament-table-page] table seats: ${JSON.stringify(labels)}`);
    expect(labels.map((l) => l.trim()), 'the table names the AI as the lobby did').toContain(aiName);

    const back = alice.page.getByTestId('table-hub');
    await expect(back).toHaveText('Back to lobby');
    await expect(alice.page.getByTestId('table-round'), 'the round is a heading of its own').toHaveText('Round 1 of 1');
    expect(await back.locator('[data-testid="table-round"]').count(), 'the heading is not part of the button').toBe(0);

    // The start waits on the lobby's own Ready, beside the seats: no box of its own.
    await expect(alice.page.getByTestId('tournament-gauntlet'), 'no Gauntlet box before the draw').toHaveCount(0);
    await expect(alice.page.getByTestId('table-seat-0-ready'), 'my seat is not ready yet').toHaveAttribute('data-state', 'no');
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('tournament-gauntlet'), 'Ready draws the Gauntlet').toBeVisible({ timeout: UI_TIMEOUT });

    // The hub's bracket names the AI too.
    await back.click();
    await expect(alice.page.getByTestId('pod-tables')).toBeVisible({ timeout: UI_TIMEOUT });
    const bracket = (await alice.page.getByTestId('pod-tables-row').first().textContent()) ?? '';
    console.log(`[tournament-table-page] bracket: ${bracket}`);
    expect(bracket, 'the bracket names the AI').toContain(aiName);
  } finally {
    await alice.context.close();
    await stack.stop();
  }
});
