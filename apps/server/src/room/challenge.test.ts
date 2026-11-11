import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { challenges, challengeRoomName, seedStandingChallenge } from './challenge.ts';
import { openLobby, POD_AI, type Lobby } from './lobby.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LEGACY = 'tournament-legacy-2026-02-07';
const ALICE = { id: 'fk:1111111111111111', name: 'user-alice', userId: 'uid-user-alice' };
const BOB = { id: 'fk:2222222222222222', name: 'user-bob', userId: 'uid-user-bob' };

const dirs: string[] = [];
async function lobbyIn(dir?: string): Promise<{ lobby: Lobby; dir: string }> {
	const at = dir ?? (await mkdtemp(join(tmpdir(), 'cardtable-challenge-test-')));
	if (dir === undefined) dirs.push(at);
	return { lobby: await openLobby({ dir: at }), dir: at };
}
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** The room's seat ids as the lobby holds them: a member id, `POD_AI`, or `null` for open. */
const seatIds = (lobby: Lobby, roomId: string): (string | null)[] => lobby.get(roomId)!.game.pod!.seats.map((s) => s?.memberId ?? null);

describe('Challenge catalogue', () => {
	it('lists every tournament import with its standings, each player joined to their own list by rank', async () => {
		const { lobby } = await lobbyIn();
		const list = challenges(lobby, REPO_ROOT).list();
		expect(list.map((c) => c.collection).sort()).toEqual([LEGACY, 'tournament-modern-2026-02-07']);
		const legacy = list.find((c) => c.collection === LEGACY)!;
		expect(legacy).toMatchObject({ name: 'Legacy Challenge 32', date: '2026-02-07', format: 'Legacy (2026-01-26)' });
		expect(legacy.standings).toHaveLength(32);
		expect(legacy.standings[0]).toEqual({ rank: 1, player: 'Ozymandias17', deckId: 'tourney-leg-2026-02-07-1-ozymandias17' });
		for (const row of legacy.standings) expect(row.deckId, row.player).toMatch(new RegExp(`-${String(row.rank)}-`));
	});
});

describe('a Challenge room', () => {
	it('is born whole: the event’s era, the top 8 seated as its quarterfinals, and the caller in the seat they chose', async () => {
		const { lobby } = await lobbyIn();
		const made = challenges(lobby, REPO_ROOT).create(ALICE, { collection: LEGACY, player: 'Ozymandias17', field: 'top8' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const room = lobby.get(made.room.id)!;
		expect(room).toMatchObject({ name: 'Legacy Challenge 32 Top 8, 2026-02-07', game: { format: 'legacy-2026-02-07', mode: 'classic' }, leader: ALICE.id });
		expect(room.settings).toMatchObject({ tournament: true, tournamentDecks: 'locked' });
		expect(room.locks).toEqual({ gameType: 'historical', mode: 'historical', event: 'historical', format: 'historical', rules: 'historical' });
		// The event's quarterfinals, laid onto round 1's across-the-table pairs (seat i meets seat i + 4).
		const seats = seatIds(lobby, room.id);
		const mine = seats.indexOf(ALICE.id);
		expect(seats.filter((s) => s === POD_AI)).toHaveLength(7);
		expect(seats).toHaveLength(8);
		const decks = room.aiDeckAssignments!;
		expect(decks[`ai:${String((mine + 4) % 8)}`], 'Ozymandias17 met TeaW1thRum in the quarterfinals').toBe('tourney-leg-2026-02-07-8-teaw1thrum');
		expect(Object.keys(decks)).toHaveLength(7);
		expect(room.seatDecks, 'the caller’s seat plays Ozymandias17’s own list').toEqual({ [String(mine)]: 'tourney-leg-2026-02-07-1-ozymandias17' });
		expect(decks[`ai:${String(mine)}`], 'the human seat names no list: the caller brings their own').toBeUndefined();
	});

	it('seats the whole field for a full replay, Swiss then the cut, with the caller at their player’s final standing', async () => {
		const { lobby } = await lobbyIn();
		const made = challenges(lobby, REPO_ROOT).create(ALICE, { collection: LEGACY, player: 'Matiuzzzo', field: 'full' });
		if (!made.ok) throw new Error(made.reason);
		const seats = seatIds(lobby, made.room.id);
		expect(seats).toHaveLength(32);
		expect(seats.indexOf(ALICE.id), 'Matiuzzzo finished 4th').toBe(3);
		expect(seats.filter((s) => s === POD_AI)).toHaveLength(31);
		expect(lobby.get(made.room.id)!.name).toBe('Legacy Challenge 32, 2026-02-07');
	});

	it('refuses an unknown event and a player who was not in the field asked for', async () => {
		const { lobby } = await lobbyIn();
		const list = challenges(lobby, REPO_ROOT);
		expect(list.create(ALICE, { collection: 'tournament-nope', player: 'Ozymandias17', field: 'top8' })).toEqual({ ok: false, reason: 'no-challenge' });
		expect(list.create(ALICE, { collection: LEGACY, player: 'Habsburger', field: 'top8' }), '32nd: not in the top 8').toEqual({ ok: false, reason: 'no-player' });
	});

	it('keeps its field: no seat can be given to or taken from the AI, or closed', async () => {
		const { lobby } = await lobbyIn();
		const made = challenges(lobby, REPO_ROOT).create(ALICE, { collection: LEGACY, player: 'Ozymandias17', field: 'top8' });
		if (!made.ok) throw new Error(made.reason);
		const id = made.room.id;
		const ai = seatIds(lobby, id).indexOf(POD_AI);
		expect(lobby.aiPod(id, ALICE.id, ai, false)).toEqual({ ok: false, reason: 'historical' });
		expect(lobby.closePod(id, ALICE.id, ai, true)).toEqual({ ok: false, reason: 'historical' });
		expect(lobby.standPod(id, ALICE.id).ok).toBe(true);
		const open = seatIds(lobby, id).indexOf(null);
		expect(lobby.aiPod(id, ALICE.id, open, true), 'the open seat is a person’s').toEqual({ ok: false, reason: 'historical' });
		expect(lobby.closePod(id, ALICE.id, open, true)).toEqual({ ok: false, reason: 'historical' });
	});

	it('survives a restart with its field, its lists and its locks', async () => {
		const { lobby, dir } = await lobbyIn();
		const made = challenges(lobby, REPO_ROOT).create(ALICE, { collection: LEGACY, player: 'Ozymandias17', field: 'top8' });
		if (!made.ok) throw new Error(made.reason);
		const before = lobby.get(made.room.id)!;
		const { lobby: again } = await lobbyIn(dir);
		const after = again.get(made.room.id)!;
		// Names are not stored (R12); who sits where, and on what list, is.
		const seated = (room: typeof before) => room.game.pod!.seats.map((s) => s?.memberId ?? null);
		expect(seated(after)).toEqual(seated(before));
		expect(after.aiDeckAssignments).toEqual(before.aiDeckAssignments);
		expect(after.seatDecks).toEqual(before.seatDecks);
		expect(after.locks).toEqual(before.locks);
		expect(again.aiPod(after.id, ALICE.id, seatIds(again, after.id).indexOf(POD_AI), false)).toEqual({ ok: false, reason: 'historical' });
	});

	it('a standing Challenge waits empty, its one open seat for whoever comes in first, and is made once', async () => {
		const { lobby } = await lobbyIn();
		const list = challenges(lobby, REPO_ROOT);
		const opts = { collection: LEGACY, player: 'Ozymandias17', field: 'top8' } as const;
		seedStandingChallenge(lobby, list, opts);
		seedStandingChallenge(lobby, list, opts);
		const name = challengeRoomName({ name: 'Legacy Challenge 32', date: '2026-02-07' }, 'top8');
		const standing = lobby.list().filter((r) => r.name === name);
		expect(standing).toHaveLength(1);
		const id = standing[0]!.id;
		expect(lobby.get(id)!.members).toEqual([]);
		expect(seatIds(lobby, id).filter((s) => s === null)).toHaveLength(1);
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(seatIds(lobby, id).filter((s) => s === BOB.id)).toHaveLength(1);
		expect(lobby.get(id)!.leader).toBe(BOB.id);
	});
});
