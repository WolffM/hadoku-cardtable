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
 * Ruling 9 (2026-10-21): a deck choice is its chooser's alone until its game is over. While game 1
 * is played alice is told her own deck and not the AI's, by the Gauntlet and by the match; nothing
 * is played yet. She concedes, and the result's Next game takes her back to the room, where the
 * Gauntlet is choosing game 2 with game 1's two decks on record and played.
 *
 * Ruling 13 (2026-10-21): she chooses game 2 on the room's own screen, and every frame from that
 * press to the board shows the Gauntlet, never the lobby. She concedes again, the AI takes the
 * Gauntlet 2–0, and the result offers no Rematch. Back in the room the games are stacked top to
 * bottom, the table is unlocked, she stands up, and the mode is hers to change.
 *
 * `[cm-gauntlet]` lines are the evidence. Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';

import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';

async function send<T>(request: APIRequestContext, origin: string, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = method === 'GET' ? await request.get(`${origin}${PREFIX}/api${path}`) : await request.post(`${origin}${PREFIX}/api${path}`, { data: data ?? {} });
  return { status: res.status(), body: (await res.json()) as T };
}

test(titled('a Gauntlet vs the AI to its end: the draw, the snake, both choices hidden, Next game back to choose game 2, straight from the choice into the board, no Rematch once decided, the games stacked, and the room free again'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
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
    expect(chosen.body.games, 'her own deck, and not the AI’s').toEqual([{ decks: [mine.id, null], winner: null }]);
    expect(chosen.body.decks.filter((d) => d.played), 'nothing is played until its game is over').toEqual([]);
    console.log(`[cm-gauntlet] game 1: ${mine.id} vs (hidden)`);

    const table = await api<{ you: { deck: { name: string } | null } }>('GET', `/tables/rooms/${roomId}`);
    expect(JSON.stringify(table.body)).toContain(mine.name);

    const started = await api<{ matchId: string }>('POST', '/play/matches', { room: roomId, bot: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    await alice.page.goto(`${stack.origin}${PREFIX}/#/match/${started.body.matchId}`);
    await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
    console.log(`[cm-gauntlet] match ${started.body.matchId} up`);

    const match = await api<{ seats: { kind: string; deck: string | null }[] }>('GET', `/play/matches/${started.body.matchId}`);
    expect(match.body.seats.map((seat) => seat.kind)).toEqual(['human', 'ai']);
    expect(match.body.seats[0]!.deck, 'the match names her own deck').not.toBeNull();
    expect(match.body.seats[1]!.deck, 'and not the AI’s').toBeNull();

    await alice.page.getByTestId('live-concede').click();
    await alice.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });
    const next = alice.page.getByTestId('game-result-rematch');
    await expect(next).toHaveText('Next game', { timeout: 15_000 });
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(() => new URL(alice.page.url()).hash, { message: 'Next game goes back to the room' }).toBe(`#/room/${roomId}`);

    v = await view();
    const theirs = v.games[0]?.decks[1] ?? null;
    console.log(`[cm-gauntlet] game 2 choose: phase=${v.phase} game1=${JSON.stringify(v.games[0])} played=${v.decks.filter((d) => d.played).map((d) => d.id).join(',')}`);
    expect(v.phase).toBe('choose');
    expect(v.games).toEqual([{ decks: [mine.id, theirs], winner: 1 }]);
    expect(theirs, 'game 1 over: the AI’s deck is on record').not.toBeNull();
    expect(v.decks.filter((d) => d.played).map((d) => d.id).sort(), 'both played decks are greyed').toEqual([mine.id, theirs!].sort());
    const after = await api<{ seats: { deck: string | null }[] }>('GET', `/play/matches/${started.body.matchId}`);
    expect(after.body.seats.every((seat) => seat.deck !== null), 'the finished match names both decks').toBe(true);
    const live = await api<{ room: { matchId: string | null; phase: string } }>('GET', `/tables/rooms/${roomId}`);
    expect(live.body.room, 'Next game started nothing').toMatchObject({ matchId: null, phase: 'between' });

    // The room's choose screen for game 2: both played decks greyed, her other two pressable, the AI's other two shown as available.
    const choosing = alice.page.getByTestId('gauntlet-choose');
    await expect(choosing).toBeVisible({ timeout: 15_000 });
    await expect(alice.page.getByTestId('gauntlet-title')).toContainText('Game 2');
    const mineSide = alice.page.getByTestId('gauntlet-choose-mine');
    const theirSide = alice.page.getByTestId('gauntlet-choose-theirs');
    await expect(mineSide.locator(`[data-deck-id="${mine.id}"]`)).toHaveAttribute('data-played', 'true');
    await expect(theirSide.locator(`[data-deck-id="${theirs!}"]`)).toHaveAttribute('data-played', 'true');
    await expect(mineSide.locator('[data-testid="gauntlet-deck"]:not([data-played])')).toHaveCount(2);
    for (const tile of await mineSide.locator('[data-testid="gauntlet-deck"]:not([data-played])').all()) await expect(tile).toBeEnabled();
    await expect(theirSide.locator('[data-testid="gauntlet-deck"]:not([data-played])')).toHaveCount(2);
    await expect(theirSide.locator('[aria-checked="true"]'), 'no deck of theirs is shown as chosen').toHaveCount(0);
    console.log(`[cm-gauntlet] game 2 choose screen: played greyed mine=${mine.id} theirs=${theirs!}`);

    // Ruling 13.2: from the choice straight into the game. Every painted frame from the press to the
    // board is sampled: what the room's main shows, and whether the Gauntlet's own screen is in it.
    await alice.page.evaluate(() => {
      const w = window as unknown as { __frames: [number, string][]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      let last = '';
      const tick = (): void => {
        const has = (sel: string): boolean => document.querySelector(sel) !== null;
        const sig = [
          location.hash.split('/')[1] ?? '',
          has('[data-testid="room-players"]') ? 'seats' : '',
          document.querySelector('section.gauntlet')?.getAttribute('data-testid') ?? '',
          has('[aria-label="Game board"]') ? 'board' : '',
        ].join('|');
        if (sig !== last) w.__frames.push([Math.round(performance.now()), sig]);
        last = sig;
        if (!w.__stop) requestAnimationFrame(tick);
      };
      tick();
    });
    const second = mineSide.locator('[data-testid="gauntlet-deck"]:not([data-played])').first();
    const secondId = await second.getAttribute('data-deck-id');
    await second.click();
    await expect(alice.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
    const frames = await alice.page.evaluate(() => {
      const w = window as unknown as { __frames: [number, string][]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });
    console.log(`[cm-gauntlet] choose→board frames: ${JSON.stringify(frames)}`);
    // A room frame is the seats with no Gauntlet screen under them: the lobby, between the choice and the board.
    const lobbyFrames = frames.filter(([, sig]) => {
      const [route, seats, gauntletScreen] = sig.split('|');
      return route === 'room' && seats === 'seats' && gauntletScreen === '';
    });
    expect(lobbyFrames, 'no lobby frame between the choice and the board').toEqual([]);
    console.log(`[cm-gauntlet] game 2: ${secondId} vs (hidden)`);

    // Game 2 conceded too: the AI wins the Gauntlet 2–0.
    await alice.page.getByTestId('live-concede').click();
    await alice.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });
    await expect.poll(async () => (await view()).phase, { timeout: 15_000, message: 'the Gauntlet is decided' }).toBe('done');
    // Ruling 13.1: a decided Gauntlet offers no Rematch; Back to room is the way on.
    await expect(alice.page.getByTestId('game-result-room')).toBeEnabled({ timeout: 15_000 });
    await expect(alice.page.getByTestId('game-result-rematch'), 'no Rematch once the Gauntlet is decided').toHaveCount(0);
    await alice.page.getByTestId('game-result-room').click();
    await expect.poll(() => new URL(alice.page.url()).hash).toBe(`#/room/${roomId}`);

    // Ruling 13.3: the games stack top to bottom, and three of them fit 1280×800 with the room above
    // them: the third is projected one row below the second. At 125% the room's own options row and
    // seats wrap to two lines each above the result, and that alone puts a third game past 800px:
    // measured and logged there, asserted where the room above fits its own rows.
    await expect(alice.page.getByTestId('gauntlet-result')).toBeVisible({ timeout: 15_000 });
    await resizeWindow(alice.page, { width: 1280, height: 800 });
    const games = alice.page.getByTestId('gauntlet-result').getByTestId('gauntlet-game');
    await expect(games).toHaveCount(2);
    for (const scale of ['0.8', '1', '1.25']) {
      await alice.page.evaluate((v) => document.documentElement.style.setProperty('--ui-scale', v), scale);
      const [g1, g2] = [(await games.nth(0).boundingBox())!, (await games.nth(1).boundingBox())!];
      expect(g2.y, `game 2 below game 1 at ${scale}`).toBeGreaterThanOrEqual(g1.y + g1.height);
      const third = g2.y + g2.height + (g2.y - g1.y);
      const page = await alice.page.evaluate(() => ({ height: innerHeight, scrollW: document.documentElement.scrollWidth, width: innerWidth }));
      console.log(`[cm-gauntlet] result at ${scale}: games ${JSON.stringify([g1, g2])} third ends ${third} of ${page.height}`);
      if (scale !== '1.25') expect(third, `three games fit 800px at ${scale}`).toBeLessThanOrEqual(page.height);
      expect(page.scrollW, `no sideways scroll at ${scale}`).toBeLessThanOrEqual(page.width);
    }
    await alice.page.evaluate(() => document.documentElement.style.removeProperty('--ui-scale'));

    // Ruling 13.4: the room is free again — not locked, the mode the leader's to change, and the seat hers to give back.
    const done = await api<{ room: { locked: boolean; matchId: string | null } }>('GET', `/tables/rooms/${roomId}`);
    expect(done.body.room, 'a decided Gauntlet leaves the table unlocked').toMatchObject({ locked: false, matchId: null });
    await expect(alice.page.getByTestId('constructed-mode-classic')).toBeEnabled();
    await alice.page.getByTestId('seat-stand').click();
    await expect(alice.page.getByTestId('room-seat-0-empty')).toBeVisible({ timeout: 10_000 });
    await expect(alice.page.getByTestId('table-error')).toHaveCount(0);
    await alice.page.getByTestId('constructed-mode-classic').click();
    await expect(alice.page.getByTestId('constructed-mode-classic')).toBeChecked({ timeout: 10_000 });
    console.log('[cm-gauntlet] after done: stood up, mode changed to Classic');
  } finally {
    await alice.context.close();
    await stack.stop();
  }
});
