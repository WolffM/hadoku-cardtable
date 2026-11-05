import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParticipantId } from '@wolffm/rooms-protocol';
import { describe, expect, it } from 'vitest';
import { openLobby } from '../room/lobby.ts';
import { createAccountErase, personOf } from './index.ts';
import { roomsEraseSteps, type LiveMatch } from './rooms.ts';

const ALICE_USER = 'c41f9e2a-7b3d-4a8e-9c56-2f0d1b8e6a03';
const alicePerson = personOf(ALICE_USER);
const ALICE = { id: alicePerson.participantId, name: 'Alice', userId: ALICE_USER };
const BOB = { id: personOf('5b0e3c1d-2a4f-4e6b-8c9d-0f1e2d3c4b5a').participantId, name: 'Bob', userId: '5b0e3c1d-2a4f-4e6b-8c9d-0f1e2d3c4b5a' };

/** Every saved room file's text, joined: what a restart would read back. */
async function onDisk(dir: string): Promise<string> {
	const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
	return (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n');
}

describe("account erase in the person's rooms and games", () => {
	it('forfeits their live game, closes the room only they are in, leaves the shared ones, and anonymises what is left', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'erase-rooms-'));
		const lobby = await openLobby({ dir });
		const room = (made: ReturnType<typeof lobby.create>): string => {
			if (!made.ok) throw new Error(made.reason);
			return made.room.id;
		};
		const alone = room(lobby.create(ALICE, { name: 'Alone', gameType: 'constructed-1v1', clientMode: 'builtin' }));
		const theirs = room(lobby.create(ALICE, { name: 'Hers', gameType: 'constructed-1v1', clientMode: 'builtin' }));
		expect(lobby.join(theirs, BOB).ok).toBe(true);
		const bobs = room(lobby.create(BOB, { name: 'His', gameType: 'constructed-1v1', clientMode: 'builtin' }));
		expect(lobby.join(bobs, ALICE).ok).toBe(true);

		const seated: LiveMatch = { seatOf: (id) => (id === ALICE.id ? 0 : 1) };
		const elsewhere: LiveMatch = { seatOf: (id) => (id === BOB.id ? 0 : null) };
		const forfeits: [LiveMatch, ParticipantId][] = [];
		const closed: string[] = [];
		const erase = createAccountErase({ log: () => {} });
		for (const step of roomsEraseSteps({
			lobby,
			// A forfeited game ends, as Forge ends a conceded one.
			liveMatches: () => [seated, elsewhere].filter((m) => !forfeits.some(([f]) => f === m)),
			forfeit: (match, loser) => forfeits.push([match, loser]),
			closed: (roomId) => closed.push(roomId),
			forfeited: () => {},
		})) erase.register(step);

		expect(await erase.erase(ALICE_USER)).toEqual({ matchesForfeited: 1, roomsClosed: 1, roomsLeft: 2, roomsAnonymised: 1 });
		expect(forfeits).toEqual([[seated, ALICE.id]]);
		expect(closed).toEqual([alone]);
		expect(lobby.get(alone)).toBeUndefined();
		// Leadership of the room she made passed to Bob; the room itself now credits nobody.
		expect(lobby.get(theirs)?.leader).toBe(BOB.id);
		expect(lobby.get(theirs)?.members.map((m) => m.id)).toEqual([BOB.id]);
		expect(lobby.get(bobs)?.members.map((m) => m.id)).toEqual([BOB.id]);

		const saved = await onDisk(dir);
		expect(saved).not.toContain(ALICE.id);
		expect(saved).not.toContain(ALICE_USER);
		expect(saved).toContain('erased:');
		// A restart reads back the same: nothing names her.
		const restarted = await openLobby({ dir });
		expect(JSON.stringify(restarted.list())).not.toContain(ALICE.id);

		expect(await erase.erase(ALICE_USER)).toEqual({ matchesForfeited: 0, roomsClosed: 0, roomsLeft: 0, roomsAnonymised: 0 });
	});
});
