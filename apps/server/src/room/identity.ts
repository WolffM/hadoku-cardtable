/**
 * Minting a `ParticipantId` — the DERIVATION half, which `@wolffm/rooms-protocol`
 * deliberately does not ship.
 *
 * That package is zero-dependency and isomorphic, so it exports the *format*
 * (`formatParticipantId`, `resolveParticipantTier`, the prefixes, the digest
 * length) and stops there: hashing needs a synchronous crypto primitive it will
 * not assume. `node:crypto`'s `createHash` is that primitive, and this file is
 * the half that owns it. See `docs/requests/P5_SERVICE_PARTICIPANT.md` §7.2 —
 * we asked watchparty to publish it; until they do, this is it.
 *
 * ## Derived, never accepted
 *
 * The inputs come from the EDGE HEADERS and from nowhere else. `X-User-Key` is
 * the friend key (the `account` tier), `X-User-Id` the device-ish fallback, and
 * a caller with neither gets an `ephemeral` id tied to the socket. A browser
 * that puts a `participantId` in a join payload is a parse error one layer up
 * (`@hadoku/shared`'s strict client schemas), not a value anything here reads.
 *
 * Those headers are only believable after `sanitizeHeaders` has run — it
 * overwrites tier and DELETES `x-user-key`/`x-user-id` on anything the edge did
 * not vouch for. So this must run after `edgeProvenance`, which for a socket
 * means after `io.engine.use(edgeProvenance)`. Handed unsanitized headers it
 * would happily mint an `fk:` identity for a forged key.
 *
 * ## The friend key never leaves this file
 *
 * It IS the credential. What comes out is a truncated SHA-256 of it, which is
 * what the id format is designed around: the digest can be logged, put on the
 * wire and shown in a seat row, and the key cannot be recovered from it. There
 * is exactly one id per participant rather than an internal id plus a wire
 * handle to keep in sync.
 */

import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
	PARTICIPANT_ID_DIGEST_LENGTH,
	formatParticipantId,
	participantIdBody,
	resolveParticipantTier,
	type ParticipantId,
	type ParticipantIdTier,
} from '@wolffm/rooms-protocol';

/**
 * Domain separation for the digest.
 *
 * Present so that a friend key hashed here can never collide with the same
 * bytes hashed for some other purpose, and versioned so that changing the
 * scheme is a visible change rather than a silent re-identification of
 * everybody. The unit separator (U+001F) cannot appear in a header value, so
 * the three fields cannot be made to run into one another.
 *
 * This is OUR scheme, not watchparty's — theirs is in a file we cannot import
 * and its exact byte sequence is not published. Ids minted here are therefore
 * only guaranteed to agree with ids minted here, which is all cardtable needs:
 * this process is the only thing that mints one. If `deriveParticipantId` ever
 * ships upstream, delete this and use it.
 */
export const PARTICIPANT_ID_DOMAIN = 'hadoku.cardtable.participant.v1';

const SEP = '';

export interface IdentityInputs {
	/** `X-User-Key`, post-sanitize. The `account` tier's source material. */
	friendKey?: string | null;
	/** `X-User-Id`, post-sanitize. The `device` tier's source material. */
	deviceId?: string | null;
	/** Fallback for a caller the edge could not name at all. */
	socketId: string;
}

function digest(tier: ParticipantIdTier, material: string): string {
	return createHash('sha256')
		.update(`${PARTICIPANT_ID_DOMAIN}${SEP}${tier}${SEP}${material}`, 'utf8')
		.digest('hex')
		.slice(0, PARTICIPANT_ID_DIGEST_LENGTH);
}

/**
 * Mint an id for one connection.
 *
 * The tier decision is `resolveParticipantTier`'s, not ours — it is the one
 * definition of "is this friend key / device id long enough to be real", and
 * re-spelling it here is how the two come to disagree.
 */
export function deriveParticipantId(input: IdentityInputs): ParticipantId {
	const tier = resolveParticipantTier(input);
	if (tier === 'ephemeral') {
		// No digest: an ephemeral body IS the socket id by the format's own
		// definition, and it dies with the socket, so there is nothing to hide.
		return formatParticipantId('ephemeral', input.socketId);
	}
	const material = tier === 'account' ? input.friendKey : input.deviceId;
	return formatParticipantId(tier, digest(tier, material as string));
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
	const raw = headers[name];
	if (typeof raw === 'string' && raw !== '') return raw;
	return null;
}

/**
 * The identity of a handshake, from its SANITIZED headers.
 *
 * `socketId` is only ever reached when the edge named nobody — it is the
 * ephemeral tier's body, and an ephemeral participant cannot hold a seat across
 * a reconnect because there is nothing durable to hold it against.
 */
export function identityFromHeaders(
	headers: IncomingHttpHeaders,
	socketId: string,
): ParticipantId {
	return deriveParticipantId({
		friendKey: headerValue(headers, 'x-user-key'),
		deviceId: headerValue(headers, 'x-user-id'),
		socketId,
	});
}

/**
 * A short, wire-safe handle for a seat row.
 *
 * The body of an id is a non-reversible digest (or, at the ephemeral tier, a
 * socket id), so this is the one part of a participant that may be shown to the
 * rest of the pod. The friend key and the account's `X-User-Id` are NOT: one is
 * the credential and the other is a name the edge resolved for our logs, not
 * for seven other people's screens.
 */
export function participantHandle(id: ParticipantId): string {
	const body = participantIdBody(id);
	return body === null ? 'unknown' : body.slice(0, 6);
}
