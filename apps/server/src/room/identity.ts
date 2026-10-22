/**
 * Minting a `ParticipantId` — now a thin binding over the fleet's derivation.
 *
 * The hashing used to live here: `@wolffm/rooms-protocol` is zero-dependency
 * and isomorphic, so it shipped the *format* and stopped, and `node:crypto`'s
 * `createHash` was ours to own. `@wolffm/rooms-server@0.39.4` publishes the
 * other half — `createParticipantIdDeriver(domain)` — built from the scheme
 * asked for in `docs/requests/P5_SERVICE_PARTICIPANT.md` §7.2, so this file is
 * the domain string and the header plumbing and nothing else.
 *
 * **The ids did not change.** The package hashes
 * `` `${domain}\u001f${tier}\u001f${material}` `` with SHA-256, hex, truncated to
 * `PARTICIPANT_ID_DIGEST_LENGTH` — byte for byte what this file did, including
 * the U+001F separator, and under the same `PARTICIPANT_ID_DOMAIN`. That is not
 * taken on trust: `identity.test.ts` pins a known friend key to the exact `fk:`
 * id it derived before the upgrade, so a future bump that DOES re-identify
 * everybody arrives as a red test rather than as a room full of strangers.
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
 * ## The friend key never leaves the deriver
 *
 * It IS the credential. What comes out is a truncated SHA-256 of it, which is
 * what the id format is designed around: the digest can be logged, put on the
 * wire and shown in a seat row, and the key cannot be recovered from it. There
 * is exactly one id per participant rather than an internal id plus a wire
 * handle to keep in sync.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { createParticipantIdDeriver } from '@wolffm/rooms-server';
import type { ParticipantId } from '@wolffm/rooms-protocol';

/**
 * Domain separation for the digest.
 *
 * Present so that a friend key hashed here can never collide with the same
 * bytes hashed for some other purpose, and versioned so that changing the
 * scheme is a visible change rather than a silent re-identification of
 * everybody.
 *
 * Per-TIER separation is NOT spelled here any more: the package hashes the tier
 * in alongside the domain, and its own header explains why asking the caller
 * for a second string was the wrong shape. There is nowhere to pass one.
 */
export const PARTICIPANT_ID_DOMAIN = 'hadoku.cardtable.participant.v1';

/**
 * A short, wire-safe handle for a seat row — `@wolffm/rooms-protocol`'s, so the
 * truncation length is one number for the fleet rather than one per app.
 *
 * Re-exported rather than imported at each call site because this module is
 * where the rest of the server already looks for anything identity-shaped, and
 * because the import that used to be here was the same function.
 */
export { participantHandle } from '@wolffm/rooms-protocol';

interface IdentityInputs {
	/** `X-User-Key`, post-sanitize. The `account` tier's source material. */
	friendKey?: string | null;
	/** `X-User-Id`, post-sanitize. The `device` tier's source material. */
	deviceId?: string | null;
	/** Fallback for a caller the edge could not name at all. */
	socketId: string;
}

/**
 * Bound once, at module scope. The factory shape is deliberate upstream: a
 * `(input, domain)` function would let a call site mint a second identity space
 * for the same person by passing a different string.
 */
const derive = createParticipantIdDeriver(PARTICIPANT_ID_DOMAIN);

/**
 * Mint an id for one connection.
 *
 * The deriver returns `{ id, tier }`; callers here have only ever wanted the
 * id, and the tier they act on is the EDGE tier (`x-hadoku-tier`), which is a
 * different question from which material the id was minted from.
 */
export function deriveParticipantId(input: IdentityInputs): ParticipantId {
	return derive(input).id;
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
