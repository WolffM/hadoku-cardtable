/**
 * Proves the `GameTypeSpec` registry (`@hadoku/shared`'s `game-type-spec.ts`)
 * actually opens the lobby to a game Magic never wrote: register a
 * bomberman-shaped spec — up to 10 seats, its own bots, no ready step,
 * started on a countdown — and run it through the SAME lobby mechanics a
 * Magic room already uses (`sitPod`/`aiPod`), with no change to `lobby.ts`
 * beyond registering a spec.
 *
 * `sitPod(..., 7)` is the load-bearing line: a seat index a plain two-seat
 * table could never hold. It only reaches the pod's own (already N-seat)
 * array because `usesPod` (`lobby.ts`) asks this room's OWN spec whether it
 * plays with more than a table's two seats, rather than asking only "is
 * this Magic's own `draft`". Reverting that one line to a Magic-only
 * condition is the hard two-seat cap a mutation test should reintroduce:
 * with it back, this file's seat-7 assertion refuses with `not-draft` and
 * the test goes red; restoring `lobby.ts` turns it green again.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerGameType, type GameTypeSpec } from '@hadoku/shared';
import { openLobby, type Lobby } from './lobby.ts';

/** This game's own bot marker — opaque to the registry, which never reads it; only this spec's own `bots.fill` and the test assign it meaning. */
const BOMBERMAN_BOT = 'bomberman-bot';

/**
 * A game Magic never wrote: a free-for-all of 1 to 10, no 1v1 pairing, no
 * ready step (it starts on its own countdown instead), one game per
 * "series", and a trivial bot-fill — every field a `GameTypeSpec` asks a
 * STATIC game type for, with no server instance or runtime service behind
 * any of it (unlike Magic's own `GameHooks`, which `lobby.ts` wires in per
 * game type through `Lobby.useGameType`).
 */
const BOMBERMAN: GameTypeSpec = {
	id: 'bomberman',
	seats: { min: 1, max: 10 },
	ready: false,
	bots: { fill: (seats) => seats.map((s) => s ?? BOMBERMAN_BOT) },
	series: { length: 1 },
	canStart: (seated) => (seated >= 1 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
};
registerGameType(BOMBERMAN);

const ALICE = { id: 'fk:aaaaaaaaaaaaaaaa', name: 'user-alice', userId: 'uid-user-alice' };

const dirs: string[] = [];
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-gametype-test-'));
	dirs.push(dir);
	return dir;
}
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('a registered game type Magic never wrote', () => {
	it('opens, seats at an index no 1v1 table could ever hold, fills its own open seats with its own bot, and answers its own canStart', async () => {
		const lobby: Lobby = await openLobby({ dir: await tempDir() });

		// open — no `GAME_TYPES` entry for 'bomberman', and no code change: the room registry asks
		// the spec registry, not a closed enum (`room-modes.ts`'s `GameTypeSchema`).
		const made = lobby.create(ALICE, { name: 'Bomberman match', gameType: BOMBERMAN.id, clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		const roomId = made.room.id;
		expect(made.room.gameType).toBe('bomberman');

		// seat 7 — past index 1, which is as far as a plain 1v1 table ever reaches.
		expect(lobby.sitPod(roomId, ALICE.id, 7).ok).toBe(true);
		expect(lobby.get(roomId)?.pod?.seats[7]?.memberId).toBe(ALICE.id);

		// fill bots — this game's OWN spec decides the marker; the lobby only ever sees a member id string.
		const seated = lobby.get(roomId)!.pod!.seats.map((s) => s?.memberId ?? null);
		const filled = BOMBERMAN.bots!.fill(seated);
		filled.forEach((occupant, seat) => {
			if (occupant === BOMBERMAN_BOT && seated[seat] === null) expect(lobby.aiPod(roomId, ALICE.id, seat, true).ok).toBe(true);
		});
		const afterFill = lobby.get(roomId)!.pod!.seats;
		const filledCount = afterFill.filter((s) => s !== null).length;
		expect(filledCount).toBeGreaterThan(1);
		expect(filledCount).toBeLessThanOrEqual(BOMBERMAN.seats.max);

		// start — this game's own seat-count verdict, with no Magic-specific gate (deck legality,
		// a draft's own completion, …) anywhere on its path.
		expect(BOMBERMAN.canStart(filledCount)).toEqual({ ok: true });
		expect(BOMBERMAN.canStart(0)).toEqual({ ok: false, reason: 'not-enough-players' });
	});

	it('an unregistered game type still quarantines on restore, exactly as a type outside the old closed enum always did', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Unknown game', gameType: 'some-game-nobody-registered', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		const reopened = await openLobby({ dir });
		expect(reopened.get(made.ok ? made.room.id : '')).toBeUndefined();
	});
});
