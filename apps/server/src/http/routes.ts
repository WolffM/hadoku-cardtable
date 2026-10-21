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
 *   GET  /api/tables/rooms/:roomId         both players' state at ONE of a room's tables (`?table=`, default `tables[0]`)
 *   PUT  /api/tables/rooms/:roomId/deck    `{ deck, table? }` → check MY deck in the TABLE's pool and hold it
 *   POST /api/tables/rooms/:roomId/ready   `{ ready, table? }` → I am (not) ready
 *   POST /api/tables/rooms/:roomId/sit     `{ table? }` → take a free seat (a deck may come later)
 *   POST /api/tables/rooms/:roomId/stand   `{ table? }` → give my seat back; refused once the table is locked
 *   POST   /api/tables/rooms/:roomId/tables              leader only: add an empty table, answers its `RoomTable`
 *   DELETE /api/tables/rooms/:roomId/tables/:tableId     leader only: remove an empty, idle table other than the first
 *   POST /api/play/matches                 GATED: see below (`{ room, bot?, table? }`)
 *
 * `/check` still takes `{ deck, rules }`: it starts nothing and belongs to no
 * room, and it is what the deck builder and the screen's legality sweep ask.
 *
 * ## A room holds several tables, and a table plays a SERIES (wave 71 §D)
 *
 * Every table-scoped route above takes an optional `table` (a body field, or
 * `?table=` on the GET); absent means `tables[0]`, so every call a pre-wave-71
 * caller ever made keeps meaning exactly what it always did. `resolveTable`
 * is the one place a request's `table` becomes a `RoomTable`, and `tableView`
 * builds this file's own table-view body for whichever one that is — the
 * shape is unchanged, just now PER TABLE rather than per room.
 *
 * A series (`RoomTable.series`) is a room concept, never Forge's: each game
 * is its own fresh Forge match, and `lobby.ts`'s `setTableMatch` /
 * `recordGameResult` / `releaseTableMatch` keep the ledger — length, wins,
 * games, phase. `liveMatchId` below is where a finished or vanished match
 * reaches that ledger: `over` records the game and may move the phase to
 * `sideboarding` or `done` (`winnerSeatOf` decides the seat); anything else
 * that is not live any more (`stopped`/`failed`, or the registry has simply
 * lost the match) just releases the table with no outcome recorded.
 *
 * **Eager, since wave 72 §P.** `TablesHandle.gameOver` does the same `over`
 * work the moment play says a match ended (`index.ts` composes it onto the
 * one `onGameOver` line, beside `matchStats.gameOver`), so every reader of
 * `GET /api/rooms/:id` sees the result at once rather than only after some
 * request happens to hit a `/api/tables` route first. `liveMatchId`'s own
 * `over` arm stays, as the boot sweep's path only (`releaseGoneMatches`).
 *
 * During `sideboarding`, `PUT …/deck` additionally checks the resubmission
 * against the seat's OWN deck at the start of the series (`sideboardIssue`):
 * the same cards, only re-split between main and board — basics excepted on
 * a DRAFTED pool, where they are free at every other step too.
 *
 * **A `done` table's own Rematch** — bo1 with sideboarding on, and both
 * players press it — is the ONE OTHER door into `sideboarding`
 * (`lobby.ts`'s `beginSideboarding`, called from `POST …/ready` on every
 * `ready: true`, unconditionally; the lobby decides whether anything
 * happens). It is a NEW series from the moment it begins: `wins`/`games`
 * reset there, not later. Beginning it spends both Readys, as a start does:
 * agreeing to sideboard is not agreeing to the next game, so every way into
 * `sideboarding` starts with nobody ready, and each seat readies again from
 * the sideboard step itself. A `done` bo3 table's Rematch, and a `done`
 * bo1-without-sideboarding table's, both skip it and start a new series
 * directly — bo3's own sideboarding happens BETWEEN a series' games, never
 * between two series.
 *
 * The next game of a series is asked play-or-draw by the LOSER of the one
 * before it (`startFromRoom`'s `chooser`, computed from `series.games.at(-1)`
 * and carried on the start body for lane E's bridge rig,
 * `MatchSpec.chooser?: 0 | 1`) — but ONLY when `!newSeries`: a `done` table's
 * `games` still holds its OLD series' last game until `setTableMatch` resets
 * it, so reading `games.at(-1)` unguarded would rig a brand-new series'
 * first game to the previous series' loser. The first game of a series
 * always leaves `chooser` unset.
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
 * ## A pod's tables play a DRAFTED pool (wave 26 §F, wave 72 §P)
 *
 * A `draft` room's tables play `draft:<podId>` (`effectivePoolOf`, from the
 * room's game type — never its stored format), and `rulesOf` turns that into
 * the gate's own `{ kind: 'draft' }`. A constructed room is never on a pod
 * (operator, 2026-10-20): a drafted deck is played there on Free pick.
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

import { createHash, randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { deckFromDeckFile, isBasicLand, poolOf } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';
import { parseDck } from '@hadoku/carddata/dck';
import type { DeckEntry } from '@hadoku/carddata/dck';
import { RandomOptionsSchema, secureRandom, type RandomPool, type RoomModeState, type RoomTable } from '@hadoku/shared';

import type { DraftRooms, PodDeal } from '../room/draftRooms.js';
import { botPoolAcross, builtDeckOf, stateOf, viewForParticipant } from '../room/draftRooms.js';
import { botDeckText } from '../room/botDeck.js';
import { identityFromHeaders } from '../room/identity.js';
import { FREE_PICK, draftIdOfPool, draftPoolId, type PodChecks } from '../room/lobby.js';
import { drawRandomDecks } from '../room/random-decks.js';
import type { MatchSpec } from '../play/host.js';
import { AI_SEAT_OWNER } from '../play/match.js';
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
import type { TablesLibrary } from './library.js';

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
	/** A Constructed room's mode and its options; absent or null until chosen. */
	mode?: RoomModeState['mode'];
	modeOptions?: RoomModeState['modeOptions'];
	/** How the room's matches are dealt (`room/lobby.ts`'s `RoomSettings`). */
	settings: { handSmoothing: boolean };
	/** The one member who may change the room's settings. `you.leader` is this, per caller. */
	leader: string;
	/**
	 * `avatarId` is optional and, when present, a NON-BLANK string: the lobby
	 * folds `null`, `''` and whitespace to absent before a view is built
	 * (`room/lobby.ts`'s `avatarIdOf`), so this layer has two states to carry and
	 * not four. Structural here like the rest of this interface.
	 */
	members: { id: string; name: string; avatarId?: string }[];
	/** Who the room's AI plays as (`room/lobby.ts`'s `roomAi`). Absent, Forge's own name and no face. */
	ai?: { name: string; avatarId: string };
	/**
	 * Wave 71: always at least one. Every request without a `table` field means
	 * `tables[0]` — see `resolveTable`. The real `@hadoku/shared` `RoomTable`
	 * shape, imported rather than restated, because by this hop the series
	 * fields (`length`/`wins`/`phase`) are not optional extras — the sideboard
	 * gate and the start route's `chooser` wiring both read them.
	 */
	tables: RoomTable[];
	/**
	 * Wave 72 §P: `null` for a `constructed-1v1` room, always present for a
	 * `draft` one. Only `phase` is read here (`wrongGameType`'s "or a pod in
	 * rounds") — the rest of `RoomView.pod` is `GET /api/rooms/:id`'s own
	 * concern, not a table route's.
	 */
	pod: { phase: string } | null;
}

/** The subset of lane A's `Lobby` a table uses. */
export interface TablesRooms {
	get(roomId: string): RoomViewLike | undefined;
	/** Every room. Read once, at boot, by `releaseGoneMatches`. */
	list(): RoomViewLike[];
	/** The room that started `matchId` (its current or a recent match, on any table), or undefined. */
	roomOfMatch(matchId: string): RoomViewLike | undefined;
	/** Per-member state this file owns. `undefined` when unset, or no such room or member. */
	playerState(roomId: string, memberId: string): unknown;
	/** False when there is no such room, or `memberId` is not a member. */
	setPlayerState(roomId: string, memberId: string, state: unknown): boolean;
	/**
	 * The mirror `viewOf` builds `RoomTable.players` from — see
	 * `room/lobby.ts`'s `Lobby.setTableSeats` for why it exists at all. Pushed
	 * after every sit, stand and seating deck-load. False when there is no such
	 * room or table.
	 */
	setTableSeats(roomId: string, tableId: string, seats: readonly (string | null)[]): boolean;
	/** False when there is no such room or table, or the table already has a live match. */
	setTableMatch(roomId: string, tableId: string, matchId: string): boolean;
	/**
	 * The match simply VANISHED (the registry has no record at all) — clears
	 * `matchId` and un-readies only this table's own seated members (R16,
	 * scoped). No outcome to record, so the series' phase is untouched.
	 */
	releaseTableMatch(roomId: string, tableId: string): boolean;
	/**
	 * The match ACTUALLY ended: records the game, advances the series
	 * (`sideboarding` or `done`), clears `matchId`, un-readies the table's own
	 * seated members. False only when there is no such room or table.
	 */
	recordGameResult(roomId: string, tableId: string, result: { matchId: string; winner: 0 | 1 | null }): { ok: boolean };
	/**
	 * The operator's "both players press Rematch" (§D bullet 3): called
	 * UNCONDITIONALLY from `POST …/ready` every time a `ready: true` leaves a
	 * table's two seats both ready — the lobby decides whether that is bo1
	 * with sideboarding on and a just-finished series (the only case this
	 * does anything) and answers whether it moved the table into
	 * `sideboarding`. A no-op `false` is not a failure.
	 */
	beginSideboarding(roomId: string, tableId: string): boolean;
	/**
	 * The winner `beginSideboarding` carried past its own `games` reset — see
	 * `room/lobby.ts`'s `SeriesRecord` doc (claw run 39046554773, 2026-10-17).
	 * `startFromRoom` reads this as the chooser source for a bo1-with-
	 * sideboarding rematch's game, which `games.at(-1)` can no longer answer
	 * once `beginSideboarding` has reset it to `[]`. `null` once that game has
	 * started, for a bo3's own mid-series sideboarding, and for no such room
	 * or table.
	 */
	rematchOf(roomId: string, tableId: string): 0 | 1 | null;
	/** Leader only. Appends an empty table and answers its `RoomTable`. */
	addTable(roomId: string, callerId: string): { ok: true; table: RoomTable } | { ok: false; reason: 'no-room' | 'not-leader' };
	/** Leader only. Removes a table other than the first, when it is empty and idle. */
	removeTable(
		roomId: string,
		callerId: string,
		tableId: string,
	): { ok: true } | { ok: false; reason: 'no-room' | 'not-leader' | 'no-such-table' | 'first-table' | 'not-idle' };
	/**
	 * Told when a member's avatar changes (Q6). Optional like the rest of the
	 * room's surface: a registry that cannot say simply never updates a live seat.
	 */
	onAvatarChange?(
		listener: (change: { roomId: string; memberId: string; avatarId: string | null }) => void,
	): () => void;
	/** How the pod's draft is dealt: its open seats, who sits where, and its AI characters' names (`room/lobby.ts`). Optional like `onAvatarChange`. */
	podDraft?(roomId: string): PodDeal | null;
	/** Wires `PodChecks` into the room registry — see its own doc (`room/lobby.ts`). Optional like `onAvatarChange`. */
	setPodChecks?(checks: PodChecks): void;
}

/** The subset of `play`'s `MatchRegistry` a table uses, for the same reason. */
/**
 * How many matches one person may be playing at once (the operator, 2026-10-11:
 * "let's make it 5 max per person"). Counted per room member at the start, over
 * the matches still `starting` or `running` — a conceded or finished one does
 * not count. The server-wide ceiling is `play/host.ts`'s `MAX_CONCURRENT_MATCHES`.
 */
export const MAX_MATCHES_PER_PERSON = 5;

export interface TablesMatches {
	/** Every match the registry still holds, finished ones included; see `MAX_MATCHES_PER_PERSON`. */
	active(): readonly { status: string; seatOf(participantId: string): number | null }[];
	get(id: string):
		| {
				status: string;
				claim(participantId: string): { ok: true; seat: number } | { ok: false; error: string };
				seatOf(participantId: string): number | null;
				/** The seat's holder changed their avatar: re-sends `forge:seats` to every socket. */
				seatAvatarChanged(seat: number): void;
				stop(): void;
				/** Forge's own winning player's NAME (`PlayBridge.java`'s `getWinningLobbyPlayer().getName()`) — see `winnerSeatOf`. */
				winner: string | null;
				/** The winning seat from Forge's own losers — see `winnerSeatOf`. */
				winnerSeat?: 0 | 1 | null;
				/** The seat whose concede Forge was sent, or null. */
				concededBy: number | null;
				/** Each seat's own display name, as sent to Forge — `winnerSeatOf` matches `winner` against these. */
				seats: readonly { displayName?: string }[];
		  }
		| undefined;
}

export interface TablesDeps {
	/** The server's draft rooms, for the `draft` rule. Null when no cube pool loaded. */
	draftRooms: DraftRooms | null;
	log?: TablesLog;
	/**
	 * The formats and decks, loaded once by the caller: production at boot, a
	 * test at module level. Reading every era's pool costs most of a second, so
	 * a test that let each `attachTables` load its own spent its budget on it.
	 */
	library: TablesLibrary;
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
	/** A uniform [0, 1) for the server's own draws (All Random's deal). `secureRandom` unless a test pins it. */
	random?: () => number;
}

/** What `matchStart` reads off a match: all of it in `jvm.json`, so a restart keeps it. */
export interface StartedMatch {
	id: string;
	spec: MatchSpec;
	startedAt: number;
	seats: readonly { owner: string | null; displayName?: string }[];
}

export interface TablesHandle {
	library: TablesLibrary;
	/**
	 * The avatar a match seat's holder wears: the room member's own, read from
	 * the room that started the match. The room is the ONE place an avatar is
	 * stored — play asks here (`MatchDeps.seatAvatar`) on every roster it sends
	 * rather than keeping a copy, so a seat's face cannot drift from its
	 * holder's across a change or a restart. Undefined for a member with none,
	 * a holder who is not in that room, and a match no room started.
	 */
	seatAvatar(matchId: string, memberId: string): string | undefined;
	/**
	 * A room's match as the match stats report it, read when they ask (at game
	 * over) from where each fact lives: the room that started it (`roomOfMatch`)
	 * for its id and each holder's name and face, the match's own spec for its
	 * pool and decks, and the match for who holds each seat and when it began.
	 * Nothing is captured at the start, so a match taken back after a restart
	 * reads the same as one that never left. Null for a match no room started.
	 */
	matchStart(match: StartedMatch): MatchStartInput | null;
	/**
	 * Run once play has adopted the matches an earlier server left running: every
	 * room whose match did not come back lets go of it (`liveMatchId`), so no room
	 * advertises "playing" a game that died with the old process.
	 */
	releaseGoneMatches(): void;
	/**
	 * A table's match ACTUALLY ended, from play's OWN end event
	 * (`play/match.ts:3497`'s `onGameOver`) — called at once, so a table's
	 * series ledger (`RoomTable.series`) and `matchId` are current for EVERY
	 * reader of `GET /api/rooms/:id`, not only one whose request happens to
	 * hit a `/api/tables` route first (wave 72 §P step 1). `index.ts` composes
	 * this with `matchStats.gameOver` on the one `onGameOver` line, so both
	 * run from the same event; `play/**` is not otherwise touched.
	 *
	 * `liveMatchId`'s own `over` arm (above) is UNCHANGED and stays reachable
	 * — it is now only the boot sweep's path, for a match that ended while no
	 * process was listening (`releaseGoneMatches`, run once play has adopted
	 * an earlier server's orphans). Running both for the same game is
	 * harmless: by the time either second call could happen,
	 * `recordGameResult` has already cleared the table's `matchId`, and
	 * neither finds a table still pointing at this match to record again.
	 */
	gameOver(match: GameOverMatch): void;
}

/** The part of play's `Match` that deciding and recording its outcome needs — see `winnerSeatOf`. */
export interface GameOverMatch {
	id: string;
	winner: string | null;
	winnerSeat?: 0 | 1 | null;
	concededBy: number | null;
	seats: readonly { displayName?: string }[];
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
interface TableDeck {
	/** The choice as the player sent it, so their picker can be restored. */
	choice: { deck: DeckRef; rules: DeckRules };
	/** The verdict the gate gave when the deck was loaded, without the text. */
	verdict: Omit<SeatVerdict, 'text'>;
	/** The checked `.dck`, byte for byte. Never sent to a browser. */
	text: string;
}

/**
 * A SEAT, which may or may not hold a deck yet. Sitting is its own act since
 * 2026-10-12 (the operator: a crowded watchparty room needs a way to take a
 * seat that is not a race on the deck picker), so `deck` is null between
 * `POST …/sit` and the first `PUT …/deck`. Rows written before that day were
 * flat — `choice`/`verdict`/`text` beside `ready` — and `readPlayerState`
 * migrates them on read, because they survive a deploy.
 */
interface TablePlayerState {
	v: 1;
	/**
	 * Which table this seat belongs to (wave 71). Absent for a row written
	 * before multi-table rooms existed — `playersOf` reads that as the room's
	 * FIRST table, which is what every such row actually was.
	 */
	table?: string;
	deck: TableDeck | null;
	ready: boolean;
	/** When this member first took a seat: the order the two players are in. */
	seatedAt: number;
	/**
	 * The seat's REGISTERED deck: the load it held when its series began, kept
	 * whole (choice, verdict, text) so it can be put back. Two jobs:
	 *
	 *   - the sideboard-legality baseline `PUT …/deck` checks a resubmission
	 *     against during `sideboarding` (`sideboardIssue`, on its `text`);
	 *   - MTG's rule that sideboarding lasts one match: once the table's series
	 *     is `done`, the seat goes back to this load (`recordGame`), a library
	 *     deck as that library deck and a drafted one as the drafted one.
	 *
	 * Taken when a series' first game starts and kept through a bo1 Rematch's
	 * sideboarding step, so the sideboarded 75 never becomes the registered
	 * deck. A row persisted before this held the `.dck` text alone: it still
	 * serves as the baseline, and there is nothing to put back.
	 */
	seriesDeck: TableDeck | string | null;
	/**
	 * The AI's `.dck` at an All Random table against the AI, dealt with this
	 * seat's own deck (`dealRandom`) and held beside it so a Rematch plays the
	 * same two. Absent everywhere else: a Classic AI draws its deck per game.
	 */
	aiDeck?: string;
}

/**
 * A seat's deck as its OWNER reads it at the table (`tableView`): no `.dck`
 * text, and its faults as a count. Nobody else is ever sent this.
 */
function ownDeckView(deck: TableDeck | null): { name: string; rulesName: string; legal: boolean; issueCount: number; choice: TableDeck['choice'] } | null {
	if (deck === null) return null;
	const { deckName: name, rulesName, legal, issues } = deck.verdict;
	return { name, rulesName, legal, issueCount: issues.length, choice: deck.choice };
}

/** The registered deck's text, whichever shape the row holds it in. */
function seriesTextOf(state: TablePlayerState): string | null {
	return typeof state.seriesDeck === 'string' ? state.seriesDeck : (state.seriesDeck?.text ?? null);
}

/** A seated player whose seat holds a deck: what a start needs. */
interface LoadedPlayer extends TablePlayer {
	deck: TableDeck;
}

/**
 * `{ deck }`, and nothing else — least of all `rules`.
 *
 * A body that names `rules` is refused rather than accepted and ignored: a
 * caller who believes they chose the pool has to be told they did not, and the
 * sentence says who did. `gate.ts`'s `parseDeckRef` is what reads the deck, so
 * `{ library }` and `{ dck }` mean here exactly what they mean everywhere else.
 */
function parseDeckBody(raw: unknown): { ok: true; deck: DeckRef; table: unknown } | { ok: false; error: string } {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'body is { deck }' };
	for (const key of Object.keys(raw as Record<string, unknown>)) {
		if (key === 'deck' || key === 'table') continue;
		return {
			ok: false,
			error:
				key === 'rules'
					? "body: unknown field rules — a table's rules are its room's format, which only the room leader changes"
					: `body: unknown field ${key}`,
		};
	}
	const deck = parseDeckRef((raw as { deck?: unknown }).deck, 'body.deck');
	return deck.ok ? { ok: true, deck: deck.value, table: (raw as { table?: unknown }).table } : { ok: false, error: deck.error };
}

/**
 * `{}` or `{ table }` — what `/sit` and `/stand` take, neither of which has
 * anything else to say.
 */
function parseTableBody(raw: unknown): { ok: true; table: unknown } | { ok: false; error: string } {
	if (raw === undefined) return { ok: true, table: undefined };
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'body is {} or { table }' };
	const extra = Object.keys(raw as Record<string, unknown>).find((k) => k !== 'table');
	if (extra !== undefined) return { ok: false, error: `body: unknown field ${extra}` };
	return { ok: true, table: (raw as { table?: unknown }).table };
}

function readDeck(raw: unknown): TableDeck | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const d = raw as Partial<TableDeck>;
	if (typeof d.text !== 'string') return null;
	if (typeof d.verdict !== 'object' || d.verdict === null || typeof d.verdict.legal !== 'boolean') return null;
	if (typeof d.choice !== 'object' || d.choice === null) return null;
	return { choice: d.choice, verdict: d.verdict, text: d.text };
}

function readPlayerState(raw: unknown): TablePlayerState | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const s = raw as Partial<TablePlayerState> & Partial<TableDeck>;
	if (s.v !== 1 || typeof s.seatedAt !== 'number') return null;
	const ready = s.ready === true;
	const table = typeof s.table === 'string' ? s.table : undefined;
	const seriesDeck = typeof s.seriesDeck === 'string' ? s.seriesDeck : readDeck(s.seriesDeck);
	const ai = typeof s.aiDeck === 'string' ? { aiDeck: s.aiDeck } : {};
	// A row written before seats were their own act: the deck's fields sit flat
	// beside `ready`. It still reads as a seat that holds that deck.
	if (!('deck' in s)) {
		const deck = readDeck(s);
		return deck === null ? null : { v: 1, table, deck, ready, seatedAt: s.seatedAt, seriesDeck, ...ai };
	}
	if (s.deck === null) return { v: 1, table, deck: null, ready, seatedAt: s.seatedAt, seriesDeck, ...ai };
	const deck = readDeck(s.deck);
	return deck === null ? null : { v: 1, table, deck, ready, seatedAt: s.seatedAt, seriesDeck, ...ai };
}

/** The players whose seats hold a deck, in seat order; a seat without one is left out. */
function loadedOf(players: TablePlayer[]): LoadedPlayer[] {
	const out: LoadedPlayer[] = [];
	for (const p of players) if (p.state.deck !== null) out.push({ ...p, deck: p.state.deck });
	return out;
}

interface TablePlayer {
	/** The room's member row, verbatim — `playersOf` does not rebuild it. */
	member: RoomViewLike['members'][number];
	state: TablePlayerState;
}

/**
 * The (at most two) players at ONE of a room's tables: the members who hold a
 * seat THERE, earliest first. A third member who sits or loads a deck at that
 * table is refused, so this never has to choose between three.
 *
 * `tableId` defaults to the room's FIRST table — every request without a
 * `table` field means `tables[0]` (the wire contract). A member's own stored
 * seat with no `table` tag (a row written before multi-table rooms existed)
 * is read as the first table too, which is what it actually was.
 */
function playersOf(rooms: TablesRooms, room: RoomViewLike, tableId: string = room.tables[0]!.id): TablePlayer[] {
	const held: TablePlayer[] = [];
	for (const member of room.members) {
		const state = readPlayerState(rooms.playerState(room.id, member.id));
		if (state === null) continue;
		if ((state.table ?? room.tables[0]!.id) !== tableId) continue;
		held.push({ member, state });
	}
	return held.sort((a, b) => a.state.seatedAt - b.state.seatedAt);
}

/**
 * The `seatedAt` of a seat taken now: after every seat already held, even one taken in this same
 * millisecond — two sits a clock tick apart would otherwise tie, and the sort would put them in
 * member order instead of the order people sat.
 */
function nextSeatedAt(players: TablePlayer[]): number {
	return Math.max(Date.now(), ...players.map((p) => p.state.seatedAt + 1));
}

/**
 * Tell the room's running match that the seat a member holds has a new face. The
 * avatar itself stays in the room (`TablesHandle.seatAvatar` is how the match
 * reads it); this only says when to re-send the roster. A member with no seat
 * there (not claimed, no match, match gone) is a no-op.
 */
export function relayAvatarToMatch(rooms: TablesRooms, registry: TablesMatches | null, change: { roomId: string; memberId: string }): void {
	if (registry === null) return;
	const room = rooms.get(change.roomId);
	if (room === undefined) return;
	// Every table with a live match, not only the first (wave 71): a member
	// holds at most one seat at a time, but checking every table is cheap and
	// correct even if that ever changes.
	for (const table of room.tables) {
		if (table.matchId === null) continue;
		const match = registry.get(table.matchId);
		if (match === undefined || (match.status !== 'starting' && match.status !== 'running')) continue;
		const seat = match.seatOf(change.memberId);
		if (seat === null) continue;
		match.seatAvatarChanged(seat);
	}
}

/**
 * Which seat won a table's just-finished match, for the series ledger.
 *
 * `concededBy` is the reliable signal (a seat index, set from the wire frame
 * `apps/server/src/play/match.ts` itself read): the OTHER seat won. Without a
 * concede, Forge's own `winner` is the WINNING player's display NAME
 * (`PlayBridge.java`'s `getWinningLobbyPlayer().getName()`), matched against
 * each seat's own `displayName` (the same string `startFromRoom` sent Forge as
 * `names`) — after Forge's own losers mapped by seat (`Match.winnerSeat`), which
 * is what decides an AI game. `null` when nothing resolves a seat — two seats
 * with the same name, or no winner at all — rather than a guess:
 * `RoomTableGame.winner` allows it.
 */
export function winnerSeatOf(match: {
	winner: string | null;
	winnerSeat?: 0 | 1 | null;
	concededBy: number | null;
	seats: readonly { displayName?: string }[];
}): 0 | 1 | null {
	if (match.concededBy === 0) return 1;
	if (match.concededBy === 1) return 0;
	// Forge's own losers, mapped by seat (`Match.winnerSeat`): the one answer an
	// AI game has, whose AI seat no name matches.
	if (match.winnerSeat === 0 || match.winnerSeat === 1) return match.winnerSeat;
	if (match.winner === null) return null;
	const seat = match.seats.findIndex((s) => s.displayName === match.winner);
	return seat === 0 || seat === 1 ? seat : null;
}

export function attachTables(api: Router, deps: TablesDeps): TablesHandle {
	const log = deps.log ?? defaultLog;
	const { library } = deps;
	const random = deps.random ?? secureRandom;
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

	tables.get('/formats', (_req: Request, res: Response) => {
		res.json({
			formats: [
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
				era: d.era,
				name: d.deck.name,
				// The name's two halves as the library records them, so a screen
				// never splits a label to find who played the deck.
				archetype: d.deck.archetype,
				pilot: d.deck.pilot,
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

	// Q6: a seat's avatar is its holder's, read from the room. A member who changes
	// theirs mid-match is heard by the room alone, so the match is told to re-send
	// its roster. Subscribed here because this is the one file that holds both the
	// room registry and play's match registry.
	rooms?.onAvatarChange?.((change) => {
		relayAvatarToMatch(rooms, deps.matches?.() ?? null, change);
	});

	/**
	 * A seated drafter's saved build, already checked against their own pool
	 * (`draftPoolForMember`, the SAME per-person resolution every other
	 * drafted-pool check in this file uses) — "C's store plus the gate's
	 * draft check" (wave 72 §P). `null` for no saved deck, or one that fails
	 * the check — `PodChecks.built`/`.seatState` both read it the same way.
	 */
	function builtDeckVerdict(podId: string, memberId: string): { text: string; verdict: SeatVerdict } | null {
		const draftRooms = deps.draftRooms;
		if (draftRooms === null) return null;
		const room = draftRooms.find(podId);
		if (room === undefined) return null;
		const dck = builtDeckOf(room, memberId);
		if (dck === null) return null;
		const verdict = checkSeat({ deck: { dck }, rules: { kind: 'draft', draftId: podId } }, contextFor(memberId));
		if ('error' in verdict || !verdict.legal) return null;
		return { text: verdict.text, verdict };
	}

	// Wave 72 §P: this file is the one place that holds both `room/lobby.ts`'s
	// `Lobby` (as `rooms`) and `draftRooms`/the gate, so it is where the two
	// late-bound wires `PodChecks`'s own doc describes are made — `index.ts`
	// is not touched for either.
	rooms?.setPodChecks?.({
		draftComplete(podId) {
			const room = deps.draftRooms?.find(podId);
			return room !== undefined && stateOf(room).status === 'complete';
		},
		built(podId, memberId) {
			return builtDeckVerdict(podId, memberId) !== null;
		},
		seatState(podId, memberId, tableId) {
			const built = builtDeckVerdict(podId, memberId);
			if (built === null) return null;
			const { text, verdict } = built;
			const { text: _text, ...verdictWithoutText } = verdict;
			const state: TablePlayerState = {
				v: 1,
				table: tableId,
				deck: { choice: { deck: { dck: text }, rules: { kind: 'draft', draftId: podId } }, verdict: verdictWithoutText, text },
				ready: false,
				seatedAt: Date.now(),
				seriesDeck: null,
			};
			return state;
		},
	});
	deps.draftRooms?.setPodLookup((podId) => rooms?.podDraft?.(podId) ?? null);

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
	 * The table a request names, or `tables[0]` when it names none — the wire
	 * contract's rule for every table-scoped route (`?table=` on a GET, a
	 * `table` body field otherwise). A value that names no table of THIS room
	 * is its own 404, distinct from `NO_ROOM`, so a client can tell "wrong
	 * room" from "wrong table".
	 */
	function resolveTable(room: RoomViewLike, raw: unknown): { ok: true; table: RoomTable } | { ok: false; status: number; error: string } {
		if (raw === undefined) return { ok: true, table: room.tables[0]! };
		if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, status: 400, error: 'table must be a table id' };
		const table = room.tables.find((t) => t.id === raw);
		return table === undefined ? { ok: false, status: 404, error: 'no such table' } : { ok: true, table };
	}

	/**
	 * The room and table AFTER a mutation this same handler just made — the
	 * same "re-read before building the response" discipline the original
	 * single-table code kept (`tableView(rooms.get(room.id) ?? room, me)`),
	 * generalised to a table id rather than the room's only one. Falls back to
	 * what the handler already had when the registry cannot be read again.
	 */
	function freshTable(roomId: string, tableId: string, fallbackRoom: RoomViewLike, fallbackTable: RoomTable): { room: RoomViewLike; table: RoomTable } {
		const room = rooms?.get(roomId) ?? fallbackRoom;
		const table = room.tables.find((t) => t.id === tableId) ?? fallbackTable;
		return { room, table };
	}

	/**
	 * The room's match if it is still one you could play, and null otherwise —
	 * releasing a match id the registry has forgotten OR has marked finished.
	 * Rooms persist across a restart and so do matches, but only the ones play
	 * could adopt: a room whose match did not come back holds the id of a match
	 * that no longer exists, and without this could never start another one.
	 * `releaseGoneMatches` runs this over every room at boot.
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
	 * about a table's match, so it is also where the table is told to let go
	 * of it. **Two different letting-go's, since wave 71 (§D bullet 3):** a
	 * match the registry reports `over` ACTUALLY ended, so the series ledger
	 * advances (`recordGameResult` — the game is appended, a seat's `wins` may
	 * increment, the phase may become `sideboarding` or `done`); a match that
	 * is simply GONE (`stopped`/`failed`, or the registry has no record at
	 * all) has no outcome to record (`releaseTableMatch` — the series' phase is
	 * untouched). Either way the decks stay held — a Rematch plays them again
	 * — and nobody is ready, because the start that made this match spent both
	 * Readys.
	 */
	/**
	 * A table's game ACTUALLY ended: the ledger records it, and once that
	 * makes the series `done`, every seat goes back to its registered deck
	 * (`TablePlayerState.seriesDeck`). MTG's own rule: sideboarding lasts for
	 * one match. A row with nothing to put back (a registered deck persisted
	 * as text alone, or none) keeps whatever it holds.
	 */
	function recordGame(room: RoomViewLike, table: RoomTable, matchId: string, winner: 0 | 1 | null): void {
		if (rooms === null) return;
		rooms.recordGameResult(room.id, table.id, { matchId, winner });
		log({ evt: 'table-game-over', room: room.id, table: table.id, matchId, winner });
		const after = rooms.get(room.id);
		if (after?.tables.find((t) => t.id === table.id)?.series.phase !== 'done') return;
		for (const p of playersOf(rooms, after, table.id)) {
			const registered = p.state.seriesDeck;
			if (registered === null || typeof registered === 'string') continue;
			rooms.setPlayerState(room.id, p.member.id, { ...p.state, deck: registered, ready: false });
			log({ evt: 'room-deck-restored', room: room.id, table: table.id, deck: registered.verdict.deckName });
		}
	}

	function liveMatchId(room: RoomViewLike, table: RoomTable): string | null {
		if (table.matchId === null) return null;
		const registry = deps.matches?.() ?? null;
		// No registry to ask: report what the table holds rather than clearing it.
		if (registry === null || rooms === null) return table.matchId;
		const match = registry.get(table.matchId);
		if (match === undefined) {
			rooms.releaseTableMatch(room.id, table.id);
			log({ evt: 'table-match-cleared', room: room.id, table: table.id, matchId: table.matchId, reason: 'gone' });
			return null;
		}
		if (match.status !== 'over' && match.status !== 'stopped' && match.status !== 'failed') return table.matchId;
		if (match.status === 'over') {
			recordGame(room, table, table.matchId, winnerSeatOf(match));
		} else {
			rooms.releaseTableMatch(room.id, table.id);
			log({ evt: 'table-match-cleared', room: room.id, table: table.id, matchId: table.matchId, reason: match.status });
		}
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
	/**
	 * The pool a room's TABLE actually plays — `room.format` for a constructed
	 * room, and the pod's own drafted pool for a `draft` one (wave 72 §P).
	 *
	 * `room.format` is a constructed room's own setting (`PATCH /api/rooms/:id
	 * { format }`) and nothing a `draft` room's leader ever points at its own
	 * pod with — there was no table route to need that before this wave, so
	 * it is typically some unrelated frozen era. A pod's tables play the pod
	 * EVERYONE THERE drafted, and `room.id` IS that pod's id (wave 23's "one
	 * door, one id"), so this never has to ask the draft registry which pod a
	 * draft room's table plays.
	 */
	function effectivePoolOf(room: RoomViewLike): string {
		return room.gameType === 'draft' ? draftPoolId(room.id) : room.format;
	}

	function poolName(pool: string): string {
		const draftId = draftIdOfPool(pool);
		if (draftId !== null) return `their own pool from ${draftId}`;
		if (pool === FREE_PICK) return 'Free pick';
		return library.format(pool)?.pool.name ?? pool;
	}

	/**
	 * Both seats ready, or a match live: the table is nobody's to leave. The
	 * ruling (2026-10-12): "players should be able to give up their seat, but
	 * not after both players are ready. when both players are ready and the
	 * match is initiated then they are locked in until they concede".
	 */
	function tableLocked(players: TablePlayer[], matchId: string | null): boolean {
		return matchId !== null || (players.length >= TABLE_SEATS && players.every((p) => p.state.ready));
	}

	/**
	 * The table as ONE caller may see it: every seat's name and ready flag, and
	 * the caller's own deck — never anybody else's.
	 *
	 * The operator, 2026-10-21: *"don't reveal the deck that someone has picked
	 * in constructed rooms, that's giving away information. just showing whether
	 * or not they are ready is good enough."* So another seat carries no deck
	 * field at all — not its name, its legality, its fault count or its choice —
	 * for the other player and for a member with no seat alike. Ready is enough
	 * to know who is being waited on, and it already implies a legal deck:
	 * `POST …/ready` refuses without one, and every deck load clears it.
	 *
	 * Your own deck's faults are a count; the list is named once, by the
	 * refusal when you try to ready.
	 */
	function tableView(room: RoomViewLike, me: string, table: RoomTable): Record<string, unknown> {
		// `liveMatchId` FIRST: it can write the table (`recordGameResult` /
		// `releaseTableMatch`), and `playersOf` has to read the room AFTER that
		// write or this very response could describe a room it also reports as
		// changed (R16).
		const matchId = liveMatchId(room, table);
		const players = rooms === null ? [] : playersOf(rooms, room, table.id);
		// The seat mirror `RoomTable.players` is built from (`room/lobby.ts`'s
		// `Lobby.setTableSeats`): refreshed on every READ, not only a write, so a
		// migrated or otherwise-stale room self-heals the next time its table is
		// asked about. A no-op write does not persist — safe to call unconditionally.
		rooms?.setTableSeats(room.id, table.id, players.map((p) => p.member.id));
		return {
			room: {
				id: room.id,
				name: room.name,
				gameType: room.gameType,
				// The pool both decks are checked in — a pod's own drafted pool for a
				// draft room (`effectivePoolOf`), `room.format` otherwise. The screen
				// shows it, and only the leader's copy of the screen may change it
				// (`PATCH /api/rooms/:id`) for a constructed room. A dealt All Random
				// table's is the era its decks came from (`tablePoolOf`).
				format: tablePoolOf(room, players),
				// The pod behind a drafted pool, or null for a frozen era. Derived from
				// `format` and sent anyway, so a client does not have to know the
				// spelling of the prefix to draw a table on a drafted pool.
				draftId: draftIdOfPool(effectivePoolOf(room)),
				matchId,
				seats: TABLE_SEATS,
				// The operator's ruling (2026-10-12): once both players are ready, or a
				// match is live, the seats are locked and nobody stands up. One fact,
				// so the screen draws Stand up disabled from the same bit the server
				// refuses on (`tableLocked`).
				locked: tableLocked(players, matchId),
				// The table's series phase, read AFTER `liveMatchId`'s own write, so a
				// table read that just recorded a game already says where it led. A
				// screen that follows the table learns of a move into `sideboarding`
				// here even when nobody's ready flag changed: the agreement that
				// begins it spends both Readys, so the flags read as they did before.
				phase: rooms?.get(room.id)?.tables.find((t) => t.id === table.id)?.series.phase ?? table.series.phase,
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
				ready: p.state.ready,
				// Yours alone; null for a seat you took ahead of a deck.
				...(p.member.id === me ? { deck: ownDeckView(p.state.deck) } : {}),
			})),
		};
	}

	/** Every room route answers this, and only this, when you may not act. */
	function notFound(res: Response): void {
		res.status(404).json({ error: NO_ROOM });
	}

	/**
	 * A table is a constructed 1v1 table, OR a pod table once the pod's
	 * rounds have started (wave 72 §P — pod tables are made and seated by the
	 * server, `room/lobby.ts`'s `playPod`; players don't sit at them
	 * themselves, but every OTHER table route — ready, deck, start — works
	 * exactly as it does for a constructed room's table). Still a table once
	 * the pod is `done`: the one drafter of a pod of bots plays the AI again
	 * from it.
	 */
	function wrongGameType(room: RoomViewLike, res: Response): boolean {
		if (room.gameType === CONSTRUCTED) return false;
		if (room.gameType === 'draft' && (room.pod?.phase === 'rounds' || room.pod?.phase === 'done')) return false;
		res.status(409).json({ error: `this room plays ${room.gameType}, not ${CONSTRUCTED} or a pod at its tables` });
		return true;
	}

	/**
	 * The rules every deck at a table is checked against, from the table's pool
	 * (`tablePoolOf`).
	 *
	 * One RULE, both seats, whoever is asking — and for a drafted pool that rule
	 * still resolves to two different card lists, because the draft arm resolves
	 * per person (`draftPoolForMember`). The thing the room owns is the POD, not
	 * the cards: nobody at this table can be checked against a pod they did not
	 * draft in, and nobody can be checked against another player's 45.
	 */
	function rulesOf(pool: string): DeckRules {
		if (pool === FREE_PICK) return { kind: 'free' };
		const draftId = draftIdOfPool(pool);
		return draftId === null ? { kind: 'standard', format: pool } : { kind: 'draft', draftId };
	}

	/** An All Random room's pool, or null for every other room. */
	function randomPoolOf(room: RoomViewLike): RandomPool | null {
		if (room.gameType !== CONSTRUCTED || room.mode !== 'random') return null;
		const options = RandomOptionsSchema.safeParse(room.modeOptions);
		return options.success ? options.data.pool : null;
	}

	/**
	 * The pool ONE table plays: the room's (`effectivePoolOf`), except at a dealt
	 * All Random table, where it is the era its decks were drawn from. Every deck
	 * `dealRandom` holds records that era in its `choice.rules`, so two tables of
	 * one room play their own eras and a Rematch keeps its own.
	 */
	function tablePoolOf(room: RoomViewLike, players: TablePlayer[]): string {
		if (randomPoolOf(room) !== null) {
			for (const p of players) {
				const rules = p.state.deck?.choice.rules;
				if (rules?.kind === 'standard') return rules.format;
			}
		}
		return effectivePoolOf(room);
	}

	/**
	 * Deal an All Random table (rulings 3 and 4): one random era of the room's
	 * pool, and a different deck from it for each seat — the AI's included,
	 * held beside its one human's (`aiDeck`). Held exactly as a picked Classic
	 * deck is, so everything after (the start's legality check, the registered
	 * deck, a Rematch) reads it the same way.
	 *
	 * A no-op for any other room, and for a table whose seats already hold their
	 * decks: that is a Rematch, and it plays the same two. Answers the table's
	 * players as they stand after the deal.
	 */
	function dealRandom(
		room: RoomViewLike,
		tableId: string,
		players: TablePlayer[],
		vsBot: boolean,
	): { ok: true; players: TablePlayer[] } | { ok: false; error: string } {
		const pool = randomPoolOf(room);
		if (pool === null || rooms === null) return { ok: true, players };
		const held = players.every((p) => p.state.deck !== null) && (!vsBot || players[0]?.state.aiDeck !== undefined);
		if (held) return { ok: true, players };
		const draw = drawRandomDecks(random, pool, library);
		if (draw === null) return { ok: false, error: `no ${pool} era holds two decks` };
		const rules: DeckRules = { kind: 'standard', format: draw.era };
		const decks: TableDeck[] = [];
		for (const [seat, id] of draw.decks.entries()) {
			const owner = players[seat]?.member.id ?? players[0]!.member.id;
			const verdict = checkSeat({ deck: { library: id }, rules }, contextFor(owner));
			if ('error' in verdict) return { ok: false, error: verdict.error };
			if (!verdict.legal) return { ok: false, error: refusalLine(seat, verdict) };
			decks.push({ choice: { deck: { library: id }, rules }, verdict: publicVerdict(verdict), text: verdict.text });
		}
		for (const [seat, p] of players.entries()) {
			const state: TablePlayerState = { ...p.state, deck: decks[seat]! };
			if (vsBot) state.aiDeck = decks[1]!.text;
			else delete state.aiDeck;
			rooms.setPlayerState(room.id, p.member.id, state);
		}
		log({ evt: 'room-random-dealt', room: room.id, table: tableId, pool, era: draw.era, decks: draw.decks, ...(vsBot ? { opponent: 'ai' } : {}) });
		return { ok: true, players: playersOf(rooms, room, tableId) };
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
		const pool = effectivePoolOf(room);
		const draftId = draftIdOfPool(pool);
		if (draftId === null) {
			if (pool === FREE_PICK || library.format(pool) !== undefined) return false;
			res.status(409).json({ error: `this room's format ${JSON.stringify(pool)} is not one this server has` });
			return true;
		}
		if (deps.draftRooms?.find(draftId) !== undefined) return false;
		res.status(409).json({ error: `this room's draft ${JSON.stringify(draftId)} is not one this server has` });
		return true;
	}

	/**
	 * `entries`' cards, by NAME — never `cardKey` (set/collector/art), because
	 * the sideboard rule is "the same cards, only re-split" and printing does
	 * not matter to it. A library-deck seat's baseline is the `.dck` text,
	 * which carries a set code ("4 Mana Leak|8E"); the browser never sees one
	 * back (`GET /tables/decks` sends only `{count, name}`), so its own
	 * resubmission is bare names — keying by `cardKey` made every one of its
	 * cards a different key from the baseline's and 409'd an UNTOUCHED deck
	 * every time. Basics folded in UNLESS `excludeBasics`.
	 */
	function multisetOf(entries: readonly DeckEntry[], excludeBasics: boolean): Map<string, number> {
		const m = new Map<string, number>();
		for (const e of entries) {
			if (excludeBasics && isBasicLand(e.card)) continue;
			const key = e.card.name;
			m.set(key, (m.get(key) ?? 0) + e.count);
		}
		return m;
	}

	function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
		if (a.size !== b.size) return false;
		for (const [k, v] of a) if (b.get(k) !== v) return false;
		return true;
	}

	/**
	 * Whether `nextText` is a legal sideboard move from `previousText` — the
	 * same cards, split differently between main and board — the check `PUT
	 * …/deck` runs during a table's `sideboarding` phase (§D bullet 3). Basic
	 * lands are excluded from the comparison when the room's pool is a DRAFTED
	 * one (`draftIdOfPool`): a draft's deck editor treats basics as free and
	 * unlimited, so sideboarding one does too. For every other pool a basic is
	 * part of the fixed 75 like any other card. `null` when it is legal.
	 */
	function sideboardIssue(room: RoomViewLike, previousText: string, nextText: string): string | null {
		const excludeBasics = draftIdOfPool(effectivePoolOf(room)) !== null;
		const previous = multisetOf(poolOf(deckFromDeckFile(parseDck(previousText))), excludeBasics);
		const next = multisetOf(poolOf(deckFromDeckFile(parseDck(nextText))), excludeBasics);
		return sameMultiset(previous, next)
			? null
			: 'during sideboarding you may only move cards between your main deck and sideboard, never add or remove one';
	}

	tables.get('/rooms/:roomId', (req: Request, res: Response) => {
		const found = tableFor(req, String(req.params.roomId));
		if (found === null) {
			notFound(res);
			return;
		}
		const resolved = resolveTable(found.room, req.query.table);
		if (!resolved.ok) {
			res.status(resolved.status).json({ error: resolved.error });
			return;
		}
		res.json(tableView(found.room, found.me, resolved.table));
	});

	tables.put('/rooms/:roomId/deck', (req: Request, res: Response) => {
		const found = tableFor(req, String(req.params.roomId));
		if (found === null || rooms === null) {
			notFound(res);
			return;
		}
		const { room, me } = found;
		if (wrongGameType(room, res)) return;
		const parsed = parseDeckBody(req.body);
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		const resolved = resolveTable(room, parsed.table);
		if (!resolved.ok) {
			res.status(resolved.status).json({ error: resolved.error });
			return;
		}
		const table = resolved.table;
		if (liveMatchId(room, table) !== null) {
			res.status(409).json({ error: 'the match has already started' });
			return;
		}
		if (unknownPool(room, res)) return;
		// An All Random table's decks are dealt (`dealRandom`); a seat changes its own
		// only by sideboarding it, in the era it was dealt.
		if (randomPoolOf(room) !== null && table.series.phase !== 'sideboarding') {
			res.status(409).json({ error: 'the decks at an All Random table are dealt' });
			return;
		}
		const players = playersOf(rooms, room, table.id);
		const seat: SeatRequest = { deck: parsed.deck, rules: rulesOf(tablePoolOf(room, players)) };
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
		// Sideboarding (§D bullet 3): a resubmission is accepted only when it is
		// the SAME 75(ish) the series started with, differently split — never a
		// different deck wearing the room's legality check.
		const registered = mine === undefined ? null : seriesTextOf(mine.state);
		if (table.series.phase === 'sideboarding' && registered !== null) {
			const issue = sideboardIssue(room, registered, verdict.text);
			if (issue !== null) {
				res.status(409).json({ error: issue });
				return;
			}
		}
		// A new deck un-readies you: what you readied with is not what you hold.
		// `choice` keeps the room's rules beside the deck, so the hold records which
		// pool its verdict was taken in even after the leader moves the room.
		//
		// Loading a deck while unseated takes a free seat (`mine === undefined`
		// and the table not full, above): a browser that goes Random → Ready
		// without sitting first still plays, and so does every spec written
		// before `POST …/sit` existed.
		const state: TablePlayerState = {
			v: 1,
			table: table.id,
			deck: { choice: seat, verdict: publicVerdict(verdict), text: verdict.text },
			ready: false,
			seatedAt: mine?.state.seatedAt ?? nextSeatedAt(players),
			seriesDeck: mine?.state.seriesDeck ?? null,
		};
		if (!rooms.setPlayerState(room.id, me, state)) {
			notFound(res);
			return;
		}
		log({ evt: 'room-deck-loaded', room: room.id, table: table.id, deck: verdict.deckName, rules: verdict.rulesName, legal: verdict.legal, sat: mine === undefined });
		const after = freshTable(room.id, table.id, room, table);
		res.json(tableView(after.room, me, after.table));
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
		if (typeof body.ready !== 'boolean' || keys.some((k) => k !== 'ready' && k !== 'table')) {
			res.status(400).json({ error: 'body is { ready: boolean, table? }' });
			return;
		}
		const resolved = resolveTable(room, body.table);
		if (!resolved.ok) {
			res.status(resolved.status).json({ error: resolved.error });
			return;
		}
		const table = resolved.table;
		if (liveMatchId(room, table) !== null) {
			res.status(409).json({ error: 'the match has already started' });
			return;
		}
		const players = playersOf(rooms, room, table.id);
		const seat = players.findIndex((p) => p.member.id === me);
		const mine = players[seat];
		// A seat without a deck readies nothing: the same sentence for "not
		// seated" and "seated, no deck", because the fix is the same. An All
		// Random seat readies with none: both Readys deal the decks, below.
		const dealt = randomPoolOf(room) !== null;
		if (mine === undefined || (mine.state.deck === null && !dealt)) {
			res.status(409).json({ error: dealt ? 'take a seat before you ready up' : 'load a deck before you ready up' });
			return;
		}
		// An illegal deck blocks THIS player's ready and nobody else's, and says
		// which card did it — the same sentence the gate refuses a match with.
		if (body.ready && mine.state.deck !== null && !mine.state.deck.verdict.legal) {
			const line = refusalLine(seat, { ...mine.state.deck.verdict, text: mine.state.deck.text });
			log({ evt: 'room-ready-refused', room: room.id, table: table.id, issues: mine.state.deck.verdict.issues.length });
			res.status(422).json({ error: line });
			return;
		}
		if (!rooms.setPlayerState(room.id, me, { ...mine.state, ready: body.ready })) {
			notFound(res);
			return;
		}
		// The operator's "both players press Rematch" (§D bullet 3): whenever a
		// `ready: true` leaves BOTH of this table's seats ready, offer the
		// lobby the chance to begin a sideboarding step. It is a no-op unless
		// the table is a just-finished bo1-with-sideboarding series — see
		// `Lobby.beginSideboarding`'s own doc. When it does begin one, the
		// step spends both Readys, the same as a start does (`startFromRoom`):
		// the answer below, and every read after it, shows nobody ready.
		//
		// At an All Random table the same moment deals the decks (`dealRandom`),
		// so both seats hold theirs before either browser asks to start.
		if (body.ready) {
			const nowPlayers = playersOf(rooms, room, table.id);
			if (nowPlayers.length === TABLE_SEATS && nowPlayers.every((p) => p.state.ready)) {
				const deal = dealRandom(room, table.id, nowPlayers, false);
				if (!deal.ok) {
					rooms.setPlayerState(room.id, me, { ...mine.state, ready: false });
					res.status(409).json({ error: deal.error });
					return;
				}
				if (rooms.beginSideboarding(room.id, table.id)) {
					for (const p of deal.players) rooms.setPlayerState(room.id, p.member.id, { ...p.state, ready: false });
				}
			}
		}
		log({ evt: 'room-ready', room: room.id, table: table.id, ready: body.ready });
		const after = freshTable(room.id, table.id, room, table);
		res.json(tableView(after.room, me, after.table));
	});

	/**
	 * Sitting is its own act (2026-10-12). Idempotent: a seat you hold is
	 * answered 200 with the table as it stands. A deck is NOT required to sit,
	 * and `PUT …/deck` still seats an unseated caller, so neither path is the
	 * only way in.
	 */
	tables.post('/rooms/:roomId/sit', (req: Request, res: Response) => {
		const found = tableFor(req, String(req.params.roomId));
		if (found === null || rooms === null) {
			notFound(res);
			return;
		}
		const { room, me } = found;
		if (wrongGameType(room, res)) return;
		const parsedBody = parseTableBody(req.body);
		if (!parsedBody.ok) {
			res.status(400).json({ error: parsedBody.error });
			return;
		}
		const resolved = resolveTable(room, parsedBody.table);
		if (!resolved.ok) {
			res.status(resolved.status).json({ error: resolved.error });
			return;
		}
		const table = resolved.table;
		if (liveMatchId(room, table) !== null) {
			res.status(409).json({ error: 'the match has already started' });
			return;
		}
		const players = playersOf(rooms, room, table.id);
		if (players.some((p) => p.member.id === me)) {
			res.json(tableView(room, me, table));
			return;
		}
		if (players.length >= TABLE_SEATS) {
			res.status(409).json({ error: 'this table already has two players' });
			return;
		}
		const state: TablePlayerState = { v: 1, table: table.id, deck: null, ready: false, seatedAt: nextSeatedAt(players), seriesDeck: null };
		if (!rooms.setPlayerState(room.id, me, state)) {
			notFound(res);
			return;
		}
		log({ evt: 'room-sat', room: room.id, table: table.id, seat: players.length });
		const after = freshTable(room.id, table.id, room, table);
		res.json(tableView(after.room, me, after.table));
	});

	/**
	 * Giving the seat back, with the deck and the ready flag that sat on it.
	 * Refused once the table is locked (`tableLocked`): the server enforces the
	 * ruling, the screen only mirrors it. Nobody can stand somebody else up —
	 * the seat row is the caller's own, as every other write here is.
	 */
	tables.post('/rooms/:roomId/stand', (req: Request, res: Response) => {
		const found = tableFor(req, String(req.params.roomId));
		if (found === null || rooms === null) {
			notFound(res);
			return;
		}
		const { room, me } = found;
		if (wrongGameType(room, res)) return;
		const parsedBody = parseTableBody(req.body);
		if (!parsedBody.ok) {
			res.status(400).json({ error: parsedBody.error });
			return;
		}
		const resolved = resolveTable(room, parsedBody.table);
		if (!resolved.ok) {
			res.status(resolved.status).json({ error: resolved.error });
			return;
		}
		const table = resolved.table;
		const matchId = liveMatchId(room, table);
		if (matchId !== null) {
			res.status(409).json({ error: 'the match has already started' });
			return;
		}
		const players = playersOf(rooms, room, table.id);
		const seat = players.findIndex((p) => p.member.id === me);
		if (seat < 0) {
			res.json(tableView(room, me, table));
			return;
		}
		if (tableLocked(players, matchId)) {
			res.status(409).json({ error: 'both players are ready — the table is locked' });
			return;
		}
		if (!rooms.setPlayerState(room.id, me, undefined)) {
			notFound(res);
			return;
		}
		log({ evt: 'room-stood', room: room.id, table: table.id, seat, hadDeck: players[seat]!.state.deck !== null });
		const after = freshTable(room.id, table.id, room, table);
		res.json(tableView(after.room, me, after.table));
	});

	/**
	 * Leader only. `POST /api/tables/rooms/:roomId/tables` — the wire
	 * contract's first table route: appends an empty table and answers its
	 * `RoomTable`.
	 */
	tables.post('/rooms/:roomId/tables', (req: Request, res: Response) => {
		if (rooms === null) {
			notFound(res);
			return;
		}
		const roomId = String(req.params.roomId);
		const room = rooms.get(roomId);
		const me = callerIdOf(req);
		if (room === undefined || !room.members.some((m) => m.id === me)) {
			notFound(res);
			return;
		}
		const result = rooms.addTable(roomId, me);
		if (!result.ok) {
			res.status(403).json({ error: 'only the room leader can add a table' });
			return;
		}
		log({ evt: 'table-added', room: roomId, table: result.table.id });
		res.status(201).json(result.table);
	});

	/**
	 * Leader only. `DELETE /api/tables/rooms/:roomId/tables/:tableId` — removes
	 * an empty, idle table other than the first.
	 */
	tables.delete('/rooms/:roomId/tables/:tableId', (req: Request, res: Response) => {
		if (rooms === null) {
			notFound(res);
			return;
		}
		const roomId = String(req.params.roomId);
		const tableId = String(req.params.tableId);
		const room = rooms.get(roomId);
		const me = callerIdOf(req);
		if (room === undefined || !room.members.some((m) => m.id === me)) {
			notFound(res);
			return;
		}
		const result = rooms.removeTable(roomId, me, tableId);
		if (!result.ok) {
			const messages: Record<string, string> = {
				'not-leader': 'only the room leader can remove a table',
				'no-such-table': 'no such table',
				'first-table': 'the first table cannot be removed',
				'not-idle': 'a table can be removed only when it is empty and idle',
			};
			const status = result.reason === 'not-leader' ? 403 : result.reason === 'no-such-table' ? 404 : 409;
			res.status(status).json({ error: messages[result.reason] });
			return;
		}
		log({ evt: 'table-removed', room: roomId, table: tableId });
		res.status(204).end();
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
			if (key !== 'room' && key !== 'bot' && key !== 'table') {
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
		const { room, me } = found;
		if (wrongGameType(room, res)) return;
		const resolved = resolveTable(room, body.table);
		if (!resolved.ok) {
			res.status(resolved.status).json({ error: resolved.error });
			return;
		}
		const table = resolved.table;
		// Idempotent: whichever player asks second is answered the match the
		// first one started, not a second JVM.
		const live = liveMatchId(room, table);
		if (live !== null) {
			res.status(200).json({ matchId: live });
			return;
		}
		// A pod's series is its round: once it is over, the next game is the pod's
		// next round, never another series at the same table (the operator,
		// 2026-10-19: "it seems like it just lets me keep clicking 'next game' forever").
		if (room.pod !== null && table.series.phase === 'done') {
			res.status(409).json({ error: 'this series is over — the standings are in the room' });
			return;
		}
		// Keyed by table, not room: two different tables of the same room start
		// independently.
		const startKey = `${room.id}:${table.id}`;
		const joiners = starting.get(startKey);
		if (joiners !== undefined) {
			joiners.push((status, payload) => res.status(status).json(payload));
			return;
		}
		let players = playersOf(rooms, room, table.id);
		if (vsBot) {
			// One person against Forge's AI, from a room (the operator, 2026-10-02:
			// "would be nice to be able to add a bot so i dont have to play against
			// myself everytime"). Only when the caller is the room's ONLY member:
			// with two people in the room they play each other, and a bot start
			// would take the table out from under the second one.
			//
			// Since 2026-10-12 the gate is on SEATS, not members: a crowded watchparty
			// room mounts the table for everyone at once, so "the only member" was
			// never true there and the AI was unreachable at a party. One seated
			// human, and it is the caller: the rest of the room watches.
			if (players.length !== 1 || players[0]!.member.id !== me) {
				res.status(409).json({ error: 'a bot game is for a table with one seated player' });
				return;
			}
			const deal = dealRandom(room, table.id, players, true);
			if (!deal.ok) {
				res.status(409).json({ error: deal.error });
				return;
			}
			players = deal.players;
			if (players[0]!.state.deck === null) {
				res.status(409).json({ error: 'load a deck first' });
				return;
			}
		} else {
			if (players.length < TABLE_SEATS) {
				res.status(409).json({ error: 'both players have to load a deck first' });
				return;
			}
			const unloaded = players.find((p) => p.state.deck === null);
			if (unloaded !== undefined) {
				res.status(409).json({ error: `${unloaded.member.name} has not loaded a deck` });
				return;
			}
			const waiting = players.find((p) => !p.state.ready);
			if (waiting !== undefined) {
				res.status(409).json({ error: `${waiting.member.name} is not ready yet` });
				return;
			}
		}
		// Every seat that plays holds a deck from here on; the two gates above are
		// what make this a statement and not a hope.
		const loaded = loadedOf(players);
		if (loaded.length !== players.length) {
			res.status(409).json({ error: 'a seated player has not loaded a deck' });
			return;
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
		const pool = tablePoolOf(room, players);
		for (const player of loaded) {
			const verdict = checkSeat(
				{ deck: { dck: player.deck.text }, rules: rulesOf(pool) },
				contextFor(player.member.id),
			);
			if ('error' in verdict) {
				res.status(409).json({ error: `this room's table cannot be checked: ${verdict.error}` });
				return;
			}
			if (!verdict.legal) {
				log({ evt: 'room-start-refused', room: room.id, issues: verdict.issues.length });
				res.status(422).json({ error: `${player.member.name}'s deck is not legal in ${poolName(pool)}` });
				return;
			}
		}
		// The bot's deck: a random one of the decks the room's pool offers a player
		// (`legalLibraryDecks` — the era's own, or the whole library on Free pick),
		// checked by the same gate as the player's. A drafted pool offers no library
		// deck, so there the bot plays what a bot at that draft took (`botDeck.ts`).
		let botDeck: string | null = null;
		if (vsBot) {
			const owner = loaded[0]!.member.id;
			const draftId = draftIdOfPool(pool);
			if (players[0]!.state.aiDeck !== undefined && randomPoolOf(room) !== null) {
				botDeck = players[0]!.state.aiDeck;
			} else if (draftId !== null) {
				const draftRoom = deps.draftRooms?.find(draftId);
				const botPool = draftRoom === undefined ? null : botPoolAcross(draftRoom, owner);
				if (botPool === null || botPool.length === 0) {
					res.status(409).json({ error: 'no bot drafted in this pod, so the AI has nothing to play' });
					return;
				}
				botDeck = botDeckText(botPool, 'Bot draft');
			} else {
				const swept = legalLibraryDecks(pool, contextFor(owner));
				const offered = 'error' in swept ? [] : swept.ids;
				if (offered.length === 0) {
					res.status(409).json({ error: `no deck in the library is legal in ${poolName(pool)}, so the bot has nothing to play` });
					return;
				}
				botDeck = library.deck(offered[Math.floor(Math.random() * offered.length)]!)!.text;
			}
		}
		const registry = deps.matches?.() ?? null;
		if (registry === null) {
			res.status(503).json({ error: 'this server cannot seat a room at a match (no match registry)' });
			return;
		}
		const playing = registry.active().filter((m) => m.status === 'starting' || m.status === 'running');
		const full = players.find((p) => playing.filter((m) => m.seatOf(p.member.id) !== null).length >= MAX_MATCHES_PER_PERSON);
		if (full !== undefined) {
			res.status(409).json({ error: `${full.member.name} is already playing ${MAX_MATCHES_PER_PERSON} matches` });
			return;
		}

		const waiting: ((status: number, payload: unknown) => void)[] = [];
		starting.set(startKey, waiting);
		let settled = false;
		/** Answer every ask that joined this start, and let the table start again. */
		const settle = (status: number, payload: unknown): void => {
			if (settled) return;
			settled = true;
			starting.delete(startKey);
			for (const join of waiting) join(status, payload);
		};
		// Play answers through `res.json`, below. A response that ends any other way
		// still frees the table. A caller who goes away mid-start (a reload) does NOT:
		// Forge is still coming up, and the reloaded page's ask joins it rather than
		// launching a second JVM.
		res.on('finish', () => settle(res.statusCode, { error: 'the match could not be started' }));

		// A new series by the ledger: `seating`/`done` (the series about to
		// start has no game of its own yet), OR `series.games` already empty,
		// which is what `Lobby.beginSideboarding` leaves a bo1 Rematch's
		// sideboarding step in. **Both halves of this OR matter** for `chooser`
		// below: `phase` alone misses a bo1 Rematch's reset-but-still-
		// `sideboarding` table; `games.length` alone misses a `done` table whose
		// OLD series' games are still sitting there (not yet reset by
		// `setTableMatch`).
		const newSeries = table.series.phase === 'seating' || table.series.phase === 'done' || table.series.games.length === 0;
		// The registered deck (`seriesDeck`) is taken only when a series begins
		// from the room — `seating` or `done` — never on a bo1 Rematch's
		// sideboarding step, whose own load is the sideboarded 75: the deck a
		// seat goes back to once the series is over is the one it registered.
		const registers = table.series.phase === 'seating' || table.series.phase === 'done';
		// The next game of a series is asked play-or-draw by the LOSER of the
		// previous one (`draft-pods-plan.md`, "The loser of the previous game
		// chooses play or draw"). The first game of a series has no previous
		// game, so `chooser` stays unset and Forge's own unrigged coin toss runs
		// (lane E's `MatchSpec.chooser?: 0 | 1`, `play/host.ts`) — **and `newSeries`
		// is what actually says "first game of a series", not merely "there is
		// no game after this one in the array": a `done` series' `games` still
		// holds its LAST game until `setTableMatch` resets it, so reading
		// `games.at(-1)` without this guard would rig a brand-new series'
		// opening game to the PREVIOUS series' loser.
		const previousGame = newSeries ? undefined : table.series.games.at(-1);
		// `newSeries && phase === 'sideboarding'` is exactly `beginSideboarding`'s
		// own reset (claw run 39046554773, 2026-10-17): `games` is already `[]`
		// (so `previousGame` above is `undefined`), but the game that just
		// decided this bo1-with-sideboarding rematch still has a loser owed
		// play-or-draw — `rooms.rematchOf` is where `beginSideboarding` carried
		// that winner through. A bo3's own mid-series sideboarding step never
		// reaches here with `newSeries` true (its `games` is never emptied), so
		// this never touches that path or a sideboarding-OFF rematch.
		const previousWinner: 0 | 1 | null =
			newSeries && table.series.phase === 'sideboarding' ? rooms.rematchOf(room.id, table.id) : (previousGame?.winner ?? null);
		const chooser: 0 | 1 | undefined = previousWinner === 0 ? 1 : previousWinner === 1 ? 0 : undefined;

		// Play answers through `res.json`, below. A response that ends any other way
		const answer = res.json.bind(res);
		res.json = ((payload: unknown) => {
			res.json = answer;
			const matchId = (payload as { matchId?: unknown }).matchId;
			if (res.statusCode === 201 && typeof matchId === 'string') {
				const refused = seatPlayers(registry, matchId, players);
				if (refused !== null) {
					log({ evt: 'room-seating-failed', room: room.id, table: table.id, matchId, error: refused });
					settle(500, { error: refused });
					res.status(500);
					return answer({ error: refused });
				}
				rooms.setTableMatch(room.id, table.id, matchId);
				// The start spends both Readys: neither carries into the match, so
				// nothing is left ready for a later read to start again — not when
				// the match ends, and not when a restart releases a match that did
				// not come back (`releaseGoneMatches`). The decks stay held: they are what a Rematch plays.
				for (const p of players) {
					rooms.setPlayerState(room.id, p.member.id, {
						...p.state,
						ready: false,
						seriesDeck: registers || p.state.seriesDeck === null ? p.state.deck : p.state.seriesDeck,
					});
				}
				log({
					evt: 'room-match-started',
					room: room.id,
					table: table.id,
					matchId,
					decks: loaded.map((p) => p.deck.verdict.deckName),
					// Which exact 75 each seat played, without the list: a name does
					// not tell a sideboarded deck from the one it came from.
					deckTexts: loaded.map((p) => createHash('sha256').update(p.deck.text).digest('hex').slice(0, 12)),
					...(vsBot ? { opponent: 'ai' } : {}),
					...(chooser === undefined ? {} : { chooser }),
				});
				settle(200, { matchId });
				return answer(payload);
			}
			settle(res.statusCode, payload);
			return answer(payload);
		}) as typeof res.json;

		// Play's own body. Each deck is the text its own player's rule checked. No
		// avatars: a seat's face is read from this room for as long as the match
		// runs (`seatAvatar`), so the match never holds a copy that could go stale.
		if (vsBot) {
			// Seat 1 is Forge's AI, playing as the room's character (`room.ai`, the
			// operator, 2026-10-19: "instead of having 'Forge AI' … fake players from
			// the avatar list"). `names` stays a pair (play refuses anything else).
			req.body = {
				opponent: 'ai',
				decks: [loaded[0]!.deck.text, botDeck!],
				names: [loaded[0]!.member.name, room.ai?.name],
				format: pool,
				handSmoothing: room.settings.handSmoothing,
				...(chooser === undefined ? {} : { chooser }),
			};
			next();
			return;
		}
		req.body = {
			opponent: 'human',
			decks: loaded.map((p) => p.deck.text),
			// Seat names (wave 31 shape 1): the same order, each the member's display
			// name, so Forge's own prompts and the board say who is who.
			names: loaded.map((p) => p.member.name),
			// The pool a card-name ask is narrowed to (`play/names.ts`) — a pod's
			// own drafted pool for a draft room, never `room.format` unmodified.
			format: pool,
			handSmoothing: room.settings.handSmoothing,
			...(chooser === undefined ? {} : { chooser }),
		};
		next();
	}

	/** A library deck's id by its exact text — what a seat's deck was picked as, read back off the spec. */
	const libraryIdByText = new Map(library.decks.map((d) => [d.text, d.id]));

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

	/**
	 * A drafted deck's stats id, `draft:<podId>` — what the Decks page reads its
	 * W–L by (`http/decks.ts`). A pod table plays its own pool; on Free pick a
	 * seat brought one from "My decks", found by its saved text.
	 */
	const draftedDeckId = (pool: string, owner: string, text: string | null): string | undefined => {
		const podId = draftIdOfPool(pool);
		if (podId !== null) return `draft:${podId}`;
		if (pool !== FREE_PICK || text === null) return undefined;
		const room = deps.draftRooms?.all().find((r) => builtDeckOf(r, owner) === text);
		return room === undefined ? undefined : `draft:${room.roomId}`;
	};

	return {
		library,
		seatAvatar(matchId, memberId) {
			const room = rooms?.roomOfMatch(matchId);
			if (memberId === AI_SEAT_OWNER) return room?.ai?.avatarId;
			return room?.members.find((m) => m.id === memberId)?.avatarId;
		},
		matchStart(match) {
			const room = rooms?.roomOfMatch(match.id);
			if (room === undefined) return null;
			// The pool the match was dealt in, from its own spec: the room's can move on after it.
			const pool = match.spec.format ?? 'unknown';
			const format = library.format(pool);
			const costs = format === undefined ? LIBRARY_CARD_COSTS : { ...LIBRARY_CARD_COSTS, ...format.fixture.manaCost };
			const family = draftIdOfPool(pool) !== null ? 'draft' : pool === FREE_PICK ? 'free' : (format?.family ?? 'unknown');
			const deckOf = (text: string | null, id = text === null ? undefined : libraryIdByText.get(text)) =>
				text === null ? null : summarizeDeck(text, costs, id);
			const seats: MatchStartInput['seats'] = match.spec.seats.map((s, i) => {
				if (s.ai) return { ai: true, memberId: null, deck: deckOf(s.deck) };
				const owner = match.seats[i]?.owner ?? null;
				const drafted = owner === null ? undefined : draftedDeckId(pool, owner, s.deck);
				const member = owner === null ? undefined : room.members.find((m) => m.id === owner);
				// The member's own name; the seat's, for a holder who has since left the room.
				const displayName = member?.name ?? match.seats[i]?.displayName;
				return {
					ai: false,
					memberId: owner,
					...(displayName === undefined ? {} : { displayName }),
					...(member?.avatarId === undefined ? {} : { avatarId: member.avatarId }),
					deck: drafted === undefined ? deckOf(s.deck) : deckOf(s.deck, drafted),
				};
			});
			return {
				mode: 'constructed',
				roomId: room.id,
				startedAt: match.startedAt,
				attrs: { format: family, pool, opponent: match.spec.seats.some((s) => s.ai) ? 'bot' : 'human' },
				seats,
			};
		},
		releaseGoneMatches() {
			for (const room of rooms?.list() ?? []) for (const table of room.tables) liveMatchId(room, table);
		},
		gameOver(match) {
			if (rooms === null) return;
			const room = rooms.roomOfMatch(match.id);
			if (room === undefined) return;
			const table = room.tables.find((t) => t.matchId === match.id);
			if (table === undefined) return;
			recordGame(room, table, match.id, winnerSeatOf(match));
		},
	};
}
