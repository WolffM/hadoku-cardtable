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
 *   GET  /api/tables/formats               the frozen pools (Standard, Modern, Legacy), each carrying its `family`
 *   GET  /api/tables/decks                 the deck library, with each list
 *   POST /api/tables/check                 `{ deck, rules }` → the verdict, without starting anything
 *   GET  /api/tables/rooms/:roomId         both players' state at a room's table
 *   PUT  /api/tables/rooms/:roomId/deck    `{ deck }` → check MY deck in the ROOM's pool and hold it
 *   POST /api/tables/rooms/:roomId/ready   `{ ready }` → I am (not) ready
 *   POST /api/play/matches                 GATED: see below
 *
 * `/check` still takes `{ deck, rules }`: it starts nothing and belongs to no
 * room, and it is what the deck builder and the screen's legality sweep ask.
 *
 * ## The POOL belongs to the room, and the leader sets it
 *
 * Wave 25 §A. `PUT …/deck` used to take `rules` from each caller and store each
 * player's OWN rules, and the start route only ever checked a deck against the
 * rule its own owner had named — so two players could load decks legal in two
 * different Standard pools and the match started anyway. The pool is now the
 * ROOM's (`room/lobby.ts`, `RoomView.format`), it is the rules for both seats,
 * and a body carrying `rules` is refused with 400 rather than accepted and
 * ignored: that is `http/rooms.ts`'s PATCH discipline, and a caller who thinks
 * they chose a format has to be told they did not.
 *
 * The leader moves the pool (`PATCH /api/rooms/:id { format }`), and moving it
 * drops every deck hold and both readiness flags — so the verdict this file
 * holds was always taken in the pool the room is on now.
 *
 * ## A room's pool is a frozen era OR a DRAFTED pool (wave 26 §F)
 *
 * Wave 25 left a hole nobody had noticed: a room's pool was a `FormatId`, a
 * match against a person starts from a room, and a drafted pool could not be
 * named as a room's pool — so for a project whose first line is "cube drafting
 * + Magic play for a private friend group", the two halves had never met. A
 * room's pool is now either a frozen era's date or `draft:<podId>`
 * (`room/lobby.ts`'s `draftPoolId` / `draftIdOfPool`), and `roomRules` turns it
 * into the gate's own `{ kind: 'standard' }` or `{ kind: 'draft' }`.
 *
 * **The room owns the POD; each player owns their own 45.** That is the whole
 * property, and it is why the resolution had to move from the request to the
 * person. A `{ kind: 'draft' }` rule resolves the pool of one named participant
 * (`draftPoolForMember`), and `RoomMember.id` is minted by the same
 * `identityFromHeaders` the draft socket seats people with, so the room already
 * knows which pool belongs to which of its two players. `startFromRoom`
 * therefore checks each stored deck in `contextFor(thatPlayer)` — never in the
 * requester's — so whoever presses start cannot have the other player's deck
 * measured against their own pool, and cannot learn a card of it either: the
 * refusal names the player and the pool and never the card.
 *
 * What this does NOT do is invent a shared pool. There is no path here that
 * reads one player's cards for another, and a player with no seat in the pod
 * gets the gate's own first-person refusal ("you have no seat in draft …")
 * rather than somebody else's cards.
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
 * **A deck is checked when it is loaded AND again at the start, both times
 * against the room's pool.** The re-check is what makes the pool a property of
 * the table rather than of a seat: it is the same RULE for both decks and it
 * does not depend on who pressed the button, so it cannot answer two players two
 * different things. Wave 25 could only say that of a frozen era, because a
 * `{ kind: 'draft' }` rule resolved the pool of whoever made the REQUEST — so a
 * re-check would have told the starter "you have no seat in draft …" about a deck
 * that was legal when its owner loaded it. Wave 26 §F fixed the resolution rather
 * than banning the pool: the rule is re-checked once PER PLAYER, each in that
 * player's own context, so a drafted pool is a room's pool like any other.
 *
 * What goes to Forge is the stored text, byte for byte the text the gate
 * validated, so there is still exactly one reader (§C.4).
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
 *     match answers that match, and an ask while its start is in flight waits
 *     for it and is answered the same, rather than starting a second one.
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
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';

import type { DraftRooms } from '../room/draftRooms.js';
import { viewForParticipant } from '../room/draftRooms.js';
import { identityFromHeaders } from '../room/identity.js';
import { FREE_PICK, draftIdOfPool, draftPoolId } from '../room/lobby.js';
import { summarizeDeck, type MatchStartInput } from '../stats/index.js';
import {
	checkSeat,
	legalLibraryDecks,
	parseDeckRef,
	parseSeatRequest,
	parseStartRequest,
	publicVerdict,
	refusalLine,
	type DeckRef,
	type DeckRules,
	type DraftPoolLookup,
	type GateContext,
	type SeatRequest,
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
	/** The room's pool: a `TableFormat.id`, and the rules for BOTH seats. */
	format: string;
	/** The one member who may change the room's settings. `you.leader` is this, per caller. */
	leader: string;
	/**
	 * `avatarId` is optional and, when present, a NON-BLANK string: the lobby
	 * folds `null`, `''` and whitespace to absent before a view is built
	 * (`room/lobby.ts`'s `avatarIdOf`), so this layer has two states to carry and
	 * not four. Structural here like the rest of this interface.
	 */
	members: { id: string; name: string; avatarId?: string }[];
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
	/**
	 * Clears `matchId` and un-readies every member (R16): what `liveMatchId`
	 * calls instead of `setMatch(id, null)` once it finds the match is finished
	 * or gone. Each member's table state — the deck they hold — is kept.
	 */
	releaseMatch(roomId: string): boolean;
	/**
	 * Told when a member's avatar changes (Q6). Optional like the rest of the
	 * room's surface: a registry that cannot say simply never updates a live seat.
	 */
	onAvatarChange?(
		listener: (change: { roomId: string; memberId: string; avatarId: string | null }) => void,
	): () => void;
}

/** The subset of `play`'s `MatchRegistry` a table uses, for the same reason. */
export interface TablesMatches {
	get(id: string):
		| {
				status: string;
				claim(participantId: string): { ok: true; seat: number } | { ok: false; error: string };
				seatOf(participantId: string): number | null;
				/** Wave 32 shape 1: updates the seat and re-sends `forge:seats` to every socket. */
				setSeatAvatar(seat: number, avatarId: string | null): void;
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
	/**
	 * A room's match has its players seated. The match stats keep this until the
	 * game is over; absent, nothing is recorded.
	 */
	matchStarted?(matchId: string, start: MatchStartInput): void;
}

export interface TablesHandle {
	library: TablesLibrary;
}

function defaultLog(entry: Record<string, unknown>): void {
	console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-tables', ...entry }));
}

/**
 * ONE PERSON's drafted pool, by the participant id that person is known by.
 *
 * **This is the function the whole drafted-pool table rests on, and the
 * argument is why.** A drafted pool belongs to whoever drafted it, so the pool
 * has to be found by a PERSON and not by a request — otherwise checking two
 * players' decks at a start would check both against whoever pressed the
 * button, and the second player's deck would be measured against a pool they
 * have never seen. `RoomMember.id` is minted by `identityFromHeaders`
 * (`room/lobby.ts`), which is the same derivation the draft socket seats people
 * with, so a room member's id IS the pod participant id `viewForParticipant`
 * takes. The room therefore already knows, for each of its two players, exactly
 * which pool is theirs.
 *
 * `viewForParticipant` stays the only resolver. It answers from `seatOf` — the
 * seat this participant HOLDS — so a pool is never read out of the seat table's
 * `remembered` map, which can name a seat somebody else has since taken and
 * would hand one player another's cards. The cost is stated rather than worked
 * around: a drafter who is not currently seated in the pod has no pool here,
 * and the answer says so.
 */
function draftPoolForMember(memberId: string, rooms: DraftRooms | null): DraftPoolLookup | null {
	if (rooms === null) return null;
	return (draftId) => {
		const room = rooms.find(draftId);
		if (room === undefined) return { ok: false, error: `no draft ${JSON.stringify(draftId)} on this server` };
		const view = viewForParticipant(room, memberId);
		if (view.viewer.kind !== 'seat') return { ok: false, error: `you have no seat in draft ${JSON.stringify(draftId)}` };
		return { ok: true, pool: view.viewer.pool };
	};
}

/**
 * The caller, by the derivation lane A mints `RoomMember.id` with.
 *
 * The socket id argument is only reached when the edge named nobody, and then
 * the id is ephemeral and random, so it matches no seat and no member — which
 * is the right answer for someone the edge could not name.
 */
function callerIdOf(req: Request): string {
	return identityFromHeaders(req.headers, `http-${randomUUID()}`);
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

/**
 * `{ deck }`, and nothing else — least of all `rules`.
 *
 * A body that names `rules` is refused rather than accepted and ignored: a
 * caller who believes they chose the pool has to be told they did not, and the
 * sentence says who did. `gate.ts`'s `parseDeckRef` is what reads the deck, so
 * `{ library }` and `{ dck }` mean here exactly what they mean everywhere else.
 */
function parseDeckBody(raw: unknown): { ok: true; deck: DeckRef } | { ok: false; error: string } {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'body is { deck }' };
	for (const key of Object.keys(raw as Record<string, unknown>)) {
		if (key === 'deck') continue;
		return {
			ok: false,
			error:
				key === 'rules'
					? "body: unknown field rules — a table's rules are its room's format, which only the room leader changes"
					: `body: unknown field ${key}`,
		};
	}
	const deck = parseDeckRef((raw as { deck?: unknown }).deck, 'body.deck');
	return deck.ok ? { ok: true, deck: deck.value } : { ok: false, error: deck.error };
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
	/** The room's member row, verbatim — `playersOf` does not rebuild it. */
	member: RoomViewLike['members'][number];
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

/**
 * Carry a member's changed avatar to the seat they hold in their room's running
 * match. A member with no seat there (not claimed, no match, match gone) is a
 * no-op: the avatar is already in the room and the next match reads it from there.
 */
export function relayAvatarToMatch(
	rooms: TablesRooms,
	registry: TablesMatches | null,
	change: { roomId: string; memberId: string; avatarId: string | null },
): void {
	if (registry === null) return;
	const matchId = rooms.get(change.roomId)?.matchId ?? null;
	if (matchId === null) return;
	const match = registry.get(matchId);
	if (match === undefined || match.status !== 'starting' && match.status !== 'running') return;
	const seat = match.seatOf(change.memberId);
	if (seat === null) return;
	match.setSeatAvatar(seat, change.avatarId);
}

export function attachTables(api: Router, deps: TablesDeps): TablesHandle {
	const log = deps.log ?? defaultLog;
	const library = deps.library ?? loadTablesLibrary(deps.repoRoot);
	log({ evt: 'library', formats: library.formats.length, decks: library.decks.length, faults: library.faults });

	/**
	 * The gate, as ONE NAMED PERSON sees it. `contextFor(me)` checks a deck
	 * against my pool; `contextFor(theOtherPlayer)` against theirs. Nothing here
	 * takes a request, so there is no way to check somebody else's deck against
	 * the requester's pool by forgetting to pass an argument.
	 */
	const contextFor = (memberId: string): GateContext => ({
		library,
		draftPool: draftPoolForMember(memberId, deps.draftRooms),
	});

	/** The gate as the CALLER sees it: for the routes whose deck is the caller's own. */
	const context = (req: Request): GateContext => contextFor(callerIdOf(req));

	/* ── the catalog ────────────────────────────────────────────────── */

	const tables = express.Router();
	tables.use(express.json({ limit: '256kb' }));

	/**
	 * The pods THIS CALLER is seated in, as pools a room can be put on.
	 *
	 * A drafted pool is a pool a table can play in, so it is offered in the same
	 * list and the same shape as a frozen era — one vocabulary for the room
	 * screen's picker, one `poolLabel`, no second type on the wire. `source` is
	 * `'draft'`, which is how a client tells the two apart when it cares.
	 *
	 * **Caller-scoped, and it is the caller's own seats and nobody else's.** The
	 * list is built from `viewForParticipant`, so it says nothing about who else
	 * drafted; `cardCount` is the size of the caller's OWN pool, which is their
	 * own hidden information, and no card name is in it.
	 *
	 * **They go FIRST, not last.** `newestFormat` — on both sides — picks the
	 * newest era whose `family` is `'standard'` (wave 48; `family` is sent as
	 * `'standard'` on a pod's own row too, unread, since a pod is told apart by
	 * `source`), and that is the default a new room opens on and the fallback a
	 * browser uses before the room has answered. A pod appended to the end would
	 * silently become eligible for that pick if it were not excluded by
	 * `source` first. `effective` is empty for a pod, so first is also where the
	 * documented "oldest first" ordering puts something with no date.
	 */
	function draftedPoolsFor(req: Request): Record<string, unknown>[] {
		const draftRooms = deps.draftRooms;
		if (draftRooms === null) return [];
		const me = callerIdOf(req);
		const offered: Record<string, unknown>[] = [];
		for (const room of draftRooms.all()) {
			const view = viewForParticipant(room, me);
			if (view.viewer.kind !== 'seat') continue;
			offered.push({
				id: draftPoolId(room.roomId),
				name: `Cube draft ${room.roomId}`,
				effective: '',
				sets: [],
				banned: [],
				cardCount: view.viewer.pool.length,
				source: 'draft',
				// Unused: the picker's "Drafted pool" tab is `source === 'draft'`,
				// never a family. The field is still sent, never optional, so every
				// row on the wire has the same shape.
				family: 'standard',
			});
		}
		return offered;
	}

	tables.get('/formats', (req: Request, res: Response) => {
		res.json({
			formats: [
				...draftedPoolsFor(req),
				// Free pick (`FREE_PICK`): a pool row so every browser can name it, with
				// no sets and no cards of its own — the whole library is its list.
				{
					id: FREE_PICK,
					name: 'Free pick',
					effective: '',
					sets: [],
					banned: [],
					cardCount: 0,
					source: 'free',
					family: 'standard',
				},
				...library.formats.map((f) => ({
					id: f.id,
					name: f.fixture.name,
					effective: f.fixture.effective,
					sets: f.fixture.sets,
					banned: f.fixture.banned,
					cardCount: f.fixture.cards.length,
					source: f.fixture.source,
					// The era's ruleset family (w48 §U) — the UI groups its tabs on
					// THIS, never on a parsed name.
					family: f.family,
				})),
			],
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

	// The library and the frozen pools are fixed for the life of the process,
	// so an era's answer is computed once and served from here after that.
	const legalByFormat = new Map<string, string[]>();
	tables.get('/legal/:format', (req: Request, res: Response) => {
		const format = String(req.params.format);
		let ids = legalByFormat.get(format);
		if (ids === undefined) {
			const swept = legalLibraryDecks(format, context(req));
			if ('error' in swept) {
				res.status(400).json({ error: swept.error });
				return;
			}
			ids = swept.ids;
			legalByFormat.set(format, ids);
		}
		res.json({ format, legal: ids });
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

	// Q6: a match is told a seat's avatar once, at its start. A member who changes
	// theirs afterwards reaches the board through the room, which is the only
	// place that hears it. Subscribed here because this is the one file that holds
	// both the room registry and play's match registry.
	rooms?.onAvatarChange?.((change) => {
		relayAvatarToMatch(rooms, deps.matches?.() ?? null, change);
	});

	/**
	 * The room this caller may act in, or null. One answer covers "no such
	 * room" and "you are not in it": a different one would say which rooms
	 * exist to someone who is in none of them.
	 */
	function tableFor(req: Request, roomId: string): { room: RoomViewLike; me: string } | null {
		if (rooms === null) return null;
		const room = rooms.get(roomId);
		if (room === undefined) return null;
		const me = callerIdOf(req);
		if (!room.members.some((m) => m.id === me)) return null;
		return { room, me };
	}

	/**
	 * The room's match if it is still one you could play, and null otherwise —
	 * releasing a match id the registry has forgotten OR has marked finished.
	 * Rooms persist across a restart and matches do not, so after a deploy
	 * every room that was playing holds the id of a match that no longer
	 * exists; without this, that room could never start another one.
	 *
	 * **`over` releases too, not only `stopped`/`failed` (R16).** A finished
	 * match sits in `over` for `overGraceMs` (ten minutes) before its host
	 * actually stops — the window that lets a disconnected player's socket
	 * still catch the final frame. Treating only `stopped`/`failed` as "not
	 * live" left a room holding a genuinely-finished match for that whole
	 * window, so reading the room during it sent a returning player straight
	 * back into the game that just ended, and kept a Rematch's Ready refused as
	 * "the match has already started". The match itself is untouched here
	 * — this only decides whether the ROOM still points at it — so a player
	 * still on the match screen mid-grace is unaffected.
	 *
	 * This is the one place in the server that can ask play's match registry
	 * about a room's match, so it is also where the room is told to let go of
	 * it (`releaseMatch`, not a bare `setMatch(id, null)`). The decks stay
	 * held — a Rematch plays them again — and nobody is ready, because the
	 * start that made this match spent both Readys.
	 */
	function liveMatchId(room: RoomViewLike): string | null {
		if (room.matchId === null) return null;
		const registry = deps.matches?.() ?? null;
		// No registry to ask: report what the room holds rather than clearing it.
		if (registry === null || rooms === null) return room.matchId;
		const match = registry.get(room.matchId);
		const finished = match === undefined || match.status === 'over' || match.status === 'stopped' || match.status === 'failed';
		if (!finished) return room.matchId;
		rooms.releaseMatch(room.id);
		log({ evt: 'room-match-cleared', room: room.id, matchId: room.matchId });
		return null;
	}

	/**
	 * The room's pool, in words, as a sentence ABOUT SOMEBODY ELSE can use it.
	 *
	 * Not `SeatVerdict.rulesName`: the draft arm writes that in the first person
	 * (`your pool from …`, because a verdict is only ever shown to the person
	 * whose deck it is), and the start refusal and the other player's row are
	 * both third-person. A pool this server does not have is named by its id
	 * rather than blank — `unknownPool` is what refuses on it.
	 */
	function poolName(room: RoomViewLike): string {
		const draftId = draftIdOfPool(room.format);
		if (draftId !== null) return `their own pool from ${draftId}`;
		if (room.format === FREE_PICK) return 'Free pick';
		return library.format(room.format)?.pool.name ?? room.format;
	}

	/**
	 * What both players may see: who has chosen what, whether it is legal,
	 * whether they are ready.
	 *
	 * A deck's faults are a count, for everybody; no issue list goes out. Your
	 * own faults are named once, by the refusal when you try to ready. A draft
	 * verdict names cards the other player did or did not draft, and a drafted
	 * pool is hidden information until the draft is over — the same reason
	 * `gate.ts` resolves a pool by the caller's identity and never by a seat
	 * number. `rulesName` is your own verdict's words for you, and the ROOM's
	 * pool in the third person for somebody else.
	 */
	function tableView(room: RoomViewLike, me: string): Record<string, unknown> {
		// `liveMatchId` FIRST: it can write the room (`Lobby.releaseMatch`), and
		// `playersOf` has to read the room AFTER that write or this very response
		// could describe a room it also reports as changed (R16).
		const matchId = liveMatchId(room);
		const players = rooms === null ? [] : playersOf(rooms, room);
		return {
			room: {
				id: room.id,
				name: room.name,
				gameType: room.gameType,
				// The pool both decks are checked in. The screen shows it, and only the
				// leader's copy of the screen may change it (`PATCH /api/rooms/:id`).
				format: room.format,
				// The pod behind a drafted pool, or null for a frozen era. Derived from
				// `format` and sent anyway, so a client does not have to know the
				// spelling of the prefix to draw a table on a drafted pool.
				draftId: draftIdOfPool(room.format),
				matchId,
				seats: TABLE_SEATS,
			},
			// `player` is "I have a deck at this table"; `leader` is "this room's
			// settings are mine to change". A member can be either, both or neither,
			// and no client can derive the second one for itself: `room.leader` is a
			// hashed ParticipantId and nothing tells a caller which id is theirs.
			you: { player: players.some((p) => p.member.id === me), leader: room.leader === me },
			players: players.map((p, seat) => ({
				seat,
				name: p.member.name,
				// The character this player picked in watchparty's room, when they
				// have one. Not caller-scoped: a face is not hidden information, and
				// both seats already see each other's names.
				//
				// **Spread, so the key is ABSENT rather than present-and-undefined.**
				// The done-when for this hop is "a missing one is absent rather than
				// empty", and `avatarId: p.member.avatarId` would satisfy that only
				// over JSON — an in-process reader would see the key. One shape for
				// both readers means the fallback a client writes is one check.
				...(p.member.avatarId === undefined ? {} : { avatarId: p.member.avatarId }),
				you: p.member.id === me,
				deckName: p.state.verdict.deckName,
				rulesName: p.member.id === me ? p.state.verdict.rulesName : poolName(room),
				legal: p.state.verdict.legal,
				issueCount: p.state.verdict.issues.length,
				ready: p.state.ready,
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

	/**
	 * The rules every deck at this room's table is checked against.
	 *
	 * One RULE, both seats, whoever is asking — and for a drafted pool that rule
	 * still resolves to two different card lists, because the draft arm resolves
	 * per person (`draftPoolForMember`). The thing the room owns is the POD, not
	 * the cards: nobody at this table can be checked against a pod they did not
	 * draft in, and nobody can be checked against another player's 45.
	 */
	function roomRules(room: RoomViewLike): DeckRules {
		if (room.format === FREE_PICK) return { kind: 'free' };
		const draftId = draftIdOfPool(room.format);
		return draftId === null ? { kind: 'standard', format: room.format } : { kind: 'draft', draftId };
	}

	/**
	 * A room whose pool this server does not have is a 409 about the ROOM, not a
	 * 400 about the caller's body: nothing the caller sent is wrong. It happens to
	 * a room restored from a build whose pools this one no longer ships, and to a
	 * server with no `decks/pools` at all — where the lobby says `unavailable`
	 * rather than inventing a date.
	 *
	 * For a DRAFTED pool the missing thing is the pod, and a pod is in memory
	 * only (`room/draftRooms.ts` keeps no disk state), so this is also the answer
	 * after a restart — the same 409, the same shape, a sentence naming what is
	 * gone. Whether the CALLER has a seat in that pod is not asked here: that is
	 * a fact about a person, it differs between the two players, and the gate's
	 * own refusal says it in the first person.
	 */
	function unknownPool(room: RoomViewLike, res: Response): boolean {
		const draftId = draftIdOfPool(room.format);
		if (draftId === null) {
			if (room.format === FREE_PICK || library.format(room.format) !== undefined) return false;
			res.status(409).json({ error: `this room's format ${JSON.stringify(room.format)} is not one this server has` });
			return true;
		}
		if (deps.draftRooms?.find(draftId) !== undefined) return false;
		res.status(409).json({ error: `this room's draft ${JSON.stringify(draftId)} is not one this server has` });
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
		const parsed = parseDeckBody(req.body);
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		if (unknownPool(room, res)) return;
		const seat: SeatRequest = { deck: parsed.deck, rules: roomRules(room) };
		const players = playersOf(rooms, room);
		const mine = players.find((p) => p.member.id === me);
		if (mine === undefined && players.length >= TABLE_SEATS) {
			res.status(409).json({ error: 'this table already has two players' });
			return;
		}
		const verdict = checkSeat(seat, context(req));
		if ('error' in verdict) {
			res.status(400).json({ error: verdict.error });
			return;
		}
		// A new deck un-readies you: what you readied with is not what you hold.
		// `choice` keeps the room's rules beside the deck, so the hold records which
		// pool its verdict was taken in even after the leader moves the room.
		const state: TablePlayerState = {
			v: 1,
			choice: seat,
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
			res.status(422).json({ error: line });
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

	/**
	 * Rooms whose start is in flight, each with the asks that arrived while it was.
	 * Both browsers ask once both players are ready, so a second ask during the
	 * seconds Forge takes to come up is the normal case, not a conflict: it waits
	 * and is answered what the first one is — the same match, or the same refusal.
	 * One JVM per room either way.
	 */
	const starting = new Map<string, ((status: number, payload: unknown) => void)[]>();

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
			if (key !== 'room' && key !== 'bot') {
				res.status(400).json({ error: `body: unknown field ${key}` });
				return;
			}
		}
		if (body.bot !== undefined && body.bot !== true) {
			res.status(400).json({ error: 'body.bot is true or absent' });
			return;
		}
		const vsBot = body.bot === true;
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
		const joiners = starting.get(room.id);
		if (joiners !== undefined) {
			joiners.push((status, payload) => res.status(status).json(payload));
			return;
		}
		const players = playersOf(rooms, room);
		if (vsBot) {
			// One person against Forge's AI, from a room (the operator, 2026-10-02:
			// "would be nice to be able to add a bot so i dont have to play against
			// myself everytime"). Only when the caller is the room's ONLY member:
			// with two people in the room they play each other, and a bot start
			// would take the table out from under the second one.
			if (room.members.length !== 1) {
				res.status(409).json({ error: 'a bot game is for a room with one player in it' });
				return;
			}
			if (players.length !== 1) {
				res.status(409).json({ error: 'load a deck first' });
				return;
			}
		} else {
			if (players.length < TABLE_SEATS) {
				res.status(409).json({ error: 'both players have to load a deck first' });
				return;
			}
			const waiting = players.find((p) => !p.state.ready);
			if (waiting !== undefined) {
				res.status(409).json({ error: `${waiting.member.name} is not ready yet` });
				return;
			}
		}
		// BOTH decks against the ROOM's pool, which is what makes the pool a
		// property of the table: one rule, applied to both seats, independent of who
		// pressed the button. The stored verdict is not the authority here — it was
		// taken when its own deck was loaded, and the room can have moved since.
		//
		// A guard, not a verdict: the sentence names the PLAYER and the pool and
		// never the card, because naming somebody else's offending card would
		// report their deck to whoever pressed the button. That holds for a drafted
		// pool too, and matters more there: the whole pool is hidden information
		// until the draft is over, so a card in the refusal would report what
		// somebody drafted to whoever pressed start.
		//
		// **Each deck in ITS OWN OWNER's context** (`contextFor(player.member.id)`,
		// not `context(req)`). For a frozen era the two contexts resolve the same
		// list and the distinction is invisible; for a drafted pool it is the
		// difference between a working table and a broken one — with the requester's
		// context, whoever pressed start would have the OTHER player's deck measured
		// against their own 45 and every card of it would read `plays 1x X but
		// drafted 0`. The gate's draft arm was always per caller (`gate.ts`, "Why
		// the draft arm checks only your own pool"); what wave 25 left missing was a
		// caller for the seat that is not making the request, and a room member's id
		// is exactly that.
		if (unknownPool(room, res)) return;
		for (const player of players) {
			const verdict = checkSeat(
				{ deck: { dck: player.state.text }, rules: roomRules(room) },
				contextFor(player.member.id),
			);
			if ('error' in verdict) {
				res.status(409).json({ error: `this room's table cannot be checked: ${verdict.error}` });
				return;
			}
			if (!verdict.legal) {
				log({ evt: 'room-start-refused', room: room.id, issues: verdict.issues.length });
				res.status(422).json({ error: `${player.member.name}'s deck is not legal in ${poolName(room)}` });
				return;
			}
		}
		// The bot's deck: a random one of the decks the room's pool offers a player
		// (`legalLibraryDecks` — the era's own, or the whole library on Free pick),
		// checked by the same gate as the player's. A drafted pool offers no library
		// deck, so a drafted room cannot have a bot.
		let botDeck: { id: string; text: string; name: string } | null = null;
		if (vsBot) {
			const owner = players[0]!.member.id;
			const swept = draftIdOfPool(room.format) === null ? legalLibraryDecks(room.format, contextFor(owner)) : { ids: [] };
			const offered = 'error' in swept ? [] : swept.ids;
			if (offered.length === 0) {
				res.status(409).json({ error: `no deck in the library is legal in ${poolName(room)}, so the bot has nothing to play` });
				return;
			}
			const picked = library.deck(offered[Math.floor(Math.random() * offered.length)]!)!;
			botDeck = { id: picked.id, text: picked.text, name: picked.deck.name || 'Unnamed deck' };
		}
		const registry = deps.matches?.() ?? null;
		if (registry === null) {
			res.status(503).json({ error: 'this server cannot seat a room at a match (no match registry)' });
			return;
		}

		const waiting: ((status: number, payload: unknown) => void)[] = [];
		starting.set(room.id, waiting);
		let settled = false;
		/** Answer every ask that joined this start, and let the room start again. */
		const settle = (status: number, payload: unknown): void => {
			if (settled) return;
			settled = true;
			starting.delete(room.id);
			for (const join of waiting) join(status, payload);
		};
		// Play answers through `res.json`, below. A response that ends any other way
		// still frees the room. A caller who goes away mid-start (a reload) does NOT:
		// Forge is still coming up, and the reloaded page's ask joins it rather than
		// launching a second JVM.
		res.on('finish', () => settle(res.statusCode, { error: 'the match could not be started' }));

		const answer = res.json.bind(res);
		res.json = ((payload: unknown) => {
			res.json = answer;
			const matchId = (payload as { matchId?: unknown }).matchId;
			if (res.statusCode === 201 && typeof matchId === 'string') {
				const refused = seatPlayers(registry, matchId, players);
				if (refused !== null) {
					log({ evt: 'room-seating-failed', room: room.id, matchId, error: refused });
					settle(500, { error: refused });
					res.status(500);
					return answer({ error: refused });
				}
				rooms.setMatch(room.id, matchId);
				// The start spends both Readys: neither carries into the match, so
				// nothing is left ready for a later read to start again — not when
				// the match ends, and not when a restart restores the room without
				// it. The decks stay held: they are what a Rematch plays.
				for (const p of players) rooms.setPlayerState(room.id, p.member.id, { ...p.state, ready: false });
				deps.matchStarted?.(matchId, matchStartOf(room, players, botDeck));
				log({ evt: 'room-match-started', room: room.id, matchId, decks: players.map((p) => p.state.verdict.deckName), ...(vsBot ? { opponent: 'ai' } : {}) });
				settle(200, { matchId });
				return answer(payload);
			}
			settle(res.statusCode, payload);
			return answer(payload);
		}) as typeof res.json;

		// Play's own body. Each deck is the text its own player's rule checked, and
		// `avatarIds` is item 4's server half (wave 29 §B): the same seat order as
		// `decks`, each the room member's own `avatarId` — already the lobby's
		// two-state shape (a non-blank string, or absent; see `RoomViewLike.members`
		// above and `D-avatar-field.md` §3), never Forge's own view of the seat.
		if (vsBot) {
			// Seat 1 is Forge's AI. `avatarIds` and `names` stay pairs (play
			// refuses anything else); the AI seat's entries are absent, so play
			// names it itself.
			req.body = {
				opponent: 'ai',
				decks: [players[0]!.state.text, botDeck!.text],
				avatarIds: [players[0]!.member.avatarId, undefined],
				names: [players[0]!.member.name, undefined],
			};
			next();
			return;
		}
		req.body = {
			opponent: 'human',
			decks: players.map((p) => p.state.text),
			avatarIds: players.map((p) => p.member.avatarId),
			// Seat names (wave 31 shape 1): the same order, each the member's display
			// name, so Forge's own prompts and the board say who is who.
			names: players.map((p) => p.member.name),
		};
		next();
	}

	/**
	 * What the match stats keep from a room's start: who sat where, with which
	 * deck, in which pool. `memberId` is how the stats find each player's key;
	 * the AI seat has none. The cost map is the room's era's own plus the
	 * library's, so a deck's colours fold the same as the room screen's pips.
	 */
	function matchStartOf(room: RoomViewLike, players: TablePlayer[], botDeck: { id: string; text: string; name: string } | null): MatchStartInput {
		const format = library.format(room.format);
		const costs = format === undefined ? LIBRARY_CARD_COSTS : { ...LIBRARY_CARD_COSTS, ...format.fixture.manaCost };
		const family = draftIdOfPool(room.format) !== null ? 'draft' : room.format === FREE_PICK ? 'free' : (format?.family ?? 'unknown');
		const seats: MatchStartInput['seats'] = players.map((p) => {
			const ref = p.state.choice.deck;
			return {
				memberId: p.member.id,
				displayName: p.member.name,
				...(p.member.avatarId === undefined ? {} : { avatarId: p.member.avatarId }),
				deck: summarizeDeck(p.state.text, p.state.verdict.deckName, costs, 'library' in ref ? ref.library : undefined),
			};
		});
		if (botDeck !== null) seats.push({ memberId: null, deck: summarizeDeck(botDeck.text, botDeck.name, costs, botDeck.id) });
		return {
			mode: 'constructed',
			roomId: room.id,
			startedAt: Date.now(),
			attrs: { format: family, pool: room.format, opponent: botDeck === null ? 'human' : 'bot' },
			seats,
		};
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
