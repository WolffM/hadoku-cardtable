/**
 * Identity is derived, never accepted — and the friend key never survives the
 * derivation.
 *
 * The assertions that matter here are the negative ones: that the credential
 * cannot be read back out of the id, and that a bare SHA-256 of the key is NOT
 * what comes out, which is the only way to tell that domain separation is
 * actually being applied rather than described in a comment.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PARTICIPANT_ID_DIGEST_LENGTH, participantIdTier } from '@wolffm/rooms-protocol';

import { PARTICIPANT_ID_DOMAIN, deriveParticipantId, identityFromHeaders, participantHandle } from './identity.js';

const FRIEND_KEY = 'friend-key-alice-0123456789';
const DEVICE_ID = 'device-alice-0123456789';

describe('deriveParticipantId', () => {
	it('mints the account tier from a friend key', () => {
		const id = deriveParticipantId({ friendKey: FRIEND_KEY, socketId: 'sock' });
		expect(participantIdTier(id)).toBe('account');
		expect(id.startsWith('fk:')).toBe(true);
		expect(id.slice(3)).toHaveLength(PARTICIPANT_ID_DIGEST_LENGTH);
		expect(id.slice(3)).toMatch(/^[0-9a-f]+$/);
	});

	it('prefers the friend key over a device id', () => {
		const both = deriveParticipantId({ friendKey: FRIEND_KEY, deviceId: DEVICE_ID, socketId: 's' });
		const keyOnly = deriveParticipantId({ friendKey: FRIEND_KEY, socketId: 'other-socket' });
		expect(both).toBe(keyOnly);
	});

	it('falls back to the device tier, then to the socket', () => {
		const device = deriveParticipantId({ deviceId: DEVICE_ID, socketId: 'sock' });
		expect(participantIdTier(device)).toBe('device');

		// Too short to be treated as real — `resolveParticipantTier` owns that
		// floor, and falling through to ephemeral is honest rather than broken.
		const ephemeral = deriveParticipantId({ friendKey: 'ab', deviceId: 'abc', socketId: 'sock-9' });
		expect(ephemeral).toBe('eph:sock-9');
		expect(participantIdTier(ephemeral)).toBe('ephemeral');
	});

	it('is stable for one person and distinct between two', () => {
		const a1 = deriveParticipantId({ friendKey: FRIEND_KEY, socketId: 'one' });
		const a2 = deriveParticipantId({ friendKey: FRIEND_KEY, socketId: 'two' });
		const b = deriveParticipantId({ friendKey: `${FRIEND_KEY}-bob`, socketId: 'one' });
		expect(a1).toBe(a2);
		expect(b).not.toBe(a1);
	});

	it('never carries the friend key, and is not a bare digest of it', () => {
		const id = deriveParticipantId({ friendKey: FRIEND_KEY, socketId: 'sock' });
		expect(id).not.toContain(FRIEND_KEY);
		expect(id).not.toContain(FRIEND_KEY.slice(0, 8));

		// Domain separation is either applied or it is decoration. A bare digest
		// of the credential is what this must NOT equal.
		const bare = createHash('sha256').update(FRIEND_KEY, 'utf8').digest('hex');
		expect(id.slice(3)).not.toBe(bare.slice(0, PARTICIPANT_ID_DIGEST_LENGTH));

		// And it IS the domain-separated one, so the scheme is pinned rather
		// than merely "not the obvious wrong thing".
		const expected = createHash('sha256')
			.update(`${PARTICIPANT_ID_DOMAIN}account${FRIEND_KEY}`, 'utf8')
			.digest('hex')
			.slice(0, PARTICIPANT_ID_DIGEST_LENGTH);
		expect(id).toBe(`fk:${expected}`);
	});

	it('separates the tiers, so one string cannot mint two identities', () => {
		// Same material, different tier: the digest must differ, or an
		// `fk:`/`dev:` pair for one value would share a body.
		const asKey = deriveParticipantId({ friendKey: FRIEND_KEY, socketId: 's' });
		const asDevice = deriveParticipantId({ deviceId: FRIEND_KEY, socketId: 's' });
		expect(asKey.slice(3)).not.toBe(asDevice.slice(4));
	});
});

describe('identityFromHeaders', () => {
	it('reads X-User-Key, then X-User-Id, then nothing at all', () => {
		expect(identityFromHeaders({ 'x-user-key': FRIEND_KEY, 'x-user-id': 'alice' }, 'sock')).toBe(
			deriveParticipantId({ friendKey: FRIEND_KEY, socketId: 'sock' }),
		);
		expect(identityFromHeaders({ 'x-user-id': DEVICE_ID }, 'sock')).toBe(
			deriveParticipantId({ deviceId: DEVICE_ID, socketId: 'sock' }),
		);
		// What `sanitizeHeaders` leaves behind for an unvouched caller: the
		// identity headers are DELETED, so there is nothing durable to mint from.
		expect(identityFromHeaders({ 'x-hadoku-tier': 'public' }, 'sock-3')).toBe('eph:sock-3');
	});

	it('ignores an empty header rather than hashing the empty string', () => {
		expect(identityFromHeaders({ 'x-user-key': '', 'x-user-id': '' }, 'sock-4')).toBe('eph:sock-4');
	});
});

describe('participantHandle', () => {
	it('is a short slice of the digest, and never the source material', () => {
		const id = deriveParticipantId({ friendKey: FRIEND_KEY, socketId: 'sock' });
		const handle = participantHandle(id);
		expect(handle).toHaveLength(6);
		expect(id).toContain(handle);
		expect(FRIEND_KEY).not.toContain(handle);
	});

	it('says so rather than throwing when handed something that is not an id', () => {
		expect(participantHandle('not-an-id')).toBe('unknown');
	});
});
