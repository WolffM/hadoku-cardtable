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
 * ## A join does not start a draft — the lobby decides that
 *
 * `case 'join'` used to be `rooms.open(msg.draftId)`: the first socket to name
 * any id dealt a whole eight-seat pod against it, every seat nobody had taken
 * was a bot, and the draft was live before the second friend had finished
 * loading the page. That is the auto-starting pod the operator asked to be rid
 * of (wave 23).
 *
 * So the lobby is consulted FIRST. A `join` is admitted only for a room that
 * exists, whose `gameType` is `draft`, and whose `draftStartedAt` is not null —
 * which is set by `POST /api/rooms/:id/start`, and only once every member of the
 * room is ready. Anything else is `unknown-draft` and deals nothing.
 *
 * **This is the readiness gate, and it is at the server.** A client cannot reach
 * a pod by holding an id: joining a draft room that has not started deals no
 * cards whatever the browser does, so the gate does not depend on any screen
 * getting it right. `lobby` is therefore a REQUIRED dep and not an optional one
 * — two behaviours behind a `?` is how the socket path and the HTTP path come to
 * disagree, which is the bug `edge-auth.ts`'s header is written about.
 *
 * Bots are still every seat the pod opens with. The difference is WHEN: the
 * draft is not built until the room starts it, so the seats a human has not
 * claimed are filled at that instant rather than at connect time, and nobody who
 * has not readied is ever standing in for a bot mid-decision.
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
 * ## Bots pick on a clock, one card each per turn
 *
 * Every seat picks at its own pace (`@hadoku/draft`'s queues). A bot that took
 * cards the moment a pack reached it would drain the pod into the next human's
 * pile at once, so bots take turns: every `botPickMs` each bot holding a pack
 * takes one card (`botTurn`), and the turn goes out as one envelope. At
 * `botPickMs: 0` bots catch up within the pick that fed them (`runBots`), which
 * is what a test that drives the engine by hand wants.
 *
 * Either way an envelope may jump `seq` by several, and is marked
 * `carries: 'full-state'`, because a `DraftView` is the recipient's whole table
 * and the skipped seqs are superseded rather than missing. Unmarked, the client
 * read every round as a gap and resynced (Wave 10: 90 picks, 90 resyncs).
 *
 * ## A seat with nobody connected to it, 30 s
 *
 * `io.on('connection')` fires for every socket this server holds, not only a
 * draft's — the room feed (`room/feed.ts`) shares the same handshake, so a
 * browser's one socket per tab is counted here whatever screen opened it.
 * `liveConnections` tracks that count by participant; when it drops to zero
 * — their last tab closed, or the connection simply dropped — a timer of
 * `seatReleaseMs` (ruled 2026-10-26: 30 s) is set, and if the count is STILL
 * zero when it fires, `lobby.releaseAbandonedSeats` gives back every seat
 * they hold whose table has no live match and no Gauntlet holding it
 * (ruling 13). A reload inside the window reconnects under the SAME
 * participant id (the edge headers mint it, never the socket), so the count
 * is already back above zero when the timer checks — the seat is never
 * touched. Nothing is cancelled on reconnect; the check at fire time is
 * enough, the same way a stale Gauntlet AI timer is a no-op (`http/
 * gauntlet.ts`'s own `wake`).
 */

import type { Request } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import { MultiRateLimiter, emitPerRecipient, type EmitPolicy, type RateLimitConfig } from '@wolffm/rooms-server';
import { seatOf, type ParticipantId } from '@wolffm/rooms-protocol';
import { botTurn, botsOwe, pick as enginePick, runBots } from '@hadoku/draft';
import {
	DRAFT_CHANNEL,
	errorMessage,
	safeParseClientMessage,
	stateMessage,
	updateMessage,
	type ClientMessage,
	type DraftView,
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
	viewForClient,
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
import type { Lobby } from './lobby.js';
import { jsonLogger } from '../log.js';

/**
 * Picks per participant, not per socket.
 *
 * Against bots the next pack arrives at once, so a human late in a pack clicks
 * a card every 150 ms or so (2026-10-18 05:41Z: eleven picks in 3.5 s, and the
 * old 8-then-one-per-1.5 s budget refused the ninth). This allows a whole pack
 * as a burst and then four a second, which no clicking human outruns and a
 * script still does immediately. Keyed by `ParticipantId` so a reconnect does
 * not hand somebody a fresh budget — that is the whole reason the key is not a
 * socket id.
 */
export const PICK_RATE_LIMIT: RateLimitConfig = {
	capacity: 15,
	refillAmount: 1,
	refillIntervalMs: 250,
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
const NO_DRAFT_CURSOR: WireCursor = { epoch: 'no-draft', seq: 1 };

interface DraftSocketDeps {
	/** Null when the cube pool did not load; every join then answers unknown-draft. */
	rooms: DraftRooms | null;
	/**
	 * The room list. REQUIRED: it is what says whether a draft has been started,
	 * and a socket layer that could run without it would be a second answer to
	 * "may this person be dealt cards". See the module header.
	 */
	lobby: Lobby;
	/** The tier floor. `CONFIG.minTier` in production. */
	minTier: string;
	log?: EmitLog;
	rateLimit?: RateLimitConfig;
	/** How long a bot turn takes. `CONFIG.draftBotPickMs` in production; 0 (the default) picks at once. */
	botPickMs?: number;
	/** The seat-release window, ruled 2026-10-26: 30 s. See the module header. */
	seatReleaseMs?: number;
	/** Real `setTimeout` (unref'd) unless a test runs its own clock. */
	schedule?: (fn: () => void, ms: number) => void;
}

interface DraftSocketHandle {
	/** Release the rate limiter from the package's sweep registry. */
	close(): void;
}

const defaultLog = jsonLogger('cardtable-draft');

/** Ruled 2026-10-26. See the module header. */
const SEAT_RELEASE_MS = 30_000;

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
 * `viewForClient`, never one payload for the room — with the one
 * difference that this envelope declares itself self-contained. See the module
 * header for why a pick's step, and not a join's or a leave's, is where a seq
 * jump is routine.
 */
function emitPickStep(io: SocketIOServer, room: DraftRoom, policy: EmitPolicy): number {
	return emitPerRecipient<DraftApp, DraftClient, ServerMessage>(
		io,
		room,
		DRAFT_CHANNEL.serverToClient,
		(client) => updateMessage(viewForClient(room, client), 'full-state'),
		policy,
	);
}

/** Why a `join` was refused. Logged verbatim; `e2e/draft.spec.ts` may read it. */
type JoinRefusal = 'no-room' | 'not-draft' | 'not-started';

/**
 * What the client is told. The CODE is `unknown-draft` in all three cases — a
 * client holding an id it cannot use is in the same position whichever reason it
 * is — and the detail is a sentence for whoever is looking at the screen.
 */
const REFUSAL_DETAIL: Record<JoinRefusal, string> = {
	'no-room': 'no room with that id',
	'not-draft': 'that room is not playing a draft',
	'not-started': 'that draft has not started yet',
};

export function attachDraftSocket(io: SocketIOServer, deps: DraftSocketDeps): DraftSocketHandle {
	const log = deps.log ?? defaultLog;
	const policy = draftEmitPolicy(log);
	const limiter = new MultiRateLimiter<ParticipantId>(deps.rateLimit ?? PICK_RATE_LIMIT);
	const botPickMs = deps.botPickMs ?? 0;
	const botTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const seatReleaseMs = deps.seatReleaseMs ?? SEAT_RELEASE_MS;
	const schedule =
		deps.schedule ??
		((fn: () => void, ms: number): void => {
			const timer = setTimeout(fn, ms);
			timer.unref?.();
		});
	/** Live socket count by participant, across every connection this server holds. See the module header. */
	const liveConnections = new Map<string, number>();

	/**
	 * Every bot holding a pack picks. At `botPickMs: 0`, at once and in place —
	 * the caller's own envelope carries it. Otherwise one card each per turn on
	 * the clock, each turn its own envelope, until no bot holds a pack.
	 */
	const advanceBots = (room: DraftRoom): void => {
		const draftId = room.roomId;
		if (botTimers.has(draftId) || !botsOwe(stateOf(room))) return;
		if (botPickMs <= 0) {
			const advanced = runBots(stateOf(room), (entry) => log(entry));
			room.app.state = advanced.state;
			log({ evt: 'bot-picks', draftId, picks: advanced.picks, seq: advanced.state.seq });
			return;
		}
		const timer = setTimeout(() => {
			botTimers.delete(draftId);
			// Found again: the room may have been forgotten while the turn waited.
			const current = deps.rooms?.find(draftId);
			if (current === undefined) return;
			const turn = botTurn(stateOf(current), (entry) => log(entry));
			if (turn.picks > 0) {
				current.app.state = turn.state;
				log({ evt: 'bot-picks', draftId, picks: turn.picks, seq: turn.state.seq });
				emitPickStep(io, current, policy);
			}
			if (!turn.stalled) advanceBots(current);
		}, botPickMs);
		timer.unref();
		botTimers.set(draftId, timer);
	};

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

	/**
	 * Why this `join` may not be dealt a pod, or null to admit it.
	 *
	 * Membership is deliberately NOT checked. A friend who opens an invite link
	 * after the draft started is joined to the room by the room screen's own read
	 * and then connects here; requiring membership first would make the seat they
	 * take depend on two requests landing in order. What the gate protects is the
	 * DEALING of a draft, and the lobby has already decided that.
	 */
	function joinRefusal(draftId: string): JoinRefusal | null {
		const room = deps.lobby.get(draftId);
		if (room === undefined) return 'no-room';
		if (room.gameType !== 'draft') return 'not-draft';
		if (room.draftStartedAt === null) return 'not-started';
		return null;
	}

	io.on('connection', (socket) => {
		const tier = handshakeTier(socket.request.headers);
		// Derived from the sanitized edge headers, never from anything the
		// browser will go on to send.
		const participantId = identityFromHeaders(socket.request.headers, socket.id);
		log({ evt: 'connected', participantId, tier, socketId: socket.id });
		liveConnections.set(participantId, (liveConnections.get(participantId) ?? 0) + 1);

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
			// The LAST connection for this participant gone starts the
			// seat-release window. A reconnect (even a bare reload — the edge
			// headers mint the same `participantId`, never the socket) is simply
			// a count above zero again by the time the timer below checks, so
			// nothing here needs to find or cancel it.
			const left = (liveConnections.get(participantId) ?? 1) - 1;
			if (left <= 0) liveConnections.delete(participantId);
			else liveConnections.set(participantId, left);
			if (left <= 0) {
				schedule(() => {
					if ((liveConnections.get(participantId) ?? 0) > 0) return;
					const released = deps.lobby.releaseAbandonedSeats(participantId);
					for (const r of released) log({ evt: 'seat-released-disconnected', participantId, ...r });
				}, seatReleaseMs);
			}
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

		/** This connection's own payload: its seat, or the seat it watches. */
		function ownView(room: DraftRoom): DraftView {
			const client = room.clients.get(socket.id);
			return client === undefined ? viewForParticipant(room, participantId) : viewForClient(room, client);
		}

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
					// The gate. A draft room that has not been started deals
					// NOTHING, so a bare id is not a pod and never was one.
					const refusal = joinRefusal(msg.draftId);
					if (refusal !== null) {
						log({ evt: 'join-refused', participantId, draftId: msg.draftId, reason: refusal });
						reject(null, 'unknown-draft', REFUSAL_DETAIL[refusal]);
						return;
					}
					const room = rooms.open(msg.draftId);
					const outcome = joinDraftRoom(room, socket.id, participantId, tier, rooms.drafters(room.roomId));
					log({
						evt: 'join',
						participantId,
						draftId: room.roomId,
						seat: outcome.seat,
						changed: outcome.changed,
					});
					// On the clock, a pod's bots start on their first packs once
					// someone is at the table; a join to a pod already going finds
					// them running. Picking at once, they wait for a pick to feed them.
					if (botPickMs > 0) advanceBots(room);
					// A baseline for the arrival; a step for everyone already
					// here, and only when the table actually changed — an
					// unchanged seq would reach them as a duplicate anyway.
					if (outcome.changed) {
						emitJoinSnapshot(io, room, socket.id, rooms.cubeMetaOf(room), policy);
					} else {
						sendTo(
							socket,
							stateMessage(viewForClient(room, outcome.client), rooms.cubeMetaOf(room)),
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
					sendTo(socket, stateMessage(ownView(room), rooms.cubeMetaOf(room)), policy);
					return;
				}

				case 'watch': {
					const room = rooms.find(msg.draftId);
					const client = room?.clients.get(socket.id);
					if (room === undefined || client === undefined) {
						reject(null, 'unknown-draft');
						return;
					}
					if (msg.drafter >= stateOf(room).seatCount) {
						reject(room, 'unknown-seat');
						return;
					}
					client.app.watching = msg.drafter;
					log({ evt: 'watch', participantId, draftId: room.roomId, drafter: msg.drafter });
					sendTo(socket, stateMessage(viewForClient(room, client), rooms.cubeMetaOf(room)), policy);
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
					// No re-alias of `room.seats`. The registry was seeded with
					// a seat-table FACTORY returning this draft's table
					// (`draftRooms.ts` `open`), and the engine spreads its
					// state rather than copying the table, so the room already
					// holds the one the pick advanced. Assigning here
					// "defensively" is the second owner of the field that the
					// factory exists to remove — and if the engine ever did
					// start copying the table it would paper over a real bug
					// instead of letting it fail.
					room.app.state = result.state;
					log({
						evt: 'pick',
						participantId,
						seat,
						draftId: room.roomId,
						seq: result.state.seq,
					});
					// The pack this pick passed may be a bot's next.
					advanceBots(room);
					emitPickStep(io, room, policy);
					return;
				}
			}
		}
	});

	return {
		close(): void {
			limiter.deregister();
			for (const timer of botTimers.values()) clearTimeout(timer);
			botTimers.clear();
		},
	};
}
