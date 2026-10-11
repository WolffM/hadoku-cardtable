/**
 * Wave 32 Q6: *"watchparty chat and the game are desynced when i change
 * avatars."* A match is told a seat's avatar once, at its start; the room is the
 * only thing that hears a later change, so `attachTables` subscribes to the room
 * and relays the change to the seat that member holds.
 */

import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attachTables, relayAvatarToMatch, type TablesMatches, type TablesRooms } from './routes.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

type Change = { roomId: string; memberId: string; avatarId: string | null };

function fixture(opts: { matchId?: string | null; owners?: (string | null)[]; status?: string } = {}) {
	const calls: [number, string | null][] = [];
	let listener: ((c: Change) => void) | null = null;
	const owners = opts.owners ?? ['alice', 'bob'];
	const rooms = {
		get: () => ({ id: 'r-1', matchId: opts.matchId === undefined ? 'm-1' : opts.matchId }),
		onAvatarChange: (l: (c: Change) => void) => {
			listener = l;
			return () => undefined;
		},
	} as unknown as TablesRooms;
	const matches: TablesMatches = {
		active: () => [],
		get: (id) =>
			id === 'm-1'
				? {
						status: opts.status ?? 'running',
						claim: () => ({ ok: false, error: 'unused' }),
						seatOf: (who) => {
							const i = owners.indexOf(who);
							return i < 0 ? null : i;
						},
						setSeatAvatar: (seat, avatarId) => calls.push([seat, avatarId]),
						stop: () => undefined,
					}
				: undefined,
	};
	return { rooms, matches, calls, fire: (c: Change) => listener?.(c) };
}

describe('an avatar change reaches the running match (Q6)', () => {
	it('relays the change to the seat the member holds, and to nobody else', () => {
		const f = fixture();
		relayAvatarToMatch(f.rooms, f.matches, { roomId: 'r-1', memberId: 'bob', avatarId: 'rogue' });
		expect(f.calls).toEqual([[1, 'rogue']]);
	});

	it('carries a cleared avatar as null', () => {
		const f = fixture();
		relayAvatarToMatch(f.rooms, f.matches, { roomId: 'r-1', memberId: 'alice', avatarId: null });
		expect(f.calls).toEqual([[0, null]]);
	});

	it.each([
		['a room with no match', { matchId: null }],
		['a match that is over', { status: 'over' }],
		['a member with no seat', { owners: ['x', 'y'] }],
	])('does nothing for %s', (_label, opts) => {
		const f = fixture(opts);
		relayAvatarToMatch(f.rooms, f.matches, { roomId: 'r-1', memberId: 'alice', avatarId: 'mage' });
		expect(f.calls).toEqual([]);
	});

	it('is wired: attachTables subscribes to the room and relays through the lazy registry', () => {
		const f = fixture();
		attachTables(express.Router(), {
			repoRoot: REPO_ROOT,
			draftRooms: null,
			log: () => undefined,
			rooms: f.rooms,
			matches: () => f.matches,
		});
		f.fire({ roomId: 'r-1', memberId: 'alice', avatarId: 'knight' });
		expect(f.calls).toEqual([[0, 'knight']]);
	});
});
