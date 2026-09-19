/**
 * The constructed table's HTTP surface, and the gate in front of play's start
 * route. `attachTables` is the one call `src/index.ts` makes.
 *
 * ## Routes
 *
 * All on the `api` router `index.ts` mounts behind `requireMinTier`, so every
 * one of them is behind the same friend-tier floor as everything else. There is
 * no public tier here and nothing to configure one.
 *
 *   GET  /api/tables/formats               the frozen Standard pools, oldest first
 *   GET  /api/tables/decks                 the deck library, with each list
 *   POST /api/tables/check                 `{ deck, rules }` → the verdict, without starting anything
 *   GET  /api/tables/rooms/:roomId         both players' state at a room's table
 *   PUT  /api/tables/rooms/:roomId/deck    `{ deck, rules }` → check MY deck and hold it
 *   POST /api/tables/rooms/:roomId/ready   `{ ready }` → I am (not) ready
 *   POST /api/play/matches                 GATED: see below
 *
 * ## A table belongs to a room, and each player loads their OWN deck
 *
 * Wave 13's inversion (`docs/handoff/w13.md` §C). Before it, one person chose
 * BOTH decks and sent them in one call, because that is the shape Forge needs
 * at launch; the operator's verdict on that was *"this is not how any of this
 * should work"*. So the room holds per-player state — a checked deck and a
 * ready flag, one per member — and the server assembles the two decks once both
 * players are ready. Nobody can name anybody else's deck: `PUT …/deck` writes
 * the CALLER's slot, found by `identityFromHeaders`, and there is no field in
 * any body that names a member.
 *
 * **The deck is checked when it is loaded, and that verdict is what starts the
 * match.** Not re-checked at start, and deliberately: a `{ kind: 'draft' }`
 * rule resolves the pool of whoever made the request, so re-checking at start
 * would check the other player's deck against the starter's pool — "you have no
 * seat in draft …" for a deck that was legal when its owner loaded it. What
 * goes to Forge is the stored text, byte for byte the text the gate validated,
 * so there is still exactly one reader (§C.4).
 *
 * ## The gate sits on play's own route, not beside it
 *
 * A second "start a match" endpoint would be a second thing to keep correct —
 * the concurrency cap, the 503 when Forge is absent — so there is none. Instead
 * this mounts a handler on the SAME path, ahead of play's, and every request to
 * it goes through the gate first:
 *
 *   - `{ room: roomId }` — the product's body. The caller must be a member; the
 *     room's two players must each have loaded a legal deck and readied up. The
 *     body is rewritten to play's own `{ opponent: 'human', decks: [a, b] }`,
 *     the match id is captured from play's answer, and the two seats are
 *     CLAIMED for those two members in deck order before the response is sent
 *     (`Match.claim` is otherwise first-come-first-served, so seat 1 would go to
 *     whoever's browser arrived first — which is not necessarily the person
 *     whose deck is in seat 1). Idempotent: a room that already has a live
 *     match answers that match rather than starting a second one.
 *   - `{ opponent: 'ai', seats: [{ deck, rules }, { deck, rules }] }` — one
 *     person against Forge's AI. Both decks are that one person's to choose,
 *     since the other seat is the AI, so this arm stays: it is what the deck
 *     builder starts a drafted deck with.
 *   - the same `seats` body against a HUMAN opponent — refused with **422**.
 *     That is the shape Wave 13 removed; a match against a person starts from a
 *     room.
 *   - play's raw body with a non-null `decks` entry — refused with 422. A deck
 *     nobody checked does not reach Forge by the side door.
 *   - play's raw body with no decks, or null decks — handed on untouched. Those
 *     are Forge's own random precons, which belong to no format of ours, and it
 *     is what the dev tooling and the Wave 9 live check send.
 *
 * **This makes mount order load-bearing**: `attachTables` must be called BEFORE
 * `attachPlay`, or play's handler answers first and the gate never runs. The
 * README's `index.ts` edit places it that way, and `tables.test.ts` mounts the
 * two in the same order against the real `attachPlay`.
 */

import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

import type { DraftRooms } from '../room/draftRooms.js';
import { viewForParticipant } from '../room/draftRooms.js';
import { identityFromHeaders } from '../room/identity.js';
import {
	checkSeat,
	parseSeatRequest,
	parseStartRequest,
	publicVerdict,
	refusalLine,
	type DeckRef,
	type DeckRules,
	type DraftPoolLookup,
	type GateContext,
	type SeatVerdict,
} from './gate.js';
import { loadTablesLibrary, type TablesLibrary } from './library.js';

export type TablesLog = (entry: Record<string, unknown>) => void;

/* ── the room, as this file needs it ─────────────────────────────────── */

/**
 * The part of lane A's `RoomView` a table reads. Written here as a structural
 * type on purpose: `apps/server/src/room/lobby.ts` is another lane's file and
 * was not on the branch when this was written, so this codes against the
 * manager-fixed A↔C contract rather than importing it. A's `Lobby` satisfies
 * this; `index.ts` passes it as `rooms`.
 */
export interface RoomViewLike {
	id: string;
	name: string;
	gameType: string;
	members: { id: string; name: string }[];
	matchId: string | null;
}

/** The subset of lane A's `Lobby` a table uses. */
export interface TablesRooms {
	get(roomId: string): RoomViewLike | undefined;
	/** Per-member state this file owns. `undefined` when unset, or no such room or member. */
	playerState(roomId: string, memberId: string): unknown;
	/** False when there is no such room, or `memberId` is not a member. */
	setPlayerState(roomId: string, memberId: string, state: unknown): boolean;
	/** False when there is no such room. */
	setMatch(roomId: string, matchId: string | null): boolean;
}

/** The subset of `play`'s `MatchRegistry` a table uses, for the same reason. */
export interface TablesMatches {
	get(id: string):
		| {
				status: string;
				claim(participantId: string): { ok: true; seat: number } | { ok: false; error: string };
				stop(): void;
		  }
		| undefined;
}

export interface TablesDeps {
	/** The repository root; decks are read from `<repoRoot>/decks`. */
	repoRoot: string;
	/** The server's draft rooms, for the `draft` rule. Null when no cube pool loaded. */
	draftRooms: DraftRooms | null;
	log?: TablesLog;
	/** Tests hand in a library directly. Production reads `repoRoot`. */
	library?: TablesLibrary;
	/**
	 * The room registry (lane A's `Lobby`). Optional: without it the room routes
	 * answer 404 and `{ room }` cannot start a match, which is exactly what a
	 * server with no rooms should say.
	 */
	rooms?: TablesRooms;
	/**
	 * Play's match registry, read lazily because `attachPlay` runs AFTER this —
	 * the mount order the gate depends on. Only used to bind the two players to
	 * the two seats their decks are in.
	 */
	matches?: () => TablesMatches | null;
}

export interface TablesHandle {
	library: TablesLibrary;
}

function defaultLog(entry: Record<string, unknown>): void {
	console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-tables', ...entry }));
}

/**
 * The caller's own drafted pool, found by their derived identity.
 *
 * The socket id argument is only reached when the edge named nobody, and then
 * the id is ephemeral and random, so it matches no seat — which is the right
 * answer for someone the edge could not name.
 */
function draftPoolFor(req: Request, rooms: DraftRooms | null): DraftPoolLookup | null {
	if (rooms === null) return null;
	return (draftId) => {
		const room = rooms.find(draftId);
		if (room === undefined) return { ok: false, error: `no draft ${JSON.stringify(draftId)} on this server` };
		const participant = identityFromHeaders(req.headers, `http-${randomUUID()}`);
		const view = viewForParticipant(room, participant);
		if (view.viewer.kind !== 'seat') return { ok: false, error: `you have no seat in draft ${JSON.stringify(draftId)}` };
		return { ok: true, pool: view.viewer.pool };
	};
}

/* ── what a room holds for each player ───────────────────────────────── */

/** The one game type a table is built for. `draft` rooms are a later wave. */
const CONSTRUCTED = 'constructed-1v1';

/** Two seats, because Forge's match is two seats. */
const TABLE_SEATS = 2;

/** The same answer for a room that does not exist and one you are not in. */
const NO_ROOM = 'no such room';

/**
 * One member's state at a table, as it is persisted through lane A's
 * `setPlayerState`. Opaque to the lobby, owned here, and read back defensively
 * (`readPlayerState`) because it survives a restart and a deploy.
 */
interface TablePlayerState {
	v: 1;
	/** The choice as the player sent it, so their picker can be restored. */
	choice: { deck: DeckRef; rules: DeckRules };
	/** The verdict the gate gave when the deck was loaded, without the text. */
	verdict: Omit<SeatVerdict, 'text'>;
	/** The checked `.dck`, byte for byte. Never sent to a browser. */
	text: string;
	ready: boolean;
	/** When this member first took a seat: the order the two players are in. */
	seatedAt: number;
}

function readPlayerState(raw: unknown): TablePlayerState | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const s = raw as Partial<TablePlayerState>;
	if (s.v !== 1 || typeof s.text !== 'string' || typeof s.seatedAt !== 'number') return null;
	if (typeof s.verdict !== 'object' || s.verdict === null || typeof s.verdict.legal !== 'boolean') return null;
	if (typeof s.choice !== 'object' || s.choice === null) return null;
	return { ...(s as TablePlayerState), ready: s.ready === true };
}

interface TablePlayer {
	member: { id: string; name: string };
	state: TablePlayerState;
}

/**
 * The (at most two) players at a room's table: the members who have loaded a
 * deck, earliest first. A third member who loads one is refused, so this never
 * has to choose between three.
 */
function playersOf(rooms: TablesRooms, room: RoomViewLike): TablePlayer[] {
	const held: TablePlayer[] = [];
	for (const member of room.members) {
		const state = readPlayerState(rooms.playerState(room.id, member.id));
		if (state !== null) held.push({ member, state });
	}
	return held.sort((a, b) => a.state.seatedAt - b.state.seatedAt);
}

export function attachTables(api: Router, deps: TablesDeps): TablesHandle {
	const log = deps.log ?? defaultLog;
	const library = deps.library ?? loadTablesLibrary(deps.repoRoot);
	log({ evt: 'library', formats: library.formats.length, decks: library.decks.length, faults: library.faults });

	const context = (req: Request): GateContext => ({ library, draftPool: draftPoolFor(req, deps.draftRooms) });

	/* ── the catalog ────────────────────────────────────────────────── */

	const tables = express.Router();
	tables.use(express.json({ limit: '256kb' }));

	tables.get('/formats', (_req: Request, res: Response) => {
		res.json({
			formats: library.formats.map((f) => ({
				id: f.id,
				name: f.fixture.name,
				effective: f.fixture.effective,
				sets: f.fixture.sets,
				banned: f.fixture.banned,
				cardCount: f.fixture.cards.length,
				source: f.fixture.source,
			})),
		});
	});

	tables.get('/decks', (_req: Request, res: Response) => {
		const list = (section: string, file: TablesLibrary['decks'][number]['deck']['file']) =>
			(file.sections.get(section) ?? []).map((e) => ({ count: e.count, name: e.card.name }));
		res.json({
			decks: library.decks.map((d) => ({
				id: d.id,
				collection: d.collection,
				name: d.deck.name,
				format: d.deck.format,
				date: d.deck.date,
				provenance: d.deck.provenance,
				citation: d.deck.citation,
				main: list('main', d.deck.file),
				sideboard: list('sideboard', d.deck.file),
			})),
		});
	});

	tables.post('/check', (req: Request, res: Response) => {
		const parsed = parseSeatRequest(req.body, 'body');
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		const verdict = checkSeat(parsed.value, context(req));
		if ('error' in verdict) {
			res.status(400).json({ error: verdict.error });
			return;
		}
		res.json(publicVerdict(verdict));
	});

	/* ── a room's table: one slot per player, each their own ────────── */

	const rooms = deps.rooms ?? null;

	/** The caller, by the derivation lane A mints `RoomMember.id` with. */
	const memberIdOf = (req: Request): string => identityFromHeaders(req.headers, `http-${randomUUID()}`);

	/**
	 * The room this caller may act in, or null. One answer covers "no such
	 * room" and "you are not in it": a different one would say which rooms
	 * exist to someone who is in none of them.
	 */
	function tableFor(req: Request, roomId: string): { room: RoomViewLike; me: string } | null {
		if (rooms === null) return null;
		const room = rooms.get(roomId);
		if (room === undefined) return null;
		const me = memberIdOf(req);
		if (!room.members.some((m) => m.id === me)) return null;
		return { room, me };
	}

	/**
	 * The room's match if it is still one you could play, and null otherwise —
	 * clearing a match id the registry has forgotten. Rooms persist across a
	 * restart and matches do not, so after a deploy every room that was playing
	 * holds the id of a match that no longer exists; without this, that room
	 * could never start another one.
	 */
	function liveMatchId(room: RoomViewLike): string | null {
		if (room.matchId === null) return null;
		const registry = deps.matches?.() ?? null;
		// No registry to ask: report what the room holds rather than clearing it.
		if (registry === null || rooms === null) return room.matchId;
		const match = registry.get(room.matchId);
		if (match !== undefined && match.status !== 'stopped' && match.status !== 'failed') return room.matchId;
		rooms.setMatch(room.id, null);
		log({ evt: 'room-match-cleared', room: room.id, matchId: room.matchId });
		return null;
	}

	/**
	 * What both players may see: who has chosen what, whether it is legal,
	 * whether they are ready.
	 *
	 * Your own verdict comes back in full, and someone else's as a count. A
	 * draft verdict names cards the other player did or did not draft, and a
	 * drafted pool is hidden information until the draft is over — the same
	 * reason `gate.ts` resolves a pool by the caller's identity and never by a
	 * seat number.
	 */
	function tableView(room: RoomViewLike, me: string): Record<string, unknown> {
		const players = rooms === null ? [] : playersOf(rooms, room);
		return {
			room: { id: room.id, name: room.name, gameType: room.gameType, matchId: liveMatchId(room), seats: TABLE_SEATS },
			you: { player: players.some((p) => p.member.id === me) },
			players: players.map((p, seat) => ({
				seat,
				name: p.member.name,
				you: p.member.id === me,
				deckName: p.state.verdict.deckName,
				rulesName: p.state.verdict.rulesName,
				legal: p.state.verdict.legal,
				issueCount: p.state.verdict.issues.length,
				ready: p.state.ready,
				verdict: p.member.id === me ? p.state.verdict : null,
				choice: p.member.id === me ? p.state.choice : null,
			})),
		};
	}

	/** Every room route answers this, and only this, when you may not act. */
	function notFound(res: Response): void {
		res.status(404).json({ error: NO_ROOM });
	}

	/** A table is a constructed 1v1 table, or it is not a table. */
	function wrongGameType(room: RoomViewLike, res: Response): boolean {
		if (room.gameType === CONSTRUCTED) return false;
		res.status(409).json({ error: `this room plays ${room.gameType}, not ${CONSTRUCTED}` });
		return true;
	}

	tables.get('/rooms/:roomId', (req: Request, res: Response) => {
		const found = tableFor(req, String(req.params.roomId));
		if (found === null) {
			notFound(res);
			return;
		}
		res.json(tableView(found.room, found.me));
	});

	tables.put('/rooms/:roomId/deck', (req: Request, res: Response) => {
		const found = tableFor(req, String(req.params.roomId));
		if (found === null || rooms === null) {
			notFound(res);
			return;
		}
		const { room, me } = found;
		if (wrongGameType(room, res)) return;
		if (liveMatchId(room) !== null) {
			res.status(409).json({ error: 'the match has already started' });
			return;
		}
		const parsed = parseSeatRequest(req.body, 'body');
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		const players = playersOf(rooms, room);
		const mine = players.find((p) => p.member.id === me);
		if (mine === undefined && players.length >= TABLE_SEATS) {
			res.status(409).json({ error: 'this table already has two players' });
			return;
		}
		const verdict = checkSeat(parsed.value, context(req));
		if ('error' in verdict) {
			res.status(400).json({ error: verdict.error });
			return;
		}
		// A new deck un-readies you: what you readied with is not what you hold.
		const state: TablePlayerState = {
			v: 1,
			choice: parsed.value,
			verdict: publicVerdict(verdict),
			text: verdict.text,
			ready: false,
			seatedAt: mine?.state.seatedAt ?? Date.now(),
		};
		if (!rooms.setPlayerState(room.id, me, state)) {
			notFound(res);
			return;
		}
		log({ evt: 'room-deck-loaded', room: room.id, deck: verdict.deckName, rules: verdict.rulesName, legal: verdict.legal });
		res.json(tableView(rooms.get(room.id) ?? room, me));
	});

	tables.post('/rooms/:roomId/ready', (req: Request, res: Response) => {
		const found = tableFor(req, String(req.params.roomId));
		if (found === null || rooms === null) {
			notFound(res);
			return;
		}
		const { room, me } = found;
		if (wrongGameType(room, res)) return;
		const body = (req.body ?? {}) as Record<string, unknown>;
		const keys = Object.keys(body);
		if (typeof body.ready !== 'boolean' || keys.some((k) => k !== 'ready')) {
			res.status(400).json({ error: 'body is { ready: boolean }' });
			return;
		}
		if (liveMatchId(room) !== null) {
			res.status(409).json({ error: 'the match has already started' });
			return;
		}
		const players = playersOf(rooms, room);
		const seat = players.findIndex((p) => p.member.id === me);
		const mine = players[seat];
		if (mine === undefined) {
			res.status(409).json({ error: 'load a deck before you ready up' });
			return;
		}
		// An illegal deck blocks THIS player's ready and nobody else's, and says
		// which card did it — the same sentence the gate refuses a match with.
		if (body.ready && !mine.state.verdict.legal) {
			const line = refusalLine(seat, { ...mine.state.verdict, text: mine.state.text });
			log({ evt: 'room-ready-refused', room: room.id, issues: mine.state.verdict.issues.length });
			res.status(422).json({ error: line, verdict: mine.state.verdict });
			return;
		}
		if (!rooms.setPlayerState(room.id, me, { ...mine.state, ready: body.ready })) {
			notFound(res);
			return;
		}
		log({ evt: 'room-ready', room: room.id, ready: body.ready });
		res.json(tableView(rooms.get(room.id) ?? room, me));
	});

	api.use('/tables', tables);

	/* ── the gate on play's start route ─────────────────────────────── */

	const gate = express.Router();
	gate.use(express.json({ limit: '256kb' }));

	/** Rooms whose start is in flight: two Ready buttons must not launch two JVMs. */
	const starting = new Set<string>();

	/**
	 * Bind the two players to the two seats their decks are in, before play's
	 * 201 goes out and so before any browser can join. `Match.claim` otherwise
	 * hands out the first free seat to whoever arrives first (`play/match.ts`
	 * `claim`), which would deal a player the other player's deck. Returns the
	 * reason it could not, having stopped the match, or null.
	 */
	function seatPlayers(registry: TablesMatches, matchId: string, players: TablePlayer[]): string | null {
		const match = registry.get(matchId);
		if (match === undefined) return `match ${matchId} was gone before its seats could be bound`;
		for (const [seat, player] of players.entries()) {
			const claim = match.claim(player.member.id);
			if (!claim.ok) {
				match.stop();
				return `${player.member.name} could not be seated: ${claim.error}`;
			}
			if (claim.seat !== seat) {
				match.stop();
				return `${player.member.name} was seated at ${claim.seat}, not ${seat}: their deck is in the other seat`;
			}
		}
		return null;
	}

	/** `{ room }`: the product's start. Both players' own decks, assembled here. */
	function startFromRoom(req: Request, res: Response, next: NextFunction, body: Record<string, unknown>): void {
		for (const key of Object.keys(body)) {
			if (key !== 'room') {
				res.status(400).json({ error: `body: unknown field ${key}` });
				return;
			}
		}
		const roomId = body.room;
		if (typeof roomId !== 'string' || roomId.trim() === '') {
			res.status(400).json({ error: 'body.room is a room id' });
			return;
		}
		const found = tableFor(req, roomId);
		if (found === null || rooms === null) {
			notFound(res);
			return;
		}
		const { room } = found;
		if (wrongGameType(room, res)) return;
		// Idempotent: whichever player asks second is answered the match the
		// first one started, not a second JVM.
		const live = liveMatchId(room);
		if (live !== null) {
			res.status(200).json({ matchId: live });
			return;
		}
		if (starting.has(room.id)) {
			res.status(409).json({ error: 'this room is already starting a match' });
			return;
		}
		const players = playersOf(rooms, room);
		if (players.length < TABLE_SEATS) {
			res.status(409).json({ error: 'both players have to load a deck first' });
			return;
		}
		const waiting = players.find((p) => !p.state.ready);
		if (waiting !== undefined) {
			res.status(409).json({ error: `${waiting.member.name} is not ready yet` });
			return;
		}
		// Unreachable while a deck is checked at load, `ready` refuses an illegal
		// one and loading a new deck un-readies you — and a guard, not a verdict:
		// naming another player's offending card here would report their drafted
		// pool to whoever pressed the button.
		const illegal = players.find((p) => !p.state.verdict.legal);
		if (illegal !== undefined) {
			res.status(422).json({ error: `${illegal.member.name}'s deck is not legal in ${illegal.state.verdict.rulesName}` });
			return;
		}
		const registry = deps.matches?.() ?? null;
		if (registry === null) {
			res.status(503).json({ error: 'this server cannot seat a room at a match (no match registry)' });
			return;
		}

		starting.add(room.id);
		const released = (): void => {
			starting.delete(room.id);
		};
		res.on('close', released);

		const answer = res.json.bind(res);
		res.json = ((payload: unknown) => {
			res.json = answer;
			released();
			const matchId = (payload as { matchId?: unknown }).matchId;
			if (res.statusCode === 201 && typeof matchId === 'string') {
				const refused = seatPlayers(registry, matchId, players);
				if (refused !== null) {
					log({ evt: 'room-seating-failed', room: room.id, matchId, error: refused });
					res.status(500);
					return answer({ error: refused });
				}
				rooms.setMatch(room.id, matchId);
				log({ evt: 'room-match-started', room: room.id, matchId, decks: players.map((p) => p.state.verdict.deckName) });
			}
			return answer(payload);
		}) as typeof res.json;

		// Play's own body. Each deck is the text its own player's rule checked.
		req.body = { opponent: 'human', decks: players.map((p) => p.state.text) };
		next();
	}

	gate.post('/matches', (req: Request, res: Response, next: NextFunction) => {
		const body = (req.body ?? {}) as Record<string, unknown>;

		if (typeof body === 'object' && body !== null && !Array.isArray(body) && 'room' in body) {
			startFromRoom(req, res, next, body);
			return;
		}

		if (typeof body !== 'object' || Array.isArray(body) || !('seats' in body)) {
			const decks = (body as { decks?: unknown }).decks;
			if (Array.isArray(decks) && decks.some((d) => d !== null)) {
				log({ evt: 'unchecked-deck-refused' });
				res.status(422).json({
					error: 'a deck must be checked before a match starts: send { seats: [{ deck, rules }, { deck, rules }] }',
				});
				return;
			}
			next();
			return;
		}

		const parsed = parseStartRequest(body);
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		// The shape Wave 13 removed: one person choosing both people's decks.
		// Against the AI the second deck is nobody else's, so that arm stays.
		if (parsed.value.opponent === 'human') {
			log({ evt: 'two-deck-start-refused' });
			res.status(422).json({
				error:
					'a match against a person starts from a room: each player loads their own deck and readies up, ' +
					'then POST { room: <roomId> }',
			});
			return;
		}
		const ctx = context(req);
		const verdicts: SeatVerdict[] = [];
		for (const [i, seat] of parsed.value.seats.entries()) {
			const verdict = checkSeat(seat, ctx);
			if ('error' in verdict) {
				res.status(400).json({ error: `seat ${i + 1}: ${verdict.error}`, seat: i });
				return;
			}
			verdicts.push(verdict);
		}

		const illegal = verdicts.findIndex((v) => !v.legal);
		if (illegal !== -1) {
			const error = refusalLine(illegal, verdicts[illegal] as SeatVerdict);
			log({ evt: 'illegal-deck-refused', seat: illegal, issues: verdicts[illegal]?.issues.length });
			res.status(422).json({ error, seats: verdicts.map(publicVerdict) });
			return;
		}

		// Play's own body. `decks` is the checked text, byte for byte.
		req.body = { opponent: parsed.value.opponent, decks: verdicts.map((v) => v.text) };
		log({ evt: 'decks-checked', decks: verdicts.map((v) => v.deckName), rules: verdicts.map((v) => v.rulesName) });
		next();
	});

	api.use('/play', gate);

	return { library };
}
