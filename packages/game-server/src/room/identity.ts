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
 * The package hashes `` `${domain}\u001f${tier}\u001f${material}` `` with
 * SHA-256, hex, truncated to `PARTICIPANT_ID_DIGEST_LENGTH`. `identity.test.ts`
 * pins a known userId to the exact `fk:` id it derives, so a future bump that
 * re-identifies everybody arrives as a red test rather than as a room full of
 * strangers.
 *
 * ## The material is the userId, never the key
 *
 * The id is minted from `X-User-Id`, the registry's userId, passed as the
 * deriver's `accountId` (the `account` tier). It used to be minted from
 * `X-User-Key`, the credential, and a rotated key then made the same person a
 * stranger to every room, pod and recording that named them (cardtable#2,
 * hadoku_site IDENTITY_MODEL R7/R12, cardtable#25). The key is not an input at
 * all now. Stores written under the key-derived ids are refused rather than
 * remapped (`@wolffm/rooms-server/store`'s `STORE_VERSION` 2).
 *
 * ## Derived, never accepted
 *
 * The input comes from the EDGE HEADERS and from nowhere else. A caller the
 * edge named nobody gets an `ephemeral` id tied to the socket. A browser that
 * puts a `participantId` in a join payload is a parse error one layer up
 * (`@hadoku/shared`'s strict client schemas), not a value anything here reads.
 *
 * `X-User-Id` is only believable after `sanitizeHeaders` has run — it
 * overwrites tier and DELETES `x-user-id` on anything the edge did not vouch
 * for. So this must run after `edgeProvenance`, which for a socket means after
 * `io.engine.use(edgeProvenance)`. Handed unsanitized headers it would happily
 * mint an `fk:` identity for a forged userId.
 *
 * The id is a domain-separated digest, so it can be logged, put on the wire and
 * shown in a seat row; there is exactly one id per participant rather than an
 * internal id plus a wire handle to keep in sync.
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
	/** `X-User-Id`, post-sanitize: the registry userId. The `account` tier's source material. */
	accountId?: string | null;
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
	return deriveParticipantId({ accountId: headerValue(headers, 'x-user-id'), socketId });
}
