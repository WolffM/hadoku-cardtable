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
 *
 * ## A refusal that a player can read (Wave 22 §E)
 *
 * `forge:join` used to answer `{ error: 'unknown-match' }` and the client put
 * that string on the page — *"forge:join was refused: unknown-match"*, which is
 * what the operator was left looking at when a deploy killed their game. Two
 * things were wrong with it: it did not say what had happened, and it was
 * indistinguishable from every other refusal, so the client could not treat it
 * differently.
 *
 * So a refusal that means **the match is gone** now carries two more fields:
 *
 *     { error: 'unknown-match', outcome: 'match-gone', message: '<words>' }
 *
 * `error` is unchanged — it is still the machine code, and the browser bridge
 * (`browser/session.ts`) still answers exactly that shape — so nothing that
 * only reads `error` changes behaviour. `outcome` is what the client keys off
 * (`match-gone`, one of the six states lane F renders) and `message` is what it
 * shows. **Every OTHER refusal keeps the bare `{ error }` shape it always had**:
 * a client that has not learned the new fields keeps working for `match-full`,
 * `not-joined` and a malformed request, and only `match-gone` needs it to have.
 * `MatchErrorSchema` is `.strict()` in both mirrors, so a client's mirror must
 * allow the two fields before it can parse a `match-gone`.
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
import { AVATAR_ID_MAX } from '../room/lobby.js';
import { namedStopPolicy, STOP_POLICY_NAMES, type StopPolicy } from './auto.js';
import { MAX_CONCURRENT_MATCHES, type MatchHostFactory, type MatchSpec, type ReapResult } from './host.js';
import { createMatchRegistry, type Match, type MatchRegistry, type MatchSpecWithIdentity } from './match.js';
import {
	fullControlEcho,
	MATCH_EVENTS,
	parseClientEnvelope,
	parseFullControl,
	parseMatchRequest,
	parseStopPreference,
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
	/**
	 * How long a match taken back from an earlier server waits for somebody to
	 * rejoin before it is stopped. Default 5 minutes (`createMatchRegistry`).
	 */
	rejoinGraceMs?: number;
}

export interface PlayHandle {
	matches: MatchRegistry;
	/** Stop every match (each stops its JVM), and release the host's spare. */
	close(): void;
	/**
	 * SIGTERM. Stop accepting new matches, leave every live one running for the
	 * next process, and tell the seats of any that cannot be left running.
	 * Returns what happened, for the shutdown log — `reaped` is the JVMs this
	 * process killed on the way out, which is the half nothing did before wave 22
	 * lane U (see `host.ts`, "Going down").
	 */
	shutdown(reason: string): { handed: string[]; ended: string[]; reaped: ReapResult };
}

/**
 * Why a join or resync was refused, and the words for it. See the module header:
 * `match-gone` carries `outcome` and `message`; everything else stays the bare
 * `{ error }` a client already understands.
 */
export type MatchRefusal = MatchError & { outcome?: 'match-gone'; message?: string };

/** What a player is told when the match they are asking for is not there any more. */
export const MATCH_GONE_WORDS =
	'This match is no longer running on the server — it ended when the server restarted or when Forge stopped. Nothing you did caused it. Start a new match to play again.';

/** The `match-gone` refusal: the code the wire always carried, plus the outcome and the words. */
function matchGone(message = MATCH_GONE_WORDS): MatchRefusal {
	return { error: 'unknown-match', outcome: 'match-gone', message };
}

/**
 * Does this participant hold a seat in this match that has a board to return?
 * A finished match is still worth rejoining for someone who was playing it —
 * they get the board and the notice that ended it. For anyone else it is gone.
 */
function hasBoard(match: Match, participantId: ParticipantId): boolean {
	const seat = match.seatOf(participantId);
	return seat !== null && match.seats[seat]?.playerId !== null;
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

/**
 * The per-seat identity's own two-state rule, item 4 (wave 29 §B —
 * `D-avatar-field.md` §3): a non-blank string of at most `AVATAR_ID_MAX`
 * characters, or absent — never `null`, never `''`.
 *
 * Re-implemented here rather than imported: the lobby's own normalizer
 * (`avatarIdOf` in `room/lobby.ts`) is not exported and `lobby.ts` is not this
 * lane's file to change, so only its exported limit is reused. By the time an
 * `avatarId` reaches this function it has usually already been through that
 * one (`routes.ts`'s `startFromRoom` reads it off a `RoomViewLike` member,
 * which the lobby already normalized) — this is the defensive copy for the
 * one request path (`POST /play/matches` itself) that reaches `parseStartBody`
 * without going through the lobby at all.
 */
function normalizeAvatarId(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const trimmed = v.trim();
	return trimmed === '' || trimmed.length > AVATAR_ID_MAX ? undefined : trimmed;
}

/** The longest seat name Forge is shown (wave 31 §S). */
export const SEAT_NAME_MAX = 24;

/**
 * A caller-supplied seat name, made safe to hand Forge as a player's name and to
 * draw anywhere: markup and control characters removed, whitespace collapsed,
 * at most {@link SEAT_NAME_MAX} characters. Absent (`undefined`) when nothing
 * printable is left, so the caller falls back to `Seat N`.
 */
export function sanitizeSeatName(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const cleaned = v
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/[<>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, SEAT_NAME_MAX)
		.trim();
	return cleaned === '' ? undefined : cleaned;
}

/** Two seats' names, unique within the match: the second gets ` 2` (kept inside the limit). */
function uniqueSeatNames(names: [string | undefined, string | undefined]): [string | undefined, string | undefined] {
	const [a, b] = names;
	if (a === undefined || b === undefined || a.toLowerCase() !== b.toLowerCase()) return names;
	return [a, `${b.slice(0, SEAT_NAME_MAX - 2).trimEnd()} 2`];
}

/**
 * `POST /play/matches` body: `{ opponent?: 'human' | 'ai', decks?: [dck | null, dck | null], avatarIds?: [string?, string?], names?: [string?, string?] }`.
 *
 * `names` (wave 31 §S) is what Forge shows for each seat, in seat order — see
 * {@link sanitizeSeatName}. Unlike `avatarIds` it IS the Forge player's name,
 * so Forge's own prompt text says it too; absent, the seat is `Seat N`.
 *
 * `avatarIds` is item 4's server half (wave 29 §B): the per-seat identity
 * `routes.ts`'s `startFromRoom` carries in the same seat order as `decks`,
 * when a match starts from a room. Carried on the spec beside `deck` and
 * `ai` — never on `seats[].name`, which is what Forge renders to both seats —
 * via {@link MatchSpecWithIdentity} (`match.ts`'s header has the argument for
 * why that type lives there and not on `host.ts`'s `SeatSpec`).
 */
export function parseStartBody(body: unknown): { ok: true; spec: MatchSpec } | { ok: false; error: string } {
	const b = (body ?? {}) as Record<string, unknown>;
	if (typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'body must be an object' };
	for (const key of Object.keys(b)) {
		if (key !== 'opponent' && key !== 'decks' && key !== 'avatarIds' && key !== 'names') return { ok: false, error: `unknown field ${key}` };
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
	let avatarIds: [string | undefined, string | undefined] = [undefined, undefined];
	if (b.avatarIds !== undefined) {
		const raw = b.avatarIds;
		if (!Array.isArray(raw) || raw.length !== 2) return { ok: false, error: 'avatarIds is a two-element array' };
		avatarIds = [normalizeAvatarId(raw[0]), normalizeAvatarId(raw[1])];
	}
	let names: [string | undefined, string | undefined] = [undefined, undefined];
	if (b.names !== undefined) {
		const raw = b.names;
		if (!Array.isArray(raw) || raw.length !== 2) return { ok: false, error: 'names is a two-element array' };
		names = uniqueSeatNames([sanitizeSeatName(raw[0]), sanitizeSeatName(raw[1])]);
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
	// Read off THIS server's environment, which is the whole of the subtlety:
	// the variable has to be set on the process that starts the match. Wave 20
	// set it on `e2e/harness.ts`'s server — the one started deliberately without
	// `CARDTABLE_FORGE_JAR` — so it seeded nothing for a week, and `play.spec.ts`
	// went on dealing a fresh game every run while its own comments said
	// otherwise. It now rides on the play stack's server (`e2e/play/harness.ts`).
	//
	// Unset in production, which is every deployment: this is the test hatch,
	// and an unseeded match is what it falls back to.
	const seedRaw = process.env.CARDTABLE_PLAY_SEED;
	const seed = seedRaw === undefined || seedRaw === '' ? Number.NaN : Number(seedRaw);
	// `MatchSpecWithIdentity`, not `MatchSpec`, so `avatarId` can sit on each
	// seat beside `deck` and `ai` without the excess-property check a literal
	// typed directly as `MatchSpec` would fail. Returned as `spec: MatchSpec`
	// below anyway (it satisfies that narrower type structurally), because
	// `host.ts`'s own type is not this lane's to widen — see `match.ts`'s
	// header on `SeatSpecWithIdentity`.
	const spec: MatchSpecWithIdentity = {
		seats: [
			// Forge shows these names to both seats. Wave 31 §S: they are the room's
			// display names when the caller sent `names`, and `Seat N` otherwise.
			// `avatarId` is spread rather than assigned, so a seat with none has the
			// key ABSENT on the spec too — the same discipline `Match.seatIdentities`
			// keeps on the way out (D-avatar-field.md §3).
			{
				name: names[0] ?? 'Seat 1',
				ai: false,
				deck: decks[0] as string | null,
				...(avatarIds[0] === undefined ? {} : { avatarId: avatarIds[0] }),
				...(names[0] === undefined ? {} : { displayName: names[0] }),
			},
			{
				name: names[1] ?? (opponent === 'ai' ? 'Forge AI' : 'Seat 2'),
				ai: opponent === 'ai',
				deck: decks[1] as string | null,
				...(avatarIds[1] === undefined ? {} : { avatarId: avatarIds[1] }),
				...(names[1] === undefined ? {} : { displayName: names[1] }),
			},
		],
		...(Number.isFinite(seed) ? { seed } : {}),
	};
	return { ok: true, spec };
}

/**
 * The variable that names the {@link StopPolicy} a new match's seats start on.
 *
 * Deliberately shaped after `CARDTABLE_PLAY_SEED` above: read off THIS
 * server's environment, unset in production, and there so that a test — or a
 * screenshot — can pin behaviour the product path otherwise decides for
 * itself.
 */
export const STOP_POLICY_ENV = 'CARDTABLE_PLAY_STOP_POLICY';

/**
 * What `CARDTABLE_PLAY_STOP_POLICY` selects, or null when the hatch is shut.
 *
 * Wave 26 §E gave every seat its own `StopPolicy` and left nothing able to
 * choose one: the values are module constants in `auto.ts`, so a caller outside
 * a unit test could not name one. The visible cost was that no spec and no
 * screenshot could catch a mana payment — `DEFAULT_STOP_POLICY`'s
 * `unambiguousPayment: 'forgeAuto'` has the server press Forge's own Auto the
 * moment the window opens, so the browser is never shown the ask.
 *
 * Three states, and the third is the point:
 *
 *  - **unset or empty** → `null`. Production, and every deployment. Seats start
 *    on `DEFAULT_STOP_POLICY`, which `socket.test.ts` asserts.
 *  - **a known name** → that policy. `strictPayment` is `STRICT_PAYMENT_POLICY`,
 *    where a payment is the player's to click; `everyPriority` is the stop
 *    behaviour that was the default until wave 28 adopted Arena's stop set
 *    (item 5), which is what a run wanting a window in every phase now asks for.
 *    `arena` still resolves and now names the default.
 *  - **an unknown name** → `{ name, policy: null }`, so `attachPlay` can LOG
 *    the typo. Falling back silently would play the whole match under the
 *    default the operator was trying to move off, and the screenshot would be
 *    of nothing — the exact failure mode `CARDTABLE_PLAY_SEED` spent a week in
 *    when it was set on a server that could not start Forge.
 */
export function parseStopPolicyEnv(env: NodeJS.ProcessEnv = process.env): { name: string; policy: StopPolicy | null } | null {
	const raw = env[STOP_POLICY_ENV];
	if (raw === undefined || raw.trim() === '') return null;
	const name = raw.trim();
	return { name, policy: namedStopPolicy(name) };
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

	// The stop-policy hatch, read once at attach and logged either way, because a
	// silent one is worth nothing: a run under a policy the operator did not ask
	// for looks identical to a run under the one they did.
	const selected = parseStopPolicyEnv();
	if (selected !== null && selected.policy === null) {
		log({ evt: 'stop-policy-unknown', env: STOP_POLICY_ENV, name: selected.name, known: STOP_POLICY_NAMES });
	} else if (selected !== null && selected.policy !== null) {
		log({
			evt: 'stop-policy-selected',
			env: STOP_POLICY_ENV,
			name: selected.name,
			unambiguousPayment: selected.policy.unambiguousPayment,
			unpayableCost: selected.policy.unpayableCost,
			skipNonStopPhases: selected.policy.skipNonStopPhases,
		});
	}
	const startingStopPolicy = selected?.policy ?? null;

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

	/** Set by `shutdown`: this process is going away, so it starts nothing new. */
	let draining: string | null = null;

	const attach = deps.host?.attach;
	const matches = createMatchRegistry({
		host: (id, spec, events) => {
			if (deps.host === null) throw new Error('no Forge host is configured');
			return deps.host(id, spec, events);
		},
		...(attach === undefined ? {} : { attach: (record, events) => attach(record, events) }),
		...(startingStopPolicy === null ? {} : { stopPolicy: startingStopPolicy }),
		rejoinGraceMs: deps.rejoinGraceMs,
		log,
		askTimeoutMs: deps.askTimeoutMs ?? 10 * 60_000,
		overGraceMs: deps.overGraceMs ?? 10 * 60_000,
		disconnectGraceMs: deps.disconnectGraceMs ?? 30_000,
		seatsChanged: (match, seats) => {
			// Wave 32, Q6: a seat's avatar changed mid-match. Every socket in the match
			// — both seats, and spectators — gets the new roster on the event a join
			// already carries (`forge:seats`), so the board and the chat agree again.
			io.to(roomFor(match).roomId).emit('forge:seats', { matchId: match.id, seats });
		},
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
		// A match started now would be handed a JVM this process is about to stop
		// watching, and its seats would never be told. Refused in words instead.
		if (draining !== null) {
			res.status(503).json({ error: draining });
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

	/*
	 * Wave 31 §S — ONE controlling socket per seat.
	 *
	 * Two browsers on an account that holds a seat are two roster entries, and
	 * only one of them may act: *"it would be really messy if two clients were
	 * capable of performing game actions"*. The first connection to claim a seat
	 * controls it; a later one for the same seat joins as a spectator (it still
	 * sees the seat's own hand — it is the same person's — but the server refuses
	 * its three inputs). `connected` is the seat's sockets in connect order, so
	 * the longest-connected spectator is the one promoted when the controller
	 * leaves. A refresh takes this same path: its new socket may open before the
	 * old one's `disconnect` lands, spectates for that moment, and is promoted.
	 */
	const connected = new Map<string, string[]>();
	const seatKey = (matchId: string, seat: number): string => `${matchId}#${seat}`;
	const isController = (matchId: string, seat: number, socketId: string): boolean =>
		connected.get(seatKey(matchId, seat))?.[0] === socketId;
	const tellRole = (target: { emit: (event: string, payload: unknown) => unknown }, matchId: string, role: 'player' | 'spectator'): void => {
		target.emit(MATCH_EVENTS.role, { matchId, role });
	};

	io.on('connection', (socket) => {
		const participantId = identityOf(socket);
		/** matchId → seat, for this connection. */
		const joined = new Map<string, number>();

		async function snapshotFor(raw: unknown, isJoin: boolean): Promise<MatchSnapshot | MatchRefusal> {
			const request = parseMatchRequest(raw);
			if (!request.ok) return { error: `malformed: ${request.errors[0]?.path ?? '$'} ${request.errors[0]?.message ?? ''}` };
			const match = matches.get(request.value.matchId);
			// The registry has never heard of it. Either it never existed, or — the
			// case that actually happens — it died with an earlier process.
			if (match === undefined) {
				log({ evt: 'match-gone', matchId: request.value.matchId, participantId, event: isJoin ? 'join' : 'resync' });
				return matchGone();
			}
			// It is here, and it is finished. A seat that has a board still gets it
			// (with the notice the ending already put on its stream); one that has
			// none has nothing to come back to, and saying `match-starting` to it —
			// which is what `snapshot` would say — is a lie.
			if ((match.status === 'failed' || match.status === 'stopped') && !hasBoard(match, participantId)) {
				log({ evt: 'match-gone', matchId: match.id, status: match.status, participantId, event: isJoin ? 'join' : 'resync' });
				return matchGone(
					match.failure === null
						? 'This match has ended. Start a new match to play again.'
						: `This match ended and cannot continue: ${match.failure.split('; see ')[0]}. Start a new match to play again.`,
				);
			}

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
				const key = seatKey(match.id, seat);
				const sockets = connected.get(key) ?? [];
				sockets.push(socket.id);
				connected.set(key, sockets);
				log({ evt: 'joined', matchId: match.id, seat, participantId, fresh: claim.fresh, role: sockets[0] === socket.id ? 'player' : 'spectator' });
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
						const match = matches.get(result.matchId);
						if (match === undefined) return;
						// After the ack, so the client has adopted the snapshot's cursor
						// before the next frame reaches it.
						match.resendAfterSnapshot(result.seat);
						/*
						 * And the seat's full-control state, on its own event, to THIS
						 * socket only — the same "what a fresh page needs that the state
						 * channel does not carry" as the prompt and the bar above.
						 *
						 * It is not in `MatchSnapshot` because the snapshot's schema is
						 * mirrored in two packages (`transport.ts`'s header) and this
						 * event already exists, with a payload that is identical in both
						 * directions; the client applies it in `match.ts`. Without it a
						 * refresh drew the toggle off while this seat was still in full
						 * control, and only the next click re-synced it.
						 *
						 * Sent on every join and every resync, and always — `on: false`
						 * as well — so a client that has the flag on and a server that
						 * does not is corrected too, in the one direction that is the
						 * server's to settle.
						 */
						socket.emit(MATCH_EVENTS.fullControl, fullControlEcho(result.matchId, match.fullControl(result.seat)));
						/*
						 * Item 4's server half (wave 29 §B): every seat's identity, on its
						 * own event and for the same reason `forge:full-control` is —
						 * `MatchSnapshotSchema` is `.strict()` and mirrored byte for byte in
						 * `apps/ui/src/play/live/transport.ts`, so folding a new key into it
						 * is a change to a file no lane owns this wave. `Match.seatIdentities`
						 * has the full argument. Sent on every join and every resync, to
						 * THIS socket, both seats always (an avatar is not hidden
						 * information, the same reasoning `routes.ts`'s `tableView` uses).
						 *
						 * Not `MATCH_EVENTS.*` — that map is `transport.ts`'s, and this event
						 * is new this wave. `apps/ui/src/play/live/transport.ts` (lane A's
						 * file) is where the client-side name and schema for `forge:seats`
						 * are adopted; the payload shape is `{ matchId, seats: SeatIdentity[] }`.
						 */
						socket.emit('forge:seats', { matchId: result.matchId, seats: match.seatIdentities() });
						// Wave 31 §S: and whether THIS socket controls the seat, every time.
						tellRole(socket, result.matchId, isController(result.matchId, result.seat, socket.id) ? 'player' : 'spectator');
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
			if (!isController(match.id, seat, socket.id)) {
				log({ evt: 'c2s-spectator', participantId, matchId: match.id, seat, input: 'c2s', kind: parsed.value.frame.kind });
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
			if (!isController(match.id, seat, socket.id)) {
				log({ evt: 'c2s-spectator', participantId, matchId: match.id, seat, input: 'full-control' });
				return;
			}
			const outcome = match.setFullControl(seat, parsed.value.on);
			if (!outcome.ok) log({ evt: 'full-control-refused', participantId, matchId: match.id, seat, error: outcome.error });
		});

		/*
		 * Wave 30 §B item 2/6: *"always stop at end step — default off"*, moved
		 * through the per-seat `StopPolicy` that already exists (wave 26 §E) rather
		 * than a second mechanism. This does not REPLACE the seat's policy — it
		 * reads the CURRENT one and toggles `END_OF_TURN` in or out of
		 * `stopOnTheirTurn`, so any other preference already on the seat (a name
		 * from `CARDTABLE_PLAY_STOP_POLICY`, or a later field nobody has added yet)
		 * survives the toggle untouched.
		 */
		socket.on(MATCH_EVENTS.stopPreference, (raw: unknown) => {
			const parsed = parseStopPreference(raw);
			if (!parsed.ok) {
				log({ evt: 'stop-preference-malformed', participantId, errors: parsed.errors.slice(0, 3) });
				return;
			}
			const match = matches.get(parsed.value.matchId);
			const seat = match === undefined ? undefined : joined.get(match.id);
			if (match === undefined || seat === undefined) {
				log({ evt: 'stop-preference-not-joined', participantId, matchId: parsed.value.matchId });
				return;
			}
			if (!isController(match.id, seat, socket.id)) {
				log({ evt: 'c2s-spectator', participantId, matchId: match.id, seat, input: 'stop-preference' });
				return;
			}
			const current = match.stopPolicy(seat);
			const wants = parsed.value.stopAtEndStep;
			const has = current.stopOnTheirTurn.includes('END_OF_TURN');
			if (wants === has) return;
			const stopOnTheirTurn = wants ? [...current.stopOnTheirTurn, 'END_OF_TURN' as const] : current.stopOnTheirTurn.filter((p) => p !== 'END_OF_TURN');
			const outcome = match.setStopPolicy(seat, { ...current, stopOnTheirTurn });
			if (!outcome.ok) log({ evt: 'stop-preference-refused', participantId, matchId: match.id, seat, error: outcome.error });
		});

		socket.on('disconnect', (reason: string) => {
			for (const [matchId, seat] of joined) {
				// Before the match lookup: a socket must leave the seat's line even
				// when its match is gone, or a stale id would hold the control.
				const key = seatKey(matchId, seat);
				const line = connected.get(key) ?? [];
				const wasController = line[0] === socket.id;
				const remaining = line.filter((id) => id !== socket.id);
				if (remaining.length === 0) connected.delete(key);
				else connected.set(key, remaining);
				const match = matches.get(matchId);
				if (match === undefined) continue;
				const room = roomFor(match);
				leaveRoom<PlayApp, PlayClient>(room, socket.id);
				const stillHere = [...room.clients.values()].some((c) => c.app.seat === seat);
				log({ evt: 'left', matchId, seat, participantId, reason, stillHere });
				if (!stillHere) match.seatDisconnected(seat);
				const next = remaining[0];
				if (wasController && next !== undefined) {
					// The longest-connected spectator takes the seat, is told, and is
					// re-sent what a controller needs (the asks, the open selection).
					log({ evt: 'spectator-promoted', matchId, seat, socketId: next });
					const promoted = io.sockets.sockets.get(next);
					if (promoted !== undefined) tellRole(promoted, matchId, 'player');
					match.resendAfterSnapshot(seat);
				}
			}
		});
	});

	/* ── Matches an earlier server left running (Wave 22 §E) ────────── */
	//
	// Last, and inside `attachPlay` rather than in `index.ts`, because a resumed
	// match must be in the registry AND have its room before a single client can
	// ask for it — which is exactly the ordering `create` above keeps. The host
	// offers each orphan once; anything not taken here it kills on its own
	// deadline, so an `attach` that throws costs one match, not a leaked JVM.
	for (const record of deps.host?.orphans?.() ?? []) {
		try {
			const match = matches.adopt(record);
			if (match === null) {
				log({ evt: 'match-not-adopted', matchId: record.matchId, reason: 'the host cannot re-attach' });
				continue;
			}
			roomFor(match);
			log({
				evt: 'match-adopted',
				matchId: match.id,
				pid: record.pid,
				status: match.status,
				orphanedAt: record.orphanedAt ?? null,
				seats: match.seats.map((s) => ({ seat: s.seat, claimed: s.owner !== null, playerId: s.playerId })),
			});
		} catch (err) {
			log({ evt: 'match-adopt-failed', matchId: record.matchId, error: (err as Error).message });
		}
	}

	return {
		matches,
		close(): void {
			matches.stopAll();
			deps.host?.close?.();
		},
		shutdown(reason: string): { handed: string[]; ended: string[]; reaped: ReapResult } {
			draining = reason;
			const { handed, ending } = matches.handOver();
			// `MatchRegistry.handOver` only CONSIDERS a match that is `starting` or
			// `running`, so one that had already finished — status `over`, where it sits
			// for `overGraceMs`, ten minutes below — was in neither list, and nothing
			// stopped it. That is the leak lane S found: a Forge JVM outliving the
			// server with no `orphanedAt`, so no successor would adopt it either.
			// Whatever we are not handing over we are ending, whatever status it ended
			// in; the status a match stopped in is not its JVM's business.
			const kept = new Set<Match>([...handed, ...ending]);
			const ended = [...ending, ...matches.active().filter((m) => !kept.has(m))];
			for (const match of ended) match.serverStopping(reason);
			for (const match of ended) match.stop();
			// The spare holds no game, so it is stopped either way.
			deps.host?.close?.();
			// And then the last word, because asking is measurably not enough: a real
			// match's JVM takes ~9.3 s to honour `{"t":"stop"}` and this process has
			// about a millisecond left. See `host.ts`, "Going down".
			const reaped = deps.host?.reapOnExit?.() ?? { killed: [], kept: [], left: [] };
			return { handed: handed.map((m) => m.id), ended: ended.map((m) => m.id), reaped };
		},
	};
}
