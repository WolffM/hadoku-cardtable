/**
 * `Lobby`'s membership/ready/leader rulings, now that `join`/`leave`/`setReady`
 * run on `@wolffm/rooms-server`'s `MembershipLedger` (wave 97 §L) rather than
 * the hand-rolled `joinedAt` reduce and a per-member `ready` flag.
 *
 * `lobby.test.ts` already covers "leader on Leave goes to the earliest
 * remaining joiner" (`describe('Lobby.leave')`) and is left untouched; this
 * file adds the two rulings that had no test anywhere: a second tab never
 * double-counts a person's Ready, and a disconnect (`releaseAbandonedSeats`,
 * the only entry point a socket-level disconnect ever reaches) never moves
 * membership, Ready or the leader — only the table seat it was given to free.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openLobby } from './lobby.ts';

const ALICE = { id: 'fk:1111111111111111', name: 'user-alice', userId: 'uid-user-alice' };
const BOB = { id: 'fk:2222222222222222', name: 'user-bob', userId: 'uid-user-bob' };

const dirs: string[] = [];
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-lobby-ledger-test-'));
	dirs.push(dir);
	return dir;
}
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('Ready is per person, not per socket', () => {
	it('a second tab (another join of the same durable id) never adds a member or resets Ready', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true]);

		// Tab 2: the same person, a second `join` for the same id (a reconnect
		// or a second browser tab resolves to the one durable `fk:` id, never a
		// new one). One member, Ready untouched.
		const second = lobby.join(id, { ...ALICE, name: 'alice-tab-2' });
		expect(second.ok && second.alreadyMember).toBe(true);
		expect(lobby.get(id)?.members).toHaveLength(1);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true]);

		// Tab 2 pressing Ready again is the same participant's flag, not a second one.
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		expect(lobby.get(id)?.members).toHaveLength(1);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true]);
	});
});

describe('A disconnect never moves membership, Ready or the leader', () => {
	it('releaseAbandonedSeats on the leader frees only the table seat', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		expect(lobby.get(id)?.leader).toBe(ALICE.id);

		// The leader's last connection drops — `room/socket.ts`'s grace timer is
		// the only caller of this, never `leave()` (no "this person is leaving
		// the room" action happened).
		expect(lobby.releaseAbandonedSeats(ALICE.id)).toEqual([{ roomId: id, tableId }]);

		// The seat is gone; everything the ledger owns is not.
		expect(lobby.seats(id, tableId).map((s) => s.memberId)).toEqual([BOB.id]);
		expect(lobby.isMember(id, ALICE.id)).toBe(true);
		expect(lobby.get(id)?.members).toHaveLength(2);
		expect(lobby.get(id)?.members.find((m) => m.id === ALICE.id)?.ready).toBe(true);
		expect(lobby.get(id)?.leader).toBe(ALICE.id);
	});
});
