/**
 * Lane testing-tourney — the operator, 2026-10-23: "i also need some rooms
 * that have tournaments and games in progress so i can validate the ui and
 * game actions better." This is the one end-to-end path through the room and
 * the UI for "Testing: Gauntlet tournament — round 2"
 * (`room/testing-rooms.ts`): an admin opens it from the front page's Testing
 * section, sees round 1 already decided (standings for all three entrants,
 * round 1's own bracket card past), sits in round 2's freed seat, readies
 * against the tournament AI, bans/picks and chooses, and lands in a REAL
 * Forge match. The ban/pick/choose mechanics are driven through the admin's
 * own authenticated API calls — the same technique
 * `e2e/tournament-gauntlet.spec.ts` uses to prove the Gauntlet contract
 * against real Forge — because this spec's own job is the room/seat wiring
 * around a seeded tournament, not a second proof of the Gauntlet screens.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';
import type { PodView } from '../packages/shared/src/pod.ts';

import { PREFIX } from './identities.ts';
import { roomIdFromHash } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const ROOM_NAME = 'Testing: Gauntlet tournament — round 2';

async function send<T>(request: APIRequestContext, origin: string, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = method === 'GET' ? await request.get(`${origin}${PREFIX}/api${path}`) : await request.post(`${origin}${PREFIX}/api${path}`, { data: data ?? {} });
  return { status: res.status(), body: (await res.json()) as T };
}

test(forge.ok ? 'an admin opens the seeded Gauntlet round-2 room, sees round 1 decided, plays round 2 and lands in a real match' : `SKIPPED: ${forge.reason}`, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);

  const stack = await startPlayStack(forge);
  const admin = await openFriend(browser, 'admin');
  try {
    const api = <T>(method: 'GET' | 'POST', path: string, data?: unknown) => send<T>(admin.context.request, stack.origin, method, path, data);

    /* ── front page: the room is admin-only and already seeded ── */
    await admin.page.goto(`${stack.origin}${PREFIX}/`);
    const row = admin.page.getByTestId('room-row').filter({ has: admin.page.getByTestId('room-name').getByText(ROOM_NAME, { exact: true }) });
    await expect(row, 'the Testing section lists the Gauntlet round-2 room for an admin').toBeVisible({ timeout: 15_000 });
    await row.getByTestId('room-enter').click();
    await admin.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 15_000 });
    const roomId = await roomIdFromHash(admin.page);

    /* ── the hub: round 1 already decided, standings for all three entrants ── */
    await expect(admin.page.getByTestId('pod-rounds'), 'round 2 is the live round; the hub is up').toBeVisible({ timeout: 15_000 });
    await expect(admin.page.getByTestId('pod-round')).toHaveText('Round 2 of 2');
    await expect(admin.page.locator('[data-testid="pod-bracket-round"][data-state="past"]'), 'round 1 is past, with its own result').toBeVisible({ timeout: 15_000 });
    await expect(admin.page.getByTestId(/^pod-standings-row-\d+$/), 'the seed and both AI entrants are ranked').toHaveCount(3);
    console.log(`[tr-tourney-round2] room ${roomId}: round 1 past, standings for 3`);

    /* ── round 2's own table: the seed has already left it, open for a real admin ── */
    const view = await api<{ pod: PodView; tables: { id: string; players: { memberId: string }[] }[] }>('GET', `/rooms/${roomId}`);
    expect(view.body.pod.round, 'round 2 is open').toBe(2);
    expect(view.body.pod.pairings, 'one live pairing').toHaveLength(1);
    const tableId = view.body.pod.pairings[0]!.tableId;
    expect(view.body.tables.find((t) => t.id === tableId)?.players ?? [], 'the seed’s seat is free').toHaveLength(0);

    const sat = await api('POST', `/tables/rooms/${roomId}/sit`, { table: tableId });
    expect(sat.status, JSON.stringify(sat.body)).toBe(200);

    const gauntletView = (tableId: string) => api<GauntletView>('GET', `/tables/rooms/${roomId}/gauntlet?table=${tableId}`);
    const ready = await api<GauntletView>('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: tableId });
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    console.log(`[tr-tourney-round2] readied: phase=${ready.body.phase} era=${ready.body.era?.title}`);
    expect(ready.body.phase, 'ready against the tournament AI draws at once — no second human to wait on').toBe('reveal');

    /* ── bans and picks against the tournament AI, same snake `tournament-gauntlet.spec.ts` drives ── */
    await expect
      .poll(
        async () => {
          const v = (await gauntletView(tableId)).body;
          if (v.phase !== 'banpick') return v.phase;
          if (v.step!.seat === 0) {
            const deck = v.decks.find((d) => d.status === 'open')!.id;
            expect((await api('POST', `/tables/rooms/${roomId}/gauntlet/act`, { act: v.step!.act, deck, table: tableId })).status).toBe(200);
          }
          return v.phase;
        },
        { timeout: 60_000, intervals: [250], message: `${tableId}: the snake runs to its end` },
      )
      .toBe('choose');

    const mine = (await gauntletView(tableId)).body.decks.find((d) => d.status === 'picked' && d.by === 0)!.id;
    expect((await api('POST', `/tables/rooms/${roomId}/gauntlet/choose`, { deck: mine, table: tableId })).status).toBe(200);
    await expect.poll(async () => (await gauntletView(tableId)).body.phase, { timeout: 30_000, message: 'the AI’s own choice deals the game' }).toBe('playing');

    /* ── the table's own page follows the dealt game into a real Forge match ── */
    await admin.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}/table/${tableId}`);
    await admin.page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 30_000 });
    await expect(admin.page.locator('[aria-label="Game board"]'), 'the admin is in a real match, playing round 2').toBeVisible({ timeout: 30_000 });
  } finally {
    await admin.context.close();
    await stack.stop();
  }
});
