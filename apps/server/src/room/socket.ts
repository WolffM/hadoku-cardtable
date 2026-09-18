/**
 * The socket.io wiring: the friend gate on a handshake, and the one handler per
 * direction that `@hadoku/shared` is shaped around.
 *
 * ## The gate, on the handshake and not on the route
 *
 * `/cardtable/*` is friend tier at the edge, and `requireMinTier` re-checks that
 * on every HTTP request independently of the edge. **Express middleware does not
 * run for a socket.io handshake** — engine.io takes the upgrade off the raw HTTP
 * server, so `app.use(requireMinTier)` never sees it. A socket path is a path,
 * so the same two steps are re-applied here in the same order:
 *
 *   1. `io.engine.use(edgeProvenance)` — `sanitizeHeaders` on the handshake
 *      request, which overwrites the tier and DELETES the identity headers on
 *      anything the edge did not vouch for.
 *   2. `io.use(...)` — refuse a handshake below `minTier`, before any room
 *      exists and before any identity is minted.
 *
 * There is no second auth scheme, no token, no room key a client presents. A
 * connection that the edge did not vouch for is refused at (2) because (1) has
 * already degraded it to `public`.
 *
 * The path stays socket.io's default `/socket.io/`. The browser asks for
 * `/cardtable/socket.io/` and the edge strips the prefix before we see it —
 * the same reason `base-path.ts` exists, and the reason setting a path here
 * would break it.
 *
 * ## One event name per direction
 *
 * `DRAFT_CHANNEL.clientToServer` is the only thing a client may emit, so there
 * is exactly one inbound handler and it begins with `safeParseClientMessage`.
 * There is no branch where an unparsed object reaches the engine and no cast:
 * parse, then `switch (msg.type)`. A client that sends a `participantId` fails
 * that parse — the schemas are strict — rather than having the field quietly
 * stripped and the claim quietly ignored.
 *
 * ## Errors are values, all the way out
 *
 * The engine rejects a pick by returning a reason. That reason is put on the
 * wire as an `error` envelope with the engine's own code. Nothing in this file
 * throws at a client, and nothing answers a bad message by closing the socket:
 * a draft is driven by whatever arrives over a wire, and a wire delivers
 * nonsense routinely.
 *
 * ## A pick is one envelope, and it says it is complete
 *
 * A human pick is followed by every bot pick the round owes, in one `runBots`
 * call, and the engine bumps `seq` once per change — so the envelope that goes
 * out has jumped by several. That is still ONE envelope per pick, on purpose:
 * one per bot pick would trade one round trip for seven, each a full payload.
 * Instead the envelope is marked `carries: 'full-state'`, because a
 * `DraftView` is the recipient's whole table and the skipped seqs are
 * superseded rather than missing. Unmarked, the client read every round as a
 * gap and resynced (Wave 10: 90 picks, 90 resyncs).
 */

import type { Request } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import { MultiRateLimiter, emitPerRecipient, type EmitPolicy, type RateLimitConfig } from '@wolffm/rooms-server';
import { seatOf, type ParticipantId } from '@wolffm/rooms-protocol';
import { pick as enginePick, runBots } from '@hadoku/draft';
import {
	DRAFT_CHANNEL,
	errorMessage,
	safeParseClientMessage,
	stateMessage,
	updateMessage,
	type ClientMessage,
	type ServerMessage,
	type WireCursor,
	type WireErrorCode,
} from '@hadoku/shared';

import { edgeProvenance, rankOf, tierOf } from '../edge-auth.js';
import {
	cursorFor,
	joinDraftRoom,
	leaveDraftRoom,
	releaseSeat,
	stateOf,
	viewForParticipant,
	type DraftApp,
	type DraftClient,
	type DraftRoom,
	type DraftRooms,
} from './draftRooms.js';
import {
	draftEmitPolicy,
	emitDraftUpdate,
	emitJoinSnapshot,
	sendTo,
	type EmitLog,
} from './emit.js';
import { identityFromHeaders } from './identity.js';

/**
 * Picks per participant, not per socket.
 *
 * A human drafting takes a card every few seconds at most; this allows a burst
 * of eight and then one every 1.5s, which no real drafter reaches and a script
 * does immediately. Keyed by `ParticipantId` so a reconnect does not hand
 * somebody a fresh budget — that is the whole reason the key is not a socket id.
 */
export const PICK_RATE_LIMIT: RateLimitConfig = {
	capacity: 8,
	refillAmount: 1,
	refillIntervalMs: 1500,
};

/**
 * The cursor on a rejection that could not be evaluated against any draft.
 *
 * A rejection carries a cursor so one client-side handler can classify every
 * inbound envelope, but it does not ADVANCE the stream: the client surfaces the
 * error and returns before the verdict is acted on. So a message about a draft
 * that does not exist — or one that did not parse, where the draft id is not
 * trustworthy either — can be stamped with a cursor belonging to no epoch
 * without disturbing anybody's sequencing.
 */
export const NO_DRAFT_CURSOR: WireCursor = { epoch: 'no-draft', seq: 1 };

export interface DraftSocketDeps {
	/** Null when the cube pool did not load; every join then answers unknown-draft. */
	rooms: DraftRooms | null;
	/** The tier floor. `CONFIG.minTier` in production. */
	minTier: string;
	log?: EmitLog;
	rateLimit?: RateLimitConfig;
}

export interface DraftSocketHandle {
	/** Release the rate limiter from the package's sweep registry. */
	close(): void;
}

function defaultLog(line: Record<string, unknown>): void {
	console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-draft', ...line }));
}

/** `tierOf` over the sanitized handshake headers. */
function handshakeTier(headers: IncomingHttpHeaders): string {
	// `tierOf` reads exactly one header off `req.headers`, but it is typed for an
	// express `Request` and a handshake carries a bare `IncomingMessage`. The
	// cast is here rather than a second copy of the header read: a duplicated
	// tier lookup is precisely how the socket path and the HTTP path come to
	// disagree about who is allowed in, which is the bug `edge-auth.ts`'s header
	// is written about.
	return tierOf({ headers } as unknown as Request);
}

/**
 * The step after a pick, to everyone in the room, one payload per recipient.
 *
 * `emitDraftUpdate`'s shape exactly — built per recipient by
 * `viewForParticipant`, never one payload for the room — with the one
 * difference that this envelope declares itself self-contained. See the module
 * header for why a pick's step, and not a join's or a leave's, is where a seq
 * jump is routine.
 */
function emitPickStep(io: SocketIOServer, room: DraftRoom, policy: EmitPolicy): number {
	return emitPerRecipient<DraftApp, DraftClient, ServerMessage>(
		io,
		room,
		DRAFT_CHANNEL.serverToClient,
		(client) => updateMessage(viewForParticipant(room, client.participantId), 'full-state'),
		policy,
	);
}

export function attachDraftSocket(io: SocketIOServer, deps: DraftSocketDeps): DraftSocketHandle {
	const log = deps.log ?? defaultLog;
	const policy = draftEmitPolicy(log);
	const limiter = new MultiRateLimiter<ParticipantId>(deps.rateLimit ?? PICK_RATE_LIMIT);

	// (1) Provenance. Runs on the handshake request itself, which is the only
	// place the edge's headers exist for a socket.
	io.engine.use(edgeProvenance);

	// (2) The floor. 'not found' rather than 'forbidden', for the same reason
	// `requireMinTier` answers 404: a private app does not confirm its own
	// existence to a caller who was never meant to reach it.
	io.use((socket, next) => {
		const tier = handshakeTier(socket.request.headers);
		if (rankOf(tier) < rankOf(deps.minTier)) {
			log({ evt: 'handshake-refused', tier });
			next(new Error('not found'));
			return;
		}
		next();
	});

	io.on('connection', (socket) => {
		const tier = handshakeTier(socket.request.headers);
		// Derived from the sanitized edge headers, never from anything the
		// browser will go on to send.
		const participantId = identityFromHeaders(socket.request.headers, socket.id);
		log({ evt: 'connected', participantId, tier, socketId: socket.id });

		socket.on(DRAFT_CHANNEL.clientToServer, (raw: unknown) => {
			const parsed = safeParseClientMessage(raw);
			if (!parsed.ok) {
				const first = parsed.errors[0];
				log({ evt: 'malformed', participantId, detail: first?.message });
				sendTo(
					socket,
					errorMessage(
						NO_DRAFT_CURSOR,
						'malformed-message',
						first === undefined ? undefined : `${first.path}: ${first.message}`,
					),
					policy,
				);
				return;
			}
			handle(parsed.value);
		});

		socket.on('disconnect', (reason: string) => {
			if (deps.rooms === null) return;
			for (const room of deps.rooms.all()) {
				if (!room.clients.has(socket.id)) continue;
				const outcome = leaveDraftRoom(room, socket.id);
				log({
					evt: 'disconnected',
					participantId,
					reason,
					draftId: room.roomId,
					guarded: outcome.guarded,
				});
				if (outcome.changed) emitDraftUpdate(io, room, policy);
			}
		});

		function reject(room: DraftRoom | null, code: WireErrorCode, detail?: string): void {
			sendTo(socket, errorMessage(room === null ? NO_DRAFT_CURSOR : cursorFor(room), code, detail), policy);
		}

		function handle(msg: ClientMessage): void {
			const rooms = deps.rooms;
			if (rooms === null) {
				reject(null, 'unknown-draft', 'no cube pool is loaded');
				return;
			}

			switch (msg.type) {
				case 'join': {
					const room = rooms.open(msg.draftId);
					const outcome = joinDraftRoom(room, socket.id, participantId, tier);
					log({
						evt: 'join',
						participantId,
						draftId: room.roomId,
						seat: outcome.seat,
						changed: outcome.changed,
					});
					// A baseline for the arrival; a step for everyone already
					// here, and only when the table actually changed — an
					// unchanged seq would reach them as a duplicate anyway.
					if (outcome.changed) {
						emitJoinSnapshot(io, room, socket.id, rooms.cube, policy);
					} else {
						sendTo(
							socket,
							stateMessage(viewForParticipant(room, participantId), rooms.cube),
							policy,
						);
					}
					return;
				}

				case 'leave': {
					const room = rooms.find(msg.draftId);
					if (room === undefined) {
						reject(null, 'unknown-draft');
						return;
					}
					const vacated = releaseSeat(room, participantId);
					log({ evt: 'leave', participantId, draftId: room.roomId, vacated });
					// They stay connected as a spectator until they hang up, so
					// they get the new payload too — and theirs no longer has
					// cards in it.
					if (vacated) emitDraftUpdate(io, room, policy);
					return;
				}

				case 'resync': {
					const room = rooms.find(msg.draftId);
					if (room === undefined) {
						reject(null, 'unknown-draft');
						return;
					}
					log({
						evt: 'resync',
						participantId,
						draftId: room.roomId,
						have: msg.have,
						at: cursorFor(room),
					});
					// A full snapshot, to the asker only. A draft payload is
					// small and a delta protocol is a second thing to get wrong.
					sendTo(socket, stateMessage(viewForParticipant(room, participantId), rooms.cube), policy);
					return;
				}

				case 'pick': {
					const room = rooms.find(msg.draftId);
					if (room === undefined) {
						reject(null, 'unknown-draft');
						return;
					}
					if (!limiter.allow(participantId)) {
						log({ evt: 'rate-limited', participantId, draftId: room.roomId });
						reject(room, 'rate-limited');
						return;
					}
					const seat = seatOf(room.seats, participantId);
					if (seat === null) {
						reject(room, 'not-seated');
						return;
					}
					const before = stateOf(room);
					const result = enginePick(before, seat, msg.cardId);
					if (!result.ok) {
						// The engine's own reason, verbatim. Flattening it into
						// a string here is how a client loses the ability to
						// branch on why it was refused.
						log({ evt: 'pick-rejected', participantId, seat, reason: result.reason });
						reject(room, result.reason);
						return;
					}
					// Bots catch up immediately, so the pod is never waiting on
					// a seat nobody is sitting in.
					const advanced = runBots(result.state);
					room.app.state = advanced.state;
					// The engine spreads its state, so `table` is the same
					// object it has always been and this is a no-op today.
					// It is here so that the alias cannot quietly come apart
					// if the engine ever starts copying the table.
					room.seats = advanced.state.table;
					log({
						evt: 'pick',
						participantId,
						seat,
						draftId: room.roomId,
						botPicks: advanced.picks,
						seq: advanced.state.seq,
					});
					emitPickStep(io, room, policy);
					return;
				}
			}
		}
	});

	return {
		close(): void {
			limiter.deregister();
		},
	};
}
