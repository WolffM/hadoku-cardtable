/**
 * A room's password (never stored in plaintext: scrypt with a per-room random
 * salt, compared with `timingSafeEqual`) and the ids it mints for itself and
 * its tables.
 *
 * Moved out of `room/lobby.ts` (split, wave 99 §L): generic room provisioning
 * with no Magic content and no `FileLobby` state of its own.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ── the password ─────────────────────────────────────────────────────────────

/**
 * scrypt at node's defaults (N=2^14, r=8, p=1): tens of milliseconds, paid once
 * at create and once per join attempt by a non-member, and join attempts are
 * rate-limited per caller in `http/rooms.ts`. Sync, because the lobby is a
 * synchronous in-memory structure and a friend group creates rooms by hand.
 */
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export interface Secret {
	salt: string;
	hash: string;
}

function hashPassword(password: string, salt: Buffer): Buffer {
	return scryptSync(password.normalize('NFC'), salt, KEY_BYTES);
}

export function makeSecret(password: string): Secret {
	const salt = randomBytes(SALT_BYTES);
	return { salt: salt.toString('hex'), hash: hashPassword(password, salt).toString('hex') };
}

export function passwordMatches(secret: Secret, password: string): boolean {
	const expected = Buffer.from(secret.hash, 'hex');
	const got = hashPassword(password, Buffer.from(secret.salt, 'hex'));
	return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * `r-` plus 12 hex characters. The prefix means a room id can never equal a
 * draft id or a match id; 48 random bits make a collision a non-event at this
 * scale, and `create` re-rolls on one anyway.
 */
export function mintRoomId(): string {
	return `r-${randomBytes(6).toString('hex')}`;
}

/** `t-` plus 8 hex characters, per the wire contract. Re-rolls on a collision against `existing`. */
export function mintTableId(existing: readonly string[]): string {
	const held = new Set(existing);
	let id = `t-${randomBytes(4).toString('hex')}`;
	while (held.has(id)) id = `t-${randomBytes(4).toString('hex')}`;
	return id;
}
