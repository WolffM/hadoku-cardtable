/**
 * The generic room-membership core in isolation — split out of `room/lobby.ts`
 * (wave 110 §L, phase 2), whose own `lobby.test.ts` already covers all of this
 * indirectly through `join`/`leave`/`setReady`. This is the direct unit
 * coverage a platform file gets to stand on its own, over a minimal room
 * shape with no Magic field anywhere in it.
 */
import { createMembershipLedger } from '@wolffm/rooms-server';
import { describe, expect, it } from 'vitest';

import { makeSecret } from './provisioning.ts';
import {
	addRoomMember,
	isMemberReady,
	isRoomMember,
	passwordAdmits,
	removeRoomMember,
	setMemberReady,
	type MembershipRoom,
} from './membership.ts';

interface Member {
	id: string;
}

function roomOf(leader: string): MembershipRoom<Member> {
	const ledger = createMembershipLedger();
	return { members: [], leader, ledger };
}

describe('addRoomMember / isRoomMember', () => {
	it('adds a member, and the room\'s first arrival leads an empty room', () => {
		const room = roomOf('nobody-yet');
		addRoomMember(room, { id: 'alice' }, 1000);
		expect(room.members).toEqual([{ id: 'alice' }]);
		expect(room.leader).toBe('alice');
		expect(isRoomMember(room, 'alice')).toBe(true);
		expect(isRoomMember(room, 'bob')).toBe(false);
	});

	it('a second arrival does not take over leadership', () => {
		const room = roomOf('nobody-yet');
		addRoomMember(room, { id: 'alice' }, 1000);
		addRoomMember(room, { id: 'bob' }, 2000);
		expect(room.leader).toBe('alice');
		expect(room.members.map((m) => m.id)).toEqual(['alice', 'bob']);
	});
});

describe('removeRoomMember', () => {
	it('removes the member and answers the removed row; undefined for a non-member', () => {
		const room = roomOf('nobody-yet');
		addRoomMember(room, { id: 'alice' }, 1000);
		addRoomMember(room, { id: 'bob' }, 2000);
		expect(removeRoomMember(room, 'nobody')).toBeUndefined();
		expect(removeRoomMember(room, 'bob')).toEqual({ id: 'bob' });
		expect(room.members.map((m) => m.id)).toEqual(['alice']);
	});

	it('hands leadership to whoever remains and joined EARLIEST, not to array order', () => {
		const room = roomOf('nobody-yet');
		addRoomMember(room, { id: 'alice' }, 1000);
		addRoomMember(room, { id: 'carol' }, 2000);
		addRoomMember(room, { id: 'bob' }, 3000);
		// alice leads (first in); carol joined before bob.
		expect(room.leader).toBe('alice');
		removeRoomMember(room, 'alice');
		expect(room.leader).toBe('carol');
		// A non-leader leaving changes nothing about who leads.
		removeRoomMember(room, 'bob');
		expect(room.leader).toBe('carol');
	});

	it('leaves `leader` stale when the last member goes — the caller\'s sweep owns reaping the room', () => {
		const room = roomOf('nobody-yet');
		addRoomMember(room, { id: 'alice' }, 1000);
		removeRoomMember(room, 'alice');
		expect(room.members).toEqual([]);
		expect(room.leader).toBe('alice');
	});
});

describe('isMemberReady / setMemberReady', () => {
	it('is false until set, true after, per member', () => {
		const room = roomOf('nobody-yet');
		addRoomMember(room, { id: 'alice' }, 1000);
		addRoomMember(room, { id: 'bob' }, 2000);
		expect(isMemberReady(room, 'alice')).toBe(false);
		setMemberReady(room, 'alice', true);
		expect(isMemberReady(room, 'alice')).toBe(true);
		expect(isMemberReady(room, 'bob')).toBe(false);
		setMemberReady(room, 'alice', false);
		expect(isMemberReady(room, 'alice')).toBe(false);
	});
});

describe('passwordAdmits', () => {
	it('admits anything when the room carries no secret at all', () => {
		expect(passwordAdmits(undefined, undefined)).toBe(true);
		expect(passwordAdmits(undefined, 'whatever')).toBe(true);
	});

	it('admits only the matching password once a secret is set', () => {
		const secret = makeSecret('correct-horse-battery-staple');
		expect(passwordAdmits(secret, 'correct-horse-battery-staple')).toBe(true);
		expect(passwordAdmits(secret, 'wrong')).toBe(false);
		expect(passwordAdmits(secret, undefined)).toBe(false);
	});
});
