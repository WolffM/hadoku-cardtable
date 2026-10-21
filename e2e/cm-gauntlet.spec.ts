/**
 * A Gauntlet against the AI, from the room to game 1's board, against real Forge.
 *
 * The operator, 2026-10-21 (`docs/planning/constructed-modes-plan.md`): ten decks of one era are
 * revealed, the seats ban and pick in a snake, each secretly chooses an opening deck, and game 1
 * is a normal match with the two chosen decks. Ruling 7: the AI bans, picks and chooses at random.
 *
 * API-driven through alice's own identity, like `w71-bo3.spec.ts`: the Gauntlet screens are their
 * own lane's. Alice sits, readies against the AI, takes every step that is hers while the AI takes
 * its own, chooses her first pick, and starts the room's match the way the room screen does. The
 * match's board comes up, and the table holds the deck she chose.
 *
 * `[cm-gauntlet]` lines are the evidence. Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';

import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';

async function send<T>(request: APIRequestContext, origin: string, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = method === 'GET' ? await request.get(`${origin}${PREFIX}/api${path}`) : await request.post(`${origin}${PREFIX}/api${path}`, { data: data ?? {} });
  return { status: res.status(), body: (await res.json()) as T };
}

test(titled('a Gauntlet vs the AI: the draw, the snake with the AI taking its own steps, both choices, and game 1 starts with the chosen deck'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const api = <T>(method: 'GET' | 'POST', path: string, data?: unknown) => send<T>(alice.context.request, stack.origin, method, path, data);

    const created = await api<{ id: string }>('POST', '/rooms', {
      name: `e2e cm-gauntlet ${Date.now()}`,
      gameType: 'constructed-1v1',
      mode: 'gauntlet',
      modeOptions: { family: 'modern' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    expect((await api('POST', `/tables/rooms/${roomId}/sit`)).status).toBe(200);
    const ready = await api<GauntletView>('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, ai: true });
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body.phase).toBe('reveal');
    expect(ready.body.decks).toHaveLength(10);
    console.log(`[cm-gauntlet] drew ${ready.body.era?.title} first=${String(ready.body.first)} decks=${ready.body.decks.map((d) => d.id).join(',')}`);

    const view = async (): Promise<GauntletView> => (await api<GauntletView>('GET', `/tables/rooms/${roomId}/gauntlet`)).body;
    let v = await view();
    await expect.poll(async () => (v = await view()).phase, { timeout: 15_000, message: 'the reveal ends in the ban/pick' }).toBe('banpick');

    // Alice takes each step that is hers; the AI's own are taken a beat after they come.
    await expect
      .poll(
        async () => {
          v = await view();
          if (v.phase !== 'banpick') return v.phase;
          if (v.step!.seat === 0) {
            const deck = v.decks.find((d) => d.status === 'open')!.id;
            const acted = await api('POST', `/tables/rooms/${roomId}/gauntlet/act`, { act: v.step!.act, deck });
            expect(acted.status).toBe(200);
          }
          return v.phase;
        },
        { timeout: 60_000, intervals: [250], message: 'the snake runs to its end' },
      )
      .toBe('choose');
    expect(v.decks.filter((d) => d.status === 'banned')).toHaveLength(4);
    expect(v.decks.filter((d) => d.status === 'picked' && d.by === 1), 'the AI picked its three').toHaveLength(3);
    console.log(`[cm-gauntlet] snake done; banned=${v.decks.filter((d) => d.status === 'banned').length} ai-picks=${v.decks.filter((d) => d.by === 1 && d.status === 'picked').length}`);

    await expect.poll(async () => (v = await view()).choice?.chosen[1], { timeout: 10_000, message: 'the AI chooses its opening deck' }).toBe(true);
    const mine = v.decks.find((d) => d.status === 'picked' && d.by === 0)!;
    const chosen = await api<GauntletView>('POST', `/tables/rooms/${roomId}/gauntlet/choose`, { deck: mine.id });
    expect(chosen.body.phase).toBe('playing');
    expect(chosen.body.games).toHaveLength(1);
    expect(chosen.body.games[0]!.decks[0]).toBe(mine.id);
    console.log(`[cm-gauntlet] game 1: ${chosen.body.games[0]!.decks.join(' vs ')}`);

    const table = await api<{ you: { deck: { name: string } | null } }>('GET', `/tables/rooms/${roomId}`);
    expect(JSON.stringify(table.body)).toContain(mine.name);

    const started = await api<{ matchId: string }>('POST', '/play/matches', { room: roomId, bot: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    await alice.page.goto(`${stack.origin}${PREFIX}/#/match/${started.body.matchId}`);
    await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
    console.log(`[cm-gauntlet] match ${started.body.matchId} up`);
  } finally {
    await alice.context.close();
    await stack.stop();
  }
});
