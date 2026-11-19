/**
 * Gauntlet in tournament mode, end to end, against the REAL built server and real Forge —
 * `docs/planning/tournament-mode-plan.md`'s ruling 6 and this lane's own Design.
 *
 * Alice, Bob, Carol and one AI entrant lock a Gauntlet tournament with Decks locked set, which a
 * Gauntlet ignores (the operator, 2026-10-23: *"let's just disable 'decks locked' for guantlet mode"*).
 * Round 1 (`roundsFor(4) === 2`) pairs humans first (AF627): alice-vs-carol, and bob, the human left
 * over, against the AI — two SIMULTANEOUS Gauntlet tables, each keyed by its own table id
 * (`room/lobby.ts`'s `gauntlets`, `http/gauntlet.ts`'s `?table=`/body `table`). Both tables draw, bank
 * and choose independently; acting on one table is proved to leave the other alone. Round 2 re-pairs
 * the field by score (alice, who won, meets bob) and draws its own decks and bans/picks them, as
 * round 1 did.
 *
 * API-driven through each human's own identity, the same way `e2e/cm-gauntlet.spec.ts`
 * drives a single Gauntlet: the Gauntlet screens are their own lane's, this proves the server
 * contract (`room/lobby.ts`, `room/gauntlet.ts`, `http/gauntlet.ts`) end to end against real
 * Forge matches.
 *
 * `[tournament-gauntlet]` lines are the evidence. Needs a Forge build; without one the test SKIPS
 * and its title says why.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';
import type { PodView } from '../packages/shared/src/pod.ts';

import { enterFromTablePage } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';

async function send<T>(request: APIRequestContext, origin: string, method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = method === 'GET' ? await request.get(`${origin}${PREFIX}/api${path}`) : await request.post(`${origin}${PREFIX}/api${path}`, { data: data ?? {} });
  return { status: res.status(), body: (await res.json()) as T };
}

test(
  titled(
    'two simultaneous Gauntlet tables of one round, each ban/pick/choose independently; round 2 draws fresh though Decks locked was set',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(10 * 60_000);
    const stack = await startPlayStack(forge);
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const carol = await openFriend(browser, 'carol');
    try {
      await alice.page.goto(`${stack.origin}${PREFIX}/`);
      const aliceApi = <T>(method: 'GET' | 'POST', path: string, data?: unknown) => send<T>(alice.context.request, stack.origin, method, path, data);
      await bob.page.goto(`${stack.origin}${PREFIX}/`);
      const bobApi = <T>(method: 'GET' | 'POST', path: string, data?: unknown) => send<T>(bob.context.request, stack.origin, method, path, data);
      await carol.page.goto(`${stack.origin}${PREFIX}/`);
      const carolApi = <T>(method: 'GET' | 'POST', path: string, data?: unknown) => send<T>(carol.context.request, stack.origin, method, path, data);

      const created = await aliceApi<{ id: string }>('POST', '/rooms', {
        name: `e2e tournament-gauntlet ${Date.now()}`,
        gameType: 'constructed-1v1',
        mode: 'gauntlet',
        modeOptions: { family: 'modern' },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const roomId = created.body.id;
      // A same-document hash navigation answers no Response of its own
      // (`tournament.spec.ts`'s own `openRoomWithLeader` never checks one
      // either) — the room's own screen coming up is the real proof.
      await bob.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
      await expect(bob.page.getByTestId('constructed')).toBeVisible({ timeout: 15_000 });
      // The page's own join is lazy — `ConstructedScreen.tsx`'s table-read effect
      // joins only after its first read 404s as a non-member, a race `bobApi`'s
      // own direct calls below must not depend on. Joined for real, right now.
      expect((await bobApi('POST', `/rooms/${roomId}/join`, {})).status).toBe(200);
      expect((await carolApi('POST', `/rooms/${roomId}/join`, {})).status).toBe(200);

      const patched = await alice.context.request.patch(`${stack.origin}${PREFIX}/api/rooms/${roomId}`, { data: { settings: { tournament: true, tournamentDecks: 'locked' } } });
      expect(patched.status(), await patched.text()).toBe(200);
      expect(((await patched.json()) as { settings: { tournamentDecks: string } }).settings.tournamentDecks, 'a Gauntlet tournament reads per-round').toBe('per-round');
      // Nor does its room offer the choice: its Match rules (a tournament's chess clock) hold no deck policy.
      await expect(bob.page.getByTestId('tournament-lobby')).toBeVisible({ timeout: 15_000 });
      await bob.page.getByTestId('match-rules').click();
      await expect(bob.page.getByTestId('match-rules-popover')).toBeVisible();
      await expect(bob.page.getByTestId('tournament-decks'), 'a Gauntlet tournament offers no Decks locked').toHaveCount(0);
      await bob.page.keyboard.press('Escape');
      await expect(bob.page.getByTestId('match-rules-popover')).toHaveCount(0);

      // Alice seat 0, Bob seat 1, Carol seat 2, the AI seat 3 — humans first (AF627, `@hadoku/draft`'s
      // `swissRound`): the humans pair among themselves by `round1`'s across-the-table formula
      // (alice-vs-carol), and bob, the one human left over, takes the AI. Two REAL tables, one of
      // each shape.
      expect((await aliceApi('POST', `/rooms/${roomId}/pod/sit`, { seat: 0 })).status).toBe(200);
      expect((await bobApi('POST', `/rooms/${roomId}/pod/sit`, { seat: 1 })).status).toBe(200);
      expect((await carolApi('POST', `/rooms/${roomId}/pod/sit`, { seat: 2 })).status).toBe(200);
      expect((await aliceApi('POST', `/rooms/${roomId}/pod/ai`, { seat: 3, on: true })).status).toBe(200);

      // Ready, for Gauntlet, is the room-level member ready — no deck to pick pre-lock (ruling 4).
      // Carol's own Ready is the last thing the field needs: it locks by itself (ruling 7).
      expect((await aliceApi('POST', `/rooms/${roomId}/ready`, { ready: true })).status).toBe(200);
      expect((await bobApi('POST', `/rooms/${roomId}/ready`, { ready: true })).status).toBe(200);
      const locked = await carolApi<{ game: { pod: PodView | null } }>('POST', `/rooms/${roomId}/ready`, { ready: true });
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
      const pod1 = locked.body.game.pod!;
      expect(pod1.phase, 'the field locked itself on Carol’s own Ready').toBe('rounds');
      expect(pod1.round).toBe(1);
      console.log(`[tournament-gauntlet] round 1 pairings: ${JSON.stringify(pod1.pairings)}`);

      // Resolve each human's own table the same way the UI's `myTournamentTable` would: whichever
      // of `view.tables` holds their own member id — never by the pairing's own entrant ids, which
      // are real member/AI ids, not these test's literal names.
      type RoomView = { tables: { id: string; players: { memberId: string }[] }[]; you: { id: string }; game: { pod: PodView } };
      const roomView = await aliceApi<RoomView>('GET', `/rooms/${roomId}`);
      const myAliceId = roomView.body.you.id;
      const bobView = await bobApi<RoomView>('GET', `/rooms/${roomId}`);
      const myBobId = bobView.body.you.id;
      const myCarolId = (await carolApi<RoomView>('GET', `/rooms/${roomId}`)).body.you.id;
      // An earlier round's table stays in `tables`; only the current pairings' tables count.
      const tableOf = (view: RoomView, memberId: string): string => {
        const current = new Set(view.game.pod.pairings.map((p) => p.tableId));
        return view.tables.find((t) => current.has(t.id) && t.players.some((p) => p.memberId === memberId))!.id;
      };
      const t1Alice = tableOf(roomView.body, myAliceId);
      const t1Bob = tableOf(bobView.body, myBobId);
      expect(t1Alice, 'two DIFFERENT tables, not the same one').not.toBe(t1Bob);
      expect(tableOf(roomView.body, myCarolId), 'carol is alice’s round-1 opponent, not bob’s').toBe(t1Alice);

      /** Reads `tableId`'s Gauntlet view as `api` sees it. */
      const view = async (api: typeof aliceApi, tableId: string): Promise<GauntletView> => (await api<GauntletView>('GET', `/tables/rooms/${roomId}/gauntlet?table=${tableId}`)).body;

      // Every human readies at their OWN table — alice and carol both at theirs; bob alone at his (the
      // pairing's other seat is AI, always ready, no `ai: true` needed).
      expect((await aliceApi('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: t1Alice })).status).toBe(200);
      expect((await carolApi('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: t1Alice })).status).toBe(200);
      expect((await bobApi('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: t1Bob })).status).toBe(200);

      let va = await view(aliceApi, t1Alice);
      let vb = await view(bobApi, t1Bob);
      expect(va.phase, 'alice’s table drew').toBe('reveal');
      expect(vb.phase, 'bob’s table drew — a SEPARATE draw, not alice’s').toBe('reveal');
      expect(va.decks.map((d) => d.id).join(), 'two independent draws').not.toBe(vb.decks.map((d) => d.id).join());
      console.log(`[tournament-gauntlet] alice@${t1Alice} era=${va.era?.title} bob@${t1Bob} era=${vb.era?.title}`);

      /** Each human's API at `tableId`, by their own seat there (`GauntletView.you`); a seat with none is the AI's. */
      const seatsAt = async (tableId: string, apis: (typeof aliceApi)[]): Promise<Map<number, typeof aliceApi>> => {
        const seats = new Map<number, typeof aliceApi>();
        for (const api of apis) {
          const you = (await view(api, tableId)).you;
          if (you !== null) seats.set(you, api);
        }
        return seats;
      };
      const t1AliceSeats = await seatsAt(t1Alice, [aliceApi, carolApi]);
      expect([...t1AliceSeats.keys()].sort(), 'alice and carol hold both seats of their table').toEqual([0, 1]);
      const t1BobSeats = await seatsAt(t1Bob, [bobApi]);

      /** Runs `tableId`'s banpick to `choose`, acting on each human's own turn and waiting out the AI's. */
      const runBanpick = async (tableId: string, seats: Map<number, typeof aliceApi>): Promise<GauntletView> => {
        const reader = [...seats.values()][0]!;
        let v: GauntletView;
        await expect
          .poll(
            async () => {
              v = await view(reader, tableId);
              if (v.phase !== 'banpick') return v.phase;
              const actor = seats.get(v.step!.seat);
              if (actor !== undefined) {
                const deck = v.decks.find((d) => d.status === 'open')!.id;
                expect((await actor('POST', `/tables/rooms/${roomId}/gauntlet/act`, { act: v.step!.act, deck, table: tableId })).status).toBe(200);
              }
              return v.phase;
            },
            { timeout: 60_000, intervals: [250], message: `${tableId}: the snake runs to its end` },
          )
          .toBe('choose');
        return v!;
      };

      va = await runBanpick(t1Alice, t1AliceSeats);
      vb = await runBanpick(t1Bob, t1BobSeats);
      expect(va.phase).toBe('choose');
      expect(vb.phase).toBe('choose');
      console.log('[tournament-gauntlet] both tables’ round-1 banpick done independently');

      // Each chooses, the game is dealt and conceded — fast, same move `e2e/w72-pod.spec.ts` uses.
      // Gauntlet is Bo3 with NO sideboarding (`room/series.ts`'s `GAUNTLET` format): conceding every
      // game loses it 0-2, so this plays exactly two, and `game-result-room` is the only button a POD
      // Gauntlet's result screen ever offers (its own "Next game" is hidden in a pod — `LiveBoard.tsx`'s
      // `nextInRoom ? !inPod : rematchable`) — back in the room, `gameOver`'s own `enterChoose` has
      // already put the table straight into `choose` for the next game, same as a non-pod Gauntlet.
      /** A human at a table: their API, their page, and their seat there. */
      type Seat = { api: typeof aliceApi; page: Player['page']; seat: number };
      const seated = (seats: Map<number, typeof aliceApi>, who: [typeof aliceApi, Player['page']][]): Seat[] =>
        [...seats.entries()].map(([seat, api]) => ({ api, seat, page: who.find(([a]) => a === api)![1] }));
      // Every human at the table chooses their own next pick (the AI chooses its own), the game is
      // dealt, every human enters it from the table's page by their own press, and `loser` concedes.
      const playOneGame = async (tableId: string, humans: Seat[], loser: Seat): Promise<void> => {
        for (const h of humans) {
          const mine = (await view(h.api, tableId)).decks.find((d) => d.status === 'picked' && d.by === h.seat && !d.played)!.id;
          expect((await h.api('POST', `/tables/rooms/${roomId}/gauntlet/choose`, { deck: mine, table: tableId })).status).toBe(200);
        }
        await expect.poll(async () => (await view(loser.api, tableId)).phase, { timeout: 30_000, message: `${tableId}: every choice in, the game is dealt` }).toBe('playing');
        // The table's own page offers its game: Enter game, each human's own press.
        for (const h of humans) {
          await h.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}/table/${tableId}`);
          await enterFromTablePage(h.page, /#\/match\/m-[0-9a-f]{12}$/);
        }
        await loser.page.getByTestId('live-concede').click({ timeout: 30_000 });
        await loser.page.getByTestId('live-concede-yes').click();
        await expect(loser.page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });
        await loser.page.getByTestId('game-result-room').click();
      };
      const finishMatch = async (tableId: string, humans: Seat[], loser: Seat): Promise<void> => {
        for (let game = 0; game < 3; game++) {
          await playOneGame(tableId, humans, loser);
          if ((await view(loser.api, tableId)).phase === 'done') return;
        }
        throw new Error(`${tableId}: still not done after 3 games`);
      };
      const who: [typeof aliceApi, Player['page']][] = [[aliceApi, alice.page], [bobApi, bob.page], [carolApi, carol.page]];
      const atAlice = seated(t1AliceSeats, who);
      const atBob = seated(t1BobSeats, who);
      // Carol concedes to alice, bob to the AI: round 2 then pairs alice (the one winner among the
      // humans) with bob, whom she has not met, and carol, left over, takes the AI.
      await finishMatch(t1Alice, atAlice, atAlice.find((h) => h.api === carolApi)!);
      await finishMatch(t1Bob, atBob, atBob[0]!);

      // Round 1 settles for both.
      await expect.poll(async () => (await aliceApi<{ game: { pod: PodView } }>('GET', `/rooms/${roomId}`)).body.game.pod.round, { timeout: 60_000, message: 'round 2 begins' }).toBe(2);
      const pod2 = (await aliceApi<{ game: { pod: PodView } }>('GET', `/rooms/${roomId}`)).body.game.pod;
      console.log(`[tournament-gauntlet] round 2 pairings: ${JSON.stringify(pod2.pairings)}`);

      const roomView2 = await aliceApi<RoomView>('GET', `/rooms/${roomId}`);
      const bobView2 = await bobApi<RoomView>('GET', `/rooms/${roomId}`);
      const t2Alice = tableOf(roomView2.body, myAliceId);
      const t2Bob = tableOf(bobView2.body, myBobId);

      // Humans first, by score and never a repeat: alice (beat carol) meets bob (lost to the AI) at one table.
      expect(t2Alice, 'round 2 seats alice and bob at one table').toBe(t2Bob);

      // Round 2 draws its own decks, then bans and picks them.
      expect((await aliceApi('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: t2Alice })).status).toBe(200);
      const round2 = await bobApi<GauntletView>('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: t2Alice });
      expect(round2.status, JSON.stringify(round2.body)).toBe(200);
      console.log(`[tournament-gauntlet] round 2 ready@${t2Alice}: phase=${round2.body.phase} era=${round2.body.era?.title}`);
      expect(round2.body.phase, 'round 2 draws fresh').toBe('reveal');
      await expect.poll(async () => (await view(aliceApi, t2Alice)).phase, { timeout: 30_000, message: 'round 2 bans and picks' }).toBe('banpick');
    } finally {
      await alice.context.close();
      await bob.context.close();
      await carol.context.close();
      await stack.stop();
    }
  },
);
