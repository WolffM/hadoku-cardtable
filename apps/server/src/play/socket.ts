/**
 * Mounting a match on the running server: one HTTP route to start one, and the
 * socket.io handlers that carry it. `attachPlay` is the only export
 * `src/index.ts` needs.
 *
 * ## The gate is the draft's gate, re-applied
 *
 * Same `io`, same default path, same two steps as `room/socket.ts`:
 * `io.engine.use(edgeProvenance)` sanitizes the handshake's headers, and an
 * `io.use` refuses anything below the tier floor. They are installed again here
 * rather than relied on from the draft's attach, because "the play socket is
 * gated only if something else was attached first" is an ordering dependency,
 * and an ordering dependency on a gate is how a gate goes missing. Both steps
 * are idempotent — `sanitizeHeaders` over already-sanitized headers changes
 * nothing — so running them twice costs one header read.
 *
 * The HTTP routes hang off the `api` router `index.ts` already mounts behind
 * `requireMinTier`, so they are gated by the same line every other API route is.
 *
 * ## Identity is derived, never accepted
 *
 * `identityFromHeaders` over the sanitized handshake, as the draft does. A
 * `participantId` in a payload is not read by anything — the envelopes are
 * strict, so it fails the parse.
 *
 * One exception, and it is dev-only: with the bare-local hatch open
 * (`CARDTABLE_INSECURE_NO_EDGE_AUTH=1` AND no `EDGE_AUTH_SECRET`), every browser
 * on the machine is the same `local-dev` participant, because a browser cannot
 * set `x-user-id` on a websocket handshake — so two local tabs would claim the
 * same seat. `devIdentity` lets a handshake name itself with
 * `auth: { devUser }` or `?devUser=`. It is refused unless the hatch is open
 * (checked here against `CONFIG`, not only against the caller's flag), because
 * with a real edge that would be identity by assertion.
 *
 * ## Per recipient
 *
 * `emitPerRecipient` with a builder that returns the seat's envelope to that
 * seat's connections and `SKIP` to everyone else. The envelope is built by
 * `Match`, which only ever builds one for a named seat.
 */

import express, { type Request, type Response, type Router } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import {
	RoomRegistry,
	SKIP,
	emitPerRecipient,
	joinRoom,
	leaveRoom,
	type CoreRoomState,
	type EmitPolicy,
} from '@wolffm/rooms-server';
import { createSeatTable, type ParticipantId } from '@wolffm/rooms-protocol';

import { CONFIG } from '../config.js';
import { edgeProvenance, rankOf, tierOf } from '../edge-auth.js';
import { identityFromHeaders, participantHandle } from '../room/identity.js';
import { MAX_CONCURRENT_MATCHES, type MatchHostFactory, type MatchSpec } from './host.js';
import { createMatchRegistry, type Match, type MatchRegistry } from './match.js';
import {
	MATCH_EVENTS,
	parseClientEnvelope,
	parseFullControl,
	parseMatchRequest,
	type MatchError,
	type MatchSnapshot,
} from './transport.js';

export type PlayLog = (entry: Record<string, unknown>) => void;

export interface PlayDeps {
	/** The tier floor. `CONFIG.minTier` in production. */
	minTier: string;
	/** Where a match's Forge runs. Null when Forge is not configured: starting a match answers 503. */
	host: MatchHostFactory | null;
	log?: PlayLog;
	/** Every ask is aborted after this long. Default 10 minutes. */
	askTimeoutMs?: number;
	/** How long a finished match keeps its JVM. Default 10 minutes. */
	overGraceMs?: number;
	/** How long `POST /play/matches` waits for Forge to open the game. Default 60 s. */
	startTimeoutMs?: number;
	/** How long a join waits for a starting match. Default 8 s — under the client's 10 s ack timeout. */
	joinWaitMs?: number;
	/**
	 * Concurrent matches (each is a JVM). Default `MAX_CONCURRENT_MATCHES` (2) —
	 * a deliberate ceiling; `host.ts`'s header, "The ceiling", has the argument.
	 */
	maxMatches?: number;
	/**
	 * How long a seat with no connection keeps its open asks before they are
	 * aborted as `disconnected`. Default 30 s: a browser refresh closes the old
	 * socket before the new page joins, and must not hand Forge a null answer.
	 */
	disconnectGraceMs?: number;
	/**
	 * `POST /play/matches/:id/probe` and `GET /play/matches/:id/seats/:seat/state`
	 * exist. Diagnostics for a live check — the second returns a seat's hand to
	 * any friend-tier caller, so this is never on in production.
	 */
	probe?: boolean;
	/** Dev-only per-handshake identity; see the module header. */
	devIdentity?: boolean;
}

export interface PlayHandle {
	matches: MatchRegistry;
	/** Stop every match (each stops its JVM), and release the host's spare. */
	close(): void;
}

interface PlayApp {
	/** Null only between `RoomRegistry.seed` and `roomFor` filling it in, as in `room/draftRooms.ts`. */
	match: Match | null;
}

interface PlayClient {
	seat: number;
}

type PlayRoom = CoreRoomState<PlayApp, PlayClient>;

function defaultLog(entry: Record<string, unknown>): void {
	console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-play', ...entry }));
}

function handshakeTier(headers: IncomingHttpHeaders): string {
	return tierOf({ headers } as unknown as Request);
}

const DEV_USER = /^[a-z0-9-]{1,32}$/;

/** The one policy: a Forge frame is never droppable (a dropped delta is a desynced board). */
function playEmitPolicy(log: PlayLog): EmitPolicy {
	return {
		thresholdBytes: 1024 * 1024,
		highPriority: new Set([MATCH_EVENTS.serverToClient]),
		lowPriorityOrder: [],
		onDrop: (info) => log({ evt: 'emit-drop', ...info }),
		onError: (info) => log({ evt: 'emit-error', event: info.event, socketId: info.socketId }),
	};
}

/** `POST /play/matches` body: `{ opponent?: 'human' | 'ai', decks?: [dck | null, dck | null] }`. */
export function parseStartBody(body: unknown): { ok: true; spec: MatchSpec } | { ok: false; error: string } {
	const b = (body ?? {}) as Record<string, unknown>;
	if (typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'body must be an object' };
	for (const key of Object.keys(b)) {
		if (key !== 'opponent' && key !== 'decks') return { ok: false, error: `unknown field ${key}` };
	}
	const opponent = b.opponent ?? 'human';
	if (opponent !== 'human' && opponent !== 'ai') return { ok: false, error: "opponent is 'human' or 'ai'" };
	const decks = b.decks ?? [null, null];
	if (!Array.isArray(decks) || decks.length !== 2) return { ok: false, error: 'decks is a two-element array' };
	for (const d of decks) {
		if (d !== null && (typeof d !== 'string' || d.length === 0 || d.length > 64 * 1024)) {
			return { ok: false, error: 'each deck is .dck text (at most 64 KiB) or null' };
		}
	}
	// `CARDTABLE_PLAY_SEED` fixes Forge's shuffles, the coin toss and the precon
	// pick (`play/README.md`, `MatchSpec.seed`), and `bridgeConfig` spreads the
	// whole spec to the JVM. `jvm.test.ts` has always used it by building a spec
	// directly; a match started through the PRODUCT path had no way to ask for
	// one, so `e2e/play.spec.ts` played a different game every run. It hunts for
	// a castable spell to prove one resolves unattended, and on 2026-09-25 CI
	// drew a hand where Forge offered nothing but lands — `casts: []`,
	// `everOffered: ["Plains", "Celestial Colonnade"]` — so the proof failed on
	// the shuffle, not on the product.
	//
	// Unset in production, which is every deployment: this is the test hatch,
	// and an unseeded match is what it falls back to.
	const seedRaw = process.env.CARDTABLE_PLAY_SEED;
	const seed = seedRaw === undefined || seedRaw === '' ? Number.NaN : Number(seedRaw);
	return {
		ok: true,
		spec: {
			seats: [
				// Forge shows these names to both seats; they are never an identity.
				{ name: 'Seat 1', ai: false, deck: decks[0] as string | null },
				{ name: opponent === 'ai' ? 'Forge AI' : 'Seat 2', ai: opponent === 'ai', deck: decks[1] as string | null },
			],
			...(Number.isFinite(seed) ? { seed } : {}),
		},
	};
}

export function attachPlay(io: SocketIOServer, api: Router, deps: PlayDeps): PlayHandle {
	const log = deps.log ?? defaultLog;
	const policy = playEmitPolicy(log);
	const rooms = new RoomRegistry<PlayApp, PlayClient>(() => ({ match: null }));
	const joinWaitMs = deps.joinWaitMs ?? 8000;
	const devIdentity = deps.devIdentity === true && CONFIG.allowUnverifiedEdge && CONFIG.edgeAuthSecret === '';
	if (deps.devIdentity === true && !devIdentity) {
		log({ evt: 'dev-identity-refused', reason: 'the insecure edge hatch is not open' });
	}

	const roomFor = (match: Match): PlayRoom => {
		const room = rooms.seed(match.id, match.id);
		if (room.app.match === null) {
			room.app.match = match;
			// Membership only. Seat AUTHORITY is `Match.claim`, which never
			// transfers a seat; a capacity-0 table cannot be mistaken for it.
			room.seats = createSeatTable(0);
		}
		return room;
	};

	const matches = createMatchRegistry({
		host: (id, spec, events) => {
			if (deps.host === null) throw new Error('no Forge host is configured');
			return deps.host(id, spec, events);
		},
		log,
		askTimeoutMs: deps.askTimeoutMs ?? 10 * 60_000,
		overGraceMs: deps.overGraceMs ?? 10 * 60_000,
		disconnectGraceMs: deps.disconnectGraceMs ?? 30_000,
		emit: (match, seat, envelope) => {
			emitPerRecipient<PlayApp, PlayClient, typeof envelope>(
				io,
				roomFor(match),
				MATCH_EVENTS.serverToClient,
				(client) => (client.app.seat === seat ? envelope : SKIP),
				policy,
			);
		},
	});

	/* ── HTTP ───────────────────────────────────────────────────────── */

	const router = express.Router();
	router.use(express.json({ limit: '256kb' }));

	router.post('/matches', async (req: Request, res: Response) => {
		const parsed = parseStartBody(req.body);
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		if (deps.host === null) {
			res.status(503).json({ error: 'Forge is not configured on this server (CARDTABLE_FORGE_JAR / CARDTABLE_FORGE_RES)' });
			return;
		}
		const max = deps.maxMatches ?? MAX_CONCURRENT_MATCHES;
		if (matches.active().length >= max) {
			res.status(503).json({ error: `already running ${max} matches` });
			return;
		}
		const match = matches.create(parsed.spec);
		roomFor(match);
		log({ evt: 'match-created', matchId: match.id, opponent: parsed.spec.seats[1].ai ? 'ai' : 'human' });
		const running = await match.whenRunning(deps.startTimeoutMs ?? 60_000);
		if (!running.ok) {
			match.stop();
			res.status(500).json({ matchId: match.id, error: running.error });
			return;
		}
		res.status(201).json({
			matchId: match.id,
			epoch: match.epoch,
			seats: match.seats.map((s) => ({ seat: s.seat, kind: s.ai ? 'ai' : 'human', deck: s.deck })),
		});
	});

	router.get('/matches/:id', (req: Request, res: Response) => {
		const match = matches.get(String(req.params.id));
		if (match === undefined) {
			res.status(404).json({ error: 'no such match' });
			return;
		}
		res.json({
			matchId: match.id,
			status: match.status,
			failure: match.failure,
			winner: match.winner,
			seats: match.seats.map((s) => ({
				seat: s.seat,
				kind: s.ai ? 'ai' : 'human',
				deck: s.deck,
				// The digest handle only — never the id itself.
				claimedBy: s.owner === null ? null : participantHandle(s.owner),
			})),
		});
	});

	if (deps.probe === true) {
		router.post('/matches/:id/probe', async (req: Request, res: Response) => {
			const match = matches.get(String(req.params.id));
			const body = (req.body ?? {}) as { seat?: unknown; message?: unknown };
			if (match === undefined || match.status !== 'running') {
				res.status(404).json({ error: 'no running match with that id' });
				return;
			}
			const seat = body.seat;
			if (typeof seat !== 'number' || match.seats[seat] === undefined || match.seats[seat]?.ai === true) {
				res.status(400).json({ error: 'seat is a human seat index' });
				return;
			}
			const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'Probe: answer me';
			res.json(await match.probe(seat, message, deps.askTimeoutMs ?? 10 * 60_000));
		});

		// The seat's state as the server holds it, to diff against a browser's.
		// It is that seat's hand: dev only, like everything behind this flag.
		router.get('/matches/:id/seats/:seat/state', (req: Request, res: Response) => {
			const match = matches.get(String(req.params.id));
			if (match === undefined) {
				res.status(404).json({ error: 'no such match' });
				return;
			}
			const result = match.seatState(Number(req.params.seat));
			res.status('error' in result ? 404 : 200).json(result);
		});
	}

	api.use('/play', router);

	/* ── Socket ─────────────────────────────────────────────────────── */

	io.engine.use(edgeProvenance);
	io.use((socket, next) => {
		const tier = handshakeTier(socket.request.headers);
		if (rankOf(tier) < rankOf(deps.minTier)) {
			next(new Error('not found'));
			return;
		}
		next();
	});

	function identityOf(socket: Socket): ParticipantId {
		const headers = socket.request.headers;
		if (devIdentity) {
			const auth = socket.handshake.auth as Record<string, unknown> | undefined;
			const fromAuth = typeof auth?.devUser === 'string' ? auth.devUser : undefined;
			const fromQuery = socket.handshake.query.devUser;
			const devUser = fromAuth ?? (typeof fromQuery === 'string' ? fromQuery : undefined);
			if (devUser !== undefined && DEV_USER.test(devUser)) {
				return identityFromHeaders({ ...headers, 'x-user-id': `local-dev-seat-${devUser}` }, socket.id);
			}
		}
		return identityFromHeaders(headers, socket.id);
	}

	io.on('connection', (socket) => {
		const participantId = identityOf(socket);
		/** matchId → seat, for this connection. */
		const joined = new Map<string, number>();

		async function snapshotFor(raw: unknown, isJoin: boolean): Promise<MatchSnapshot | MatchError> {
			const request = parseMatchRequest(raw);
			if (!request.ok) return { error: `malformed: ${request.errors[0]?.path ?? '$'} ${request.errors[0]?.message ?? ''}` };
			const match = matches.get(request.value.matchId);
			if (match === undefined) return { error: 'unknown-match' };

			let seat = joined.get(match.id) ?? null;
			if (seat === null) {
				if (!isJoin) return { error: 'not-joined' };
				const claim = match.claim(participantId);
				if (!claim.ok) return { error: claim.error };
				seat = claim.seat;
				const room = roomFor(match);
				joinRoom<PlayApp, PlayClient>(room, socket.id, socket.id, participantId, () => ({ seat: seat as number }));
				await socket.join(room.roomId);
				joined.set(match.id, seat);
				log({ evt: 'joined', matchId: match.id, seat, participantId, fresh: claim.fresh });
				// A refresh: the old socket's close armed an abort of this seat's asks.
				match.seatConnected(seat);
			}
			if (match.status === 'starting') {
				const running = await match.whenRunning(joinWaitMs);
				if (!running.ok) return { error: running.error };
			}
			return match.snapshot(seat);
		}

		function answer(event: 'join' | 'resync') {
			return (raw: unknown, ack?: unknown): void => {
				if (typeof ack !== 'function') {
					log({ evt: 'no-ack', event, participantId });
					return;
				}
				void snapshotFor(raw, event === 'join').then((result) => {
					(ack as (r: unknown) => void)(result);
					if ('frames' in result) {
						// After the ack, so the client has adopted the snapshot's cursor
						// before the next frame reaches it.
						matches.get(result.matchId)?.resendAfterSnapshot(result.seat);
					}
				});
			};
		}

		socket.on(MATCH_EVENTS.join, answer('join'));
		socket.on(MATCH_EVENTS.resync, answer('resync'));

		socket.on(MATCH_EVENTS.clientToServer, (raw: unknown) => {
			const parsed = parseClientEnvelope(raw);
			if (!parsed.ok) {
				log({ evt: 'c2s-malformed', participantId, errors: parsed.errors.slice(0, 3) });
				return;
			}
			const match = matches.get(parsed.value.matchId);
			const seat = match === undefined ? undefined : joined.get(match.id);
			if (match === undefined || seat === undefined) {
				log({ evt: 'c2s-not-joined', participantId, matchId: parsed.value.matchId });
				return;
			}
			const outcome = match.fromClient(seat, parsed.value.frame);
			if (!outcome.ok) {
				log({ evt: 'c2s-refused', participantId, matchId: match.id, seat, error: outcome.error, kind: parsed.value.frame.kind });
			}
		});

		// Wave 19 lane C: the escape hatch. A preference of the person in the
		// seat — it carries nothing about the game, and a seat may only set its
		// own (the seat is the one `claim` bound, never a payload's).
		socket.on(MATCH_EVENTS.fullControl, (raw: unknown) => {
			const parsed = parseFullControl(raw);
			if (!parsed.ok) {
				log({ evt: 'full-control-malformed', participantId, errors: parsed.errors.slice(0, 3) });
				return;
			}
			const match = matches.get(parsed.value.matchId);
			const seat = match === undefined ? undefined : joined.get(match.id);
			if (match === undefined || seat === undefined) {
				log({ evt: 'full-control-not-joined', participantId, matchId: parsed.value.matchId });
				return;
			}
			const outcome = match.setFullControl(seat, parsed.value.on);
			if (!outcome.ok) log({ evt: 'full-control-refused', participantId, matchId: match.id, seat, error: outcome.error });
		});

		socket.on('disconnect', (reason: string) => {
			for (const [matchId, seat] of joined) {
				const match = matches.get(matchId);
				if (match === undefined) continue;
				const room = roomFor(match);
				leaveRoom<PlayApp, PlayClient>(room, socket.id);
				const stillHere = [...room.clients.values()].some((c) => c.app.seat === seat);
				log({ evt: 'left', matchId, seat, participantId, reason, stillHere });
				if (!stillHere) match.seatDisconnected(seat);
			}
		});
	});

	return {
		matches,
		close(): void {
			matches.stopAll();
			deps.host?.close?.();
		},
	};
}
