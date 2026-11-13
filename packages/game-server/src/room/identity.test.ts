/**
 * Identity is derived from the userId, never accepted, and never from the key.
 *
 * ## The GOLDEN id, and why it is a literal
 *
 * A participant id is the only durable name a drafter has: every persisted
 * room, every remembered seat and every reservation is keyed by it, so an
 * upgrade that changes the digest does not break — it silently re-identifies
 * everybody, and an eight-person pod comes back from a restart as eight
 * strangers with no error anywhere.
 *
 * A test that re-derives the expectation from the same package cannot see
 * that. So the account tier is pinned to a STRING LITERAL, computed by hand from
 * the scheme (`sha256(domain ␟ 'account' ␟ 'uid' ␟ userId)`, truncated to
 * `PARTICIPANT_ID_DIGEST_LENGTH`), not from anything here. If a future bump
 * changes it, THIS is the red test, and the fix is a store version, not a new
 * literal.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PARTICIPANT_HANDLE_LENGTH, PARTICIPANT_ID_DIGEST_LENGTH, participantIdTier } from '@wolffm/rooms-protocol';

import { PARTICIPANT_ID_DOMAIN, deriveParticipantId, identityFromHeaders, participantHandle } from './identity.js';

const USER_ID = 'a1b2c3d4-0000-4000-8000-0123456789ab';
const FRIEND_KEY = 'friend-key-alice-0123456789';

/** What `USER_ID` derives to. See the module header. */
const GOLDEN_ACCOUNT_ID = 'fk:8b5d95098e013278';

describe('the account-tier id', () => {
	/* The one test in this file that must not be re-derived. */
	it('is the exact id the scheme gives this userId', () => {
		expect(deriveParticipantId({ accountId: USER_ID, socketId: 'sock' })).toBe(GOLDEN_ACCOUNT_ID);
		expect(identityFromHeaders({ 'x-user-id': USER_ID }, 'sock')).toBe(GOLDEN_ACCOUNT_ID);
	});

	it('is the domain-separated, labelled digest of the userId', () => {
		const expected = createHash('sha256')
			.update(`${PARTICIPANT_ID_DOMAIN}\u001faccount\u001fuid\u001f${USER_ID}`, 'utf8')
			.digest('hex')
			.slice(0, PARTICIPANT_ID_DIGEST_LENGTH);
		expect(GOLDEN_ACCOUNT_ID).toBe(`fk:${expected}`);
		expect(participantIdTier(GOLDEN_ACCOUNT_ID)).toBe('account');
	});

	it('pins the handle the pod sees, which is a slice of that id', () => {
		expect(participantHandle(GOLDEN_ACCOUNT_ID)).toBe('8b5d95');
		expect(participantHandle(GOLDEN_ACCOUNT_ID)).toHaveLength(PARTICIPANT_HANDLE_LENGTH);
	});
});

describe('identityFromHeaders', () => {
	it('is the same person whatever key they hold: a rotated key changes nothing', () => {
		const before = identityFromHeaders({ 'x-user-id': USER_ID, 'x-user-key': FRIEND_KEY }, 'one');
		const after = identityFromHeaders({ 'x-user-id': USER_ID, 'x-user-key': `${FRIEND_KEY}-rotated` }, 'two');
		expect(before).toBe(GOLDEN_ACCOUNT_ID);
		expect(after).toBe(GOLDEN_ACCOUNT_ID);
	});

	it('mints nothing durable from a key alone: the key is not an input', () => {
		expect(identityFromHeaders({ 'x-user-key': FRIEND_KEY }, 'sock-1')).toBe('eph:sock-1');
	});

	it('is distinct between two people', () => {
		expect(identityFromHeaders({ 'x-user-id': `${USER_ID}-bob` }, 'sock')).not.toBe(GOLDEN_ACCOUNT_ID);
	});

	it('falls back to the socket for a caller the edge named nobody', () => {
		// What `sanitizeHeaders` leaves behind for an unvouched caller: the
		// identity headers are DELETED, so there is nothing durable to mint from.
		expect(identityFromHeaders({ 'x-hadoku-tier': 'public' }, 'sock-3')).toBe('eph:sock-3');
		expect(identityFromHeaders({ 'x-user-id': '' }, 'sock-4')).toBe('eph:sock-4');
	});

	it('never carries the userId, and is not a bare digest of it', () => {
		expect(GOLDEN_ACCOUNT_ID).not.toContain(USER_ID.slice(0, 8));
		const bare = createHash('sha256').update(USER_ID, 'utf8').digest('hex');
		expect(GOLDEN_ACCOUNT_ID.slice(3)).not.toBe(bare.slice(0, PARTICIPANT_ID_DIGEST_LENGTH));
	});
});

describe('participantHandle', () => {
	it('says so rather than throwing when handed something that is not an id', () => {
		expect(participantHandle('not-an-id')).toBe('unknown');
	});
});
