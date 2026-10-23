/**
 * Gauntlet in tournament mode, end to end, against the REAL built server and real Forge —
 * `docs/planning/tournament-mode-plan.md`'s ruling 6 and this lane's own Design.
 *
 * Alice, Bob and two AI entrants lock a Gauntlet tournament, Decks Locked. Round 1
 * (`roundsFor(4) === 2`) pairs "across the table" by seat — alice-vs-ai and bob-vs-ai, two
 * SIMULTANEOUS Gauntlet tables, each keyed by its own table id (`room/lobby.ts`'s `gauntlets`,
 * `http/gauntlet.ts`'s `?table=`/body `table`). Both humans draw, bank and choose independently;
 * acting on one table is proved to leave the other alone. Round 1 ends, each entrant's picks are
 * stored the instant their table's banpick ends. Round 2 re-pairs the field by score; whichever
 * human reaches it (both do, since both finished round 1) resumes straight into `choose` — no
 * draw, no banpick — from their own stored picks.
 *
 * API-driven through alice's and bob's own identities, the same way `e2e/cm-gauntlet.spec.ts`
 * drives a single Gauntlet: the Gauntlet screens are their own lane's, this proves the server
 * contract (`room/lobby.ts`, `room/gauntlet.ts`, `http/gauntlet.ts`) end to end against real
 * Forge matches.
 *
 * KNOWN RED until `http/routes.ts`'s own adapter is patched for per-table Gauntlets (see
 * `docs/planning/tournament-mode-plan.md`'s "Open" section — that file is claimed by another
 * session throughout this lane): `seated`/`setReady`/`dealGame` and `holdsTable`/`startRefusal`/
 * `afterGame` all still call with no table id there, which defaults to `tables[0]` — so round 1's
 * two tables collapse onto one shared Gauntlet state until that patch lands. Everything below is
 * written against the contract this lane DID land (`room/lobby.ts`, `http/gauntlet.ts`), and is
 * the proof that patch needs once it is in.
 *
 * `[tournament-gauntlet]` lines are the evidence. Needs a Forge build; without one the test SKIPS
 * and its title says why.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';
import type { PodView } from '../packages/shared/src/pod.ts';

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
    'two simultaneous Gauntlet tables of one round, each ban/pick/choose independently; a locked entrant’s round 2 resumes with no banpick',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(10 * 60_000);
    const stack = await startPlayStack(forge);
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    try {
      await alice.page.goto(`${stack.origin}${PREFIX}/`);
      const aliceApi = <T>(method: 'GET' | 'POST', path: string, data?: unknown) => send<T>(alice.context.request, stack.origin, method, path, data);
      await bob.page.goto(`${stack.origin}${PREFIX}/`);
      const bobApi = <T>(method: 'GET' | 'POST', path: string, data?: unknown) => send<T>(bob.context.request, stack.origin, method, path, data);

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

      const patched = await alice.context.request.patch(`${stack.origin}${PREFIX}/api/rooms/${roomId}`, { data: { settings: { tournament: true, tournamentDecks: 'locked' } } });
      expect(patched.status(), await patched.text()).toBe(200);

      // Alice seat 0, Bob seat 1, two AI seats 2 and 3 — round 1's "across the table" pairing
      // (`@hadoku/draft`'s `round1`) splits [alice, bob, ai:2, ai:3] in half and pairs each top
      // half seat with the matching bottom one: alice-vs-ai:2, bob-vs-ai:3 — two REAL tables, each
      // with an AI, never alice-vs-bob in round 1.
      expect((await aliceApi('POST', `/rooms/${roomId}/pod/sit`, { seat: 0 })).status).toBe(200);
      expect((await bobApi('POST', `/rooms/${roomId}/pod/sit`, { seat: 1 })).status).toBe(200);
      expect((await aliceApi('POST', `/rooms/${roomId}/pod/ai`, { seat: 2, on: true })).status).toBe(200);
      expect((await aliceApi('POST', `/rooms/${roomId}/pod/ai`, { seat: 3, on: true })).status).toBe(200);

      // Ready, for Gauntlet, is the room-level member ready — no deck to pick pre-lock (ruling 4).
      // Bob's own Ready is the last thing the field needs: it locks by itself (ruling 7).
      expect((await aliceApi('POST', `/rooms/${roomId}/ready`, { ready: true })).status).toBe(200);
      const locked = await bobApi<{ pod: PodView | null }>('POST', `/rooms/${roomId}/ready`, { ready: true });
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
      const pod1 = locked.body.pod!;
      expect(pod1.phase, 'the field locked itself on Bob’s own Ready').toBe('rounds');
      expect(pod1.round).toBe(1);
      console.log(`[tournament-gauntlet] round 1 pairings: ${JSON.stringify(pod1.pairings)}`);

      // Resolve each human's own table the same way the UI's `myTournamentTable` would: whichever
      // of `view.tables` holds their own member id — never by the pairing's own entrant ids, which
      // are real member/AI ids, not these test's literal names.
      type RoomView = { tables: { id: string; players: { memberId: string }[] }[]; you: { id: string } };
      const roomView = await aliceApi<RoomView>('GET', `/rooms/${roomId}`);
      const myAliceId = roomView.body.you.id;
      const bobView = await bobApi<RoomView>('GET', `/rooms/${roomId}`);
      const myBobId = bobView.body.you.id;
      const tableOf = (view: RoomView, memberId: string): string => view.tables.find((t) => t.players.some((p) => p.memberId === memberId))!.id;
      const t1Alice = tableOf(roomView.body, myAliceId);
      const t1Bob = tableOf(bobView.body, myBobId);
      expect(t1Alice, 'two DIFFERENT tables, not the same one').not.toBe(t1Bob);

      /** Reads `tableId`'s Gauntlet view as `api` sees it. */
      const view = async (api: typeof aliceApi, tableId: string): Promise<GauntletView> => (await api<GauntletView>('GET', `/tables/rooms/${roomId}/gauntlet?table=${tableId}`)).body;

      // Both ready at their OWN table — the pairing's other seat is AI, always ready, no `ai: true` needed.
      expect((await aliceApi('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: t1Alice })).status).toBe(200);
      expect((await bobApi('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: t1Bob })).status).toBe(200);

      let va = await view(aliceApi, t1Alice);
      let vb = await view(bobApi, t1Bob);
      expect(va.phase, 'alice’s table drew').toBe('reveal');
      expect(vb.phase, 'bob’s table drew — a SEPARATE draw, not alice’s').toBe('reveal');
      expect(va.decks.map((d) => d.id).join(), 'two independent draws').not.toBe(vb.decks.map((d) => d.id).join());
      console.log(`[tournament-gauntlet] alice@${t1Alice} era=${va.era?.title} bob@${t1Bob} era=${vb.era?.title}`);

      /** Runs `tableId`'s banpick to `choose`, acting on the human's own turn and waiting out the AI's. */
      const runBanpick = async (api: typeof aliceApi, tableId: string): Promise<GauntletView> => {
        let v: GauntletView;
        await expect
          .poll(
            async () => {
              v = await view(api, tableId);
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
        return v!;
      };

      va = await runBanpick(aliceApi, t1Alice);
      vb = await runBanpick(bobApi, t1Bob);
      expect(va.phase).toBe('choose');
      expect(vb.phase).toBe('choose');
      console.log('[tournament-gauntlet] both tables’ round-1 banpick done independently');

      // Each chooses, the game is dealt and conceded — fast, same move `e2e/w72-pod.spec.ts` uses.
      const finishGame = async (api: typeof aliceApi, page: Player['page'], tableId: string): Promise<void> => {
        const mine = (await view(api, tableId)).decks.find((d) => d.status === 'picked' && d.by === 0)!.id;
        expect((await api('POST', `/tables/rooms/${roomId}/gauntlet/choose`, { deck: mine, table: tableId })).status).toBe(200);
        await expect.poll(async () => (await view(api, tableId)).phase, { timeout: 30_000, message: `${tableId}: the AI’s own choice deals the game` }).toBe('playing');
        await page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
        await page.getByTestId('live-concede').click({ timeout: 30_000 });
        await page.getByTestId('live-concede-yes').click();
        await expect(page.getByTestId('game-result')).toBeVisible({ timeout: 45_000 });
        await page.getByTestId('game-result-room').click();
      };
      await finishGame(aliceApi, alice.page, t1Alice);
      await finishGame(bobApi, bob.page, t1Bob);

      // Round 1 settles for both; each entrant's first-match picks are on record.
      await expect.poll(async () => (await aliceApi<{ pod: PodView }>('GET', `/rooms/${roomId}`)).body.pod.round, { timeout: 60_000, message: 'round 2 begins' }).toBe(2);
      const pod2 = (await aliceApi<{ pod: PodView }>('GET', `/rooms/${roomId}`)).body.pod;
      console.log(`[tournament-gauntlet] round 2 pairings: ${JSON.stringify(pod2.pairings)}`);

      const roomView2 = await aliceApi<RoomView>('GET', `/rooms/${roomId}`);
      const bobView2 = await bobApi<RoomView>('GET', `/rooms/${roomId}`);
      const t2Alice = tableOf(roomView2.body, myAliceId);
      const t2Bob = tableOf(bobView2.body, myBobId);

      // Locked: round 2 resumes straight into `choose` on the Ready alone — no draw, no banpick —
      // for WHICHEVER human it is (both are already locked from round 1).
      for (const [api, tableId, who] of [
        [aliceApi, t2Alice, 'alice'],
        [bobApi, t2Bob, 'bob'],
      ] as const) {
        const resumed = await api<GauntletView>('POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, table: tableId });
        expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
        console.log(`[tournament-gauntlet] round 2, ${who}@${tableId}: phase=${resumed.body.phase} (no banpick)`);
        expect(resumed.body.phase, `${who}: round 2 skips the draw and banpick entirely`).toBe('choose');
      }
    } finally {
      await alice.context.close();
      await bob.context.close();
      await stack.stop();
    }
  },
);
