/**
 * Pods, tournaments and AI seats: a room's pod table, who plays as what AI,
 * splitting a big draft into several pods, and the round-by-round view of a
 * pod (`PodView`) the lobby's `viewOf` hands back.
 *
 * Moved out of `room/lobby.ts` (split, wave 99 §L) — these are pure functions
 * over `RoomRecord`/`GameHooks`, with no `FileLobby` state of their own.
 * `room/lobby.ts` re-imports everything it still calls, and re-exports what
 * external callers (`http/rooms.ts`, `http/routes.ts`, the room tests) have
 * always imported from it, so no other file's import path changes.
 */

import { readyParticipants } from '@wolffm/rooms-server';
import { AVATAR_POOL } from '@wolffm/rooms-protocol';
import {
	gameTypeSpec,
	POD_MAX_SEATS,
	POD_SEATS,
	SEATS_OPEN_BEFORE_MS,
	splitPods,
	type DraftPlan,
	type PodMember,
	type PodPhase,
	type PodView,
	type PoolSource,
} from '@hadoku/shared';
import { botSeatAcross, rankedStandings, rngFromSeed, roundsFor, shuffle, type MatchResult, type PodPlayer, type RankedStandingsRow } from '@hadoku/draft';
import { isGauntletState, type GauntletState } from './gauntlet.ts';
import { roundNamesOf } from './plan.ts';
import type { SeriesGame, SeriesRoom } from './series.ts';
import { AI_SEAT, CLOSED_SEAT, memberSeats } from '@hadoku/game-server/room/record';
import type { MagicRoomGame, RoomRecord } from './lobby-codec.ts';

/** A room as a predicate here reads it: its game type and the named fields of Magic's part. */
export type MagicRoomShape<K extends keyof MagicRoomGame> = Pick<RoomRecord, 'gameType'> & { game: Pick<MagicRoomGame, K> };

type Face = string | null | undefined;

/** FNV-1a: a stable 32-bit number for a string, so a seeded pick is the same on every run. */
function seedOf(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return h >>> 0;
}

/**
 * A character drawn at random — seeded by `seed`, so the same room and seat
 * always draws the same face — from the pool's least-used ones. `tiers` are
 * compared in turn: a character that appears fewer times in the first is
 * preferred, a tie goes to the next tier, and what is still tied is drawn
 * from. So nobody shares a face while one is free, and past all 23 the pool
 * cycles rather than repeating one face (the operator, 2026-11-01).
 */
export function drawAvatar(seed: string, ...tiers: readonly (readonly Face[])[]): string {
	const counts = tiers.map((faces) => {
		const n = new Map<string, number>();
		for (const f of faces) if (f !== null && f !== undefined) n.set(f, (n.get(f) ?? 0) + 1);
		return n;
	});
	let least: string[] = [...AVATAR_POOL];
	for (const n of counts) {
		const min = Math.min(...least.map((a) => n.get(a) ?? 0));
		least = least.filter((a) => (n.get(a) ?? 0) === min);
	}
	return least[seedOf(seed) % least.length]!;
}

/** A Split & randomize (`RoomRecord.podSplit`). */
export interface PodSplit {
	seed: string;
	pods: string[][];
}

export function copySplit(split: PodSplit): PodSplit {
	return { seed: split.seed, pods: split.pods.map((p) => [...p]) };
}

/**
 * The opponent at a pod table that has one human: the one drafter of a pod of
 * bots plays Forge's AI. Stands in `PodRecord.pairings` and the results where a
 * member id would, and is never a member — but once it has played, a row of the standings.
 */
export const POD_AI = AI_SEAT;

/**
 * A tournament pod's OWN AI entrant, one per AI seat (operator, 2026-10-22:
 * *"AI can sit in the tournament, but we can also allow byes"*) — distinct
 * from `POD_AI`, a draft pod's single shared bot, because a tournament can
 * seat several AI at once and each needs its own identity to pair and stand
 * separately. `${AI_ENTRANT_PREFIX}<seat>` so two different AI seats never
 * collide and an entrant id is never mistaken for a member's (`ROOM_ID_RE`'s
 * member ids never contain `:`).
 */
const AI_ENTRANT_PREFIX = 'ai:';

/** The entrant id a tournament pod's AI seat `seat` pairs and stands under. */
export function aiEntrantId(seat: number): string {
	return `${AI_ENTRANT_PREFIX}${seat}`;
}

/** Whether `id` is a tournament pod's own AI entrant (never a member id, which never contains `:`). */
export function isAiEntrant(id: string): boolean {
	return id.startsWith(AI_ENTRANT_PREFIX);
}

/** The pod seat an AI entrant id names — the inverse of `aiEntrantId`. */
/** The pod seat an AI entrant id was minted for (`aiEntrantId`): its place at the table, closed seats not counted. */
export function aiEntrantSeat(id: string): number {
	return Number(id.slice(AI_ENTRANT_PREFIX.length));
}

/**
 * Two AI entrants' pairing with no game played: the lower pod seat wins 2-0. Deterministic, so a restart
 * and a test see the same answer. What every such pairing was until bot games (2026-11-07), and still is
 * with none wired or when one has no result (`Lobby`'s `#botGameEnded`).
 */
export function settledBotGame(round: number, a: string, b: string): MatchResult {
	const [winner, loser] = aiEntrantSeat(a) < aiEntrantSeat(b) ? [a, b] : [b, a];
	return { round, playerA: winner, playerB: loser, gamesA: 2, gamesB: 0 };
}

/** Magic's draft type: a room whose pod drafts before it plays. Every other game type answers false. */
export function isDraftType(gameType: string): boolean {
	return gameType === 'draft';
}

/** Magic's constructed type: a 1v1 table, or a Swiss pod with Tournament on. Every other game type answers false. */
export function isConstructedType(gameType: string): boolean {
	return gameType === 'constructed-1v1';
}

/** `isDraftType`, for a room in hand. */
export function isDraftRoom(room: Pick<RoomRecord, 'gameType'>): boolean {
	return isDraftType(room.gameType);
}

/** `isConstructedType`, for a room in hand. */
export function isConstructedRoom(room: Pick<RoomRecord, 'gameType'>): boolean {
	return isConstructedType(room.gameType);
}

/**
 * A Constructed room playing a Swiss pod of its own mode
 * (`docs/planning/tournament-mode-plan.md`): `settings.tournament` on. A
 * `draft` room is never this, even though it uses the same pod machinery —
 * `usesPod` is the question "does this room's lobby use its game seats (`RoomRecord.seats`) and `pod` at
 * all", which is true for both.
 */
export function isTournamentRoom(room: MagicRoomShape<'settings'>): boolean {
	return isConstructedType(room.gameType) && room.game.settings.tournament;
}

/**
 * Whether this room's lobby seats through its game seats (`RoomRecord.seats`) and plays its rounds
 * through `pod` — a `draft` room, a constructed tournament (Magic's own two
 * literal cases), or any other registered game type whose spec says it
 * plays with more than a table's two seats (`GameTypeSpec.seats.max`,
 * `@hadoku/shared`). A spec this process has never registered answers like
 * Magic's own two always have: a plain 1v1 table.
 */
export function usesPod(room: MagicRoomShape<'settings'>): boolean {
	if (isDraftRoom(room) || isTournamentRoom(room)) return true;
	const spec = gameTypeSpec(room.gameType);
	return spec !== undefined && spec.seats.max > 2;
}

/**
 * The most seats this room's pod ever grows to. Magic's own two types keep
 * their unconditional run to `POD_MAX_SEATS` (a draft's pod splits past
 * eight; a tournament's own `GameTypeSpec.seats.max` already IS
 * `POD_MAX_SEATS`, so this agrees with reading the spec too — the literal
 * check is just cheaper). Any OTHER registered pod-using type is capped at
 * its own `seats.max`, never past it.
 */
export function podSeatCeiling(room: MagicRoomShape<'settings'>): number {
	if (isDraftRoom(room) || isTournamentRoom(room)) return POD_MAX_SEATS;
	return gameTypeSpec(room.gameType)?.seats.max ?? POD_MAX_SEATS;
}

/**
 * How many seats a NEW room's pod opens with. Magic's own two types always
 * open at `POD_SEATS` (eight) regardless of their own `seats.max` — a
 * `constructed-1v1` room is not even using the pod yet at creation (it opens
 * one if Tournament is turned on later, with room for the full eight), and a
 * `draft` room's pod splits past eight rather than ever being smaller. Any
 * OTHER registered pod-using type opens at the smaller of `POD_SEATS` and
 * its own `seats.max`, so a 3-seat game never allocates five seats nobody
 * can ever reach.
 */
export function initialPodSize(gameType: string): number {
	if (isDraftType(gameType) || isConstructedType(gameType)) return POD_SEATS;
	return Math.min(POD_SEATS, gameTypeSpec(gameType)?.seats.max ?? POD_SEATS);
}

/** A pod seat a member of the room holds: not open, not the AI's, not closed, not someone gone. */
function podHuman(room: RoomRecord, s: string | null): s is string {
	return s !== null && s !== POD_AI && s !== POD_CLOSED && room.members.some((m) => m.id === s);
}

/** The members who hold a seat: the pod's humans in a pod room, else the tables'. In seat order. */
export function playersOf(room: RoomRecord): string[] {
	if (usesPod(room)) return room.seats.filter((s) => podHuman(room, s));
	return room.game.tables.flatMap((t) => t.seats.filter((s): s is string => s !== null));
}

/**
 * The room's game seats by seat number (`RoomView.seats`): the member holding each, or null for
 * a seat no member holds. The platform's game seats (`memberSeats`), or for a room that plays one
 * two-seat table, that table's.
 */
export function gameSeatsOf(room: RoomRecord): (string | null)[] {
	if (!usesPod(room)) return [...(room.game.tables[0]?.seats ?? [])];
	return memberSeats(room);
}

/**
 * `room` as `series.ts`'s `seriesFormatOf`/`newSeries` read it. `RoomRecord`
 * has no top-level `tournament` field (it rides under `settings`), so a
 * `RoomRecord` passed directly where a `SeriesRoom` is wanted reads back
 * `tournament: undefined` — never a type error (the field is optional), but
 * always the wrong answer for a tournament table. Every call that answers a
 * REAL table's format must go through this, not hand `room` straight to
 * `series.ts`.
 */
export function seriesRoomOf(room: MagicRoomShape<'mode' | 'settings'>): SeriesRoom {
	return { gameType: room.gameType, mode: room.game.mode, tournament: isTournamentRoom(room) };
}

/**
 * A pod seat its owner closed (the operator, 2026-10-19: *"closing seats changes
 * how many people are in the tournament and draft"*): no one sits there, and the
 * draft deals one seat fewer.
 */
export const POD_CLOSED = CLOSED_SEAT;

/** The fewest seats a pod is left with: one player and one more. */
export const POD_MIN_OPEN = 2;

/** What a seat refused before its event's seats open (`Lobby.seatsShutUntil`) says to whoever pressed it. */
export const SEATS_SHUT = `seats open ${String(SEATS_OPEN_BEFORE_MS / 60_000)} minutes before the event starts`;

/**
 * A pod's own draft id: the room's id for its first pod (so a room of 8 or fewer drafts exactly as it always
 * has), and `<roomId>~<k>` for each pod after it. `~` is never in a room id (`ROOM_ID_RE`), so the two can
 * never collide.
 */
const POD_DRAFT_SEPARATOR = '~';

export function podDraftId(roomId: string, pod: number): string {
	return pod === 0 ? roomId : `${roomId}${POD_DRAFT_SEPARATOR}${pod}`;
}

/** The room and pod a draft id names — the inverse of `podDraftId`. */
export function podOfDraftId(draftId: string): { roomId: string; pod: number } {
	const at = draftId.indexOf(POD_DRAFT_SEPARATOR);
	if (at === -1) return { roomId: draftId, pod: 0 };
	const pod = Number(draftId.slice(at + 1));
	return { roomId: draftId.slice(0, at), pod: Number.isInteger(pod) && pod > 0 ? pod : -1 };
}

/** The draft id `memberId` drafts in: their own pod's, or the room's for a room that drafts as one pod. */
export function memberDraftId(room: RoomRecord, memberId: string): string {
	const pod = room.game.podDrafts?.findIndex((humans) => humans.includes(memberId)) ?? -1;
	return podDraftId(room.id, Math.max(0, pod));
}

/** `seats` grown to hold `seat`, a seat at a time (one list, no pods until the split), the room's AI characters grown beside them. */
export function grownSeats(room: RoomRecord, seat: number): void {
	while (room.seats.length <= seat) {
		room.seats = [...room.seats, null];
		room.game.podAi = [...room.game.podAi, null];
	}
}

/** A historical room's field at birth (`CreateRoomInput.historicalField`): `size` seats, an AI wherever an assignment names one. */
export function seatHistoricalField(room: RoomRecord, size: number): void {
	grownSeats(room, size - 1);
	for (const entrant of Object.keys(room.game.aiDeckAssignments ?? {})) {
		const seat = isAiEntrant(entrant) ? aiEntrantSeat(entrant) : -1;
		if (seat < 0 || seat >= size) continue;
		room.seats = room.seats.map((s, i) => (i === seat ? POD_AI : s));
		room.game.podAi = room.game.podAi.map((a, i) => (i === seat ? freeAiAvatar(room, seat) : a));
	}
}

/** Open seats past one pod's 8 taken away from the end. */
export function trimmedSeats(room: RoomRecord): void {
	while (room.seats.length > POD_SEATS && room.seats.at(-1) === null) {
		room.seats = room.seats.slice(0, -1);
		room.game.podAi = room.game.podAi.slice(0, -1);
	}
}

/**
 * Split & randomize (the operator, 2026-10-31: *"the pods can be randomized and decided when the round
 * starts"*): `drafters` shuffled by `seed`, then cut into `splitPods`' sizes. The same seed and drafters give
 * the same pods, so a logged seed reproduces a split.
 */
export function splitIntoPods(drafters: readonly string[], seed: string): string[][] {
	const order = shuffle(drafters, rngFromSeed(seed));
	let next = 0;
	return splitPods(order.length).map((size) => order.slice(next, (next += size)));
}

/**
 * Why a draft room's lobby may not deal yet, or null when it may: every seat filled — a member or the AI —
 * and every seated member ready (the operator, 2026-10-19: *"drafts should not immediately start with open
 * seats"* and *"the room should not wait on spectators to be ready"*: a member who never sat is watching, and
 * is not waited on). Then the plan's verdict, last, so an unrelated refusal still reports its OWN reason:
 * the operator, on playability, "it shouldn't even get to the drafting stage" — a SERVER rule, because a UI
 * disabling Start is not this and a direct POST must refuse too. `null` (never checked, or a check still in
 * flight) and `ok: false` (refused) are the same answer here — neither may deal.
 */
export function dealGate(room: RoomRecord): 'not-ready' | 'plan-not-ready' | null {
	const seated = seatedHumans(room);
	if (seated.length === 0 || room.seats.includes(null)) return 'not-ready';
	const ready = readyParticipants(room.ledger);
	if (seated.some((id) => !ready.includes(id))) return 'not-ready';
	if (room.game.planVerdict === null || !room.game.planVerdict.ok) return 'plan-not-ready';
	return null;
}

/** The room's split while it still stands: its pods hold exactly the drafters seated now. */
export function heldSplit(room: RoomRecord): PodSplit | null {
	const split = room.game.podSplit;
	if (split === null) return null;
	const seated = new Set(seatedHumans(room));
	const split_ = split.pods.flat();
	return split_.length === seated.size && split_.every((id) => seated.has(id)) ? split : null;
}

/** Whether the lobby's seats are fixed: its draft has started, or the leader's split stands. */
export function seatsFixed(room: RoomRecord): boolean {
	return room.game.draftStartedAt !== null || heldSplit(room) !== null;
}

/** An AI seat as a player: one of the room's characters, by its own name (the operator, 2026-10-19). */
export interface AiPersona {
	name: string;
	avatarId: string;
}

/** A tournament table's two entrants, the AI's last, and — at a vs-AI table — the character this round's AI plays as, not the room's own `ai`. */
export interface TournamentPairing {
	entrants: [string, string];
	ai?: AiPersona;
}

/** `knight` → Knight. */
export function personaOf(avatarId: string): AiPersona {
	return { name: avatarId.charAt(0).toUpperCase() + avatarId.slice(1), avatarId };
}

/** The face at a pod seat: its AI's character or its member's. */
function seatFace(room: RoomRecord, seat: number): Face {
	const id = room.seats[seat];
	if (id === POD_AI) return room.game.podAi[seat];
	return room.members.find((m) => m.id === id)?.avatarId;
}

/**
 * A character for a new AI seat at `seat`, drawn for this room and seat: one
 * nobody in the room wears, else one fewest wear and neither neighbour does —
 * so up to 23 faces nobody shares one, and past that the pool cycles. Stored in
 * `podAi`, so a reload or restart keeps it.
 */
export function freeAiAvatar(room: RoomRecord, seat: number): string {
	const size = Math.max(room.seats.length, seat + 1);
	const neighbours = size < 2 ? [] : [seatFace(room, (seat + size - 1) % size), seatFace(room, (seat + 1) % size)];
	const ai = room.game.podAi.filter((_, i) => i !== seat);
	return drawAvatar(`${room.id}:${seat}`, [...ai, ...room.members.map((m) => m.avatarId)], neighbours);
}

/** The character for a stored AI seat that has none: drawn for its room and seat, as a new one would be. */
function seatAvatar(room: RoomRecord, seat: number): string {
	return drawAvatar(`${room.id}:${seat}`);
}

/** Whether a HUMAN member of the room already wears `avatarId` — never an AI seat's own. */
function wornByHuman(room: RoomRecord, avatarId: string): boolean {
	return room.members.some((m) => m.avatarId === avatarId);
}

/**
 * The AI seat's character as shown now — `room.podAi[seat]`'s stored draw, unless a human member now
 * wears that exact face, in which case a fresh one is drawn (never stored back): `freeAiAvatar`'s own
 * invariant ("nobody shares a face while one is free") is computed once, at seat time, against
 * `room.members`' avatarIds as they stood then. A member who joins and is seated before their account's
 * look comes back (`people.ts`'s `applyPerson` resolves it lazily, off the join) still reads as
 * avatar-less at that instant, so the AI's draw can land on the exact face the member is given moments
 * later. Recomputed here on every read rather than patched once, so it stays right through whichever
 * member's avatar changes after — a human's own account is always the one that is real; the AI's is the
 * one with another to draw from.
 */
function resolvedAiAvatar(room: RoomRecord, seat: number): string | null {
	const stored = room.game.podAi[seat] ?? null;
	return stored !== null && wornByHuman(room, stored) ? freeAiAvatar(room, seat) : stored;
}

/** One place at the pod's table: a member, or the AI (with no character for a seat nobody filled). */
type PodPlace = { kind: 'human'; id: string } | { kind: 'ai'; persona: AiPersona | null };

/**
 * The pod's table: every seat not closed, in seat order. Index === the seat the
 * draft deals, so this is the one order behind everything that depends on
 * where someone sits — who passes packs to whom, the AI across the table, and
 * round 1's pairings. Nothing else orders a pod.
 */
export function podTable(room: RoomRecord): PodPlace[] {
	return room.seats.flatMap((id, i): PodPlace[] => {
		if (id === POD_CLOSED) return [];
		if (id !== null && id !== POD_AI) return [{ kind: 'human', id }];
		const avatar = id === POD_AI ? resolvedAiAvatar(room, i) : null;
		return [{ kind: 'ai', persona: avatar === null ? null : personaOf(avatar) }];
	});
}

/**
 * A TOURNAMENT pod's own place at the table: a human, an EXPLICITLY AI seat
 * (the AI button), or an untouched EMPTY one. Unlike `podTable` (a draft
 * pod's own compaction, where an untouched seat IS the AI — a draft always
 * deals every seat, empty ones to bots), a tournament's lock never invents an
 * entrant nobody named: an empty seat plays no part in it at all. Closed
 * seats are dropped, same as `podTable`, and for the same reason — this is
 * the one order "across the table" pairing reads (`podTable`'s own doc).
 */
type TournamentPlace = { kind: 'human'; id: string } | { kind: 'ai' } | { kind: 'empty' };

function tournamentTable(room: RoomRecord): TournamentPlace[] {
	return room.seats.flatMap((id): TournamentPlace[] => {
		if (id === POD_CLOSED) return [];
		if (id === POD_AI) return [{ kind: 'ai' }];
		if (id === null) return [{ kind: 'empty' }];
		return [{ kind: 'human', id }];
	});
}

/**
 * These entrants as pairing players, each at their place at the pod's table.
 * A DRAFT pod's `entrants` are `draftEntrants`' own list (its humans and its
 * bots, or its humans alone for a room of several pods), read against
 * `podTable`'s compaction that minted each bot's id. A
 * TOURNAMENT pod's `entrants` are `podEntrants`'s own list, read against the
 * SAME compaction (`tournamentTable`) that produced it, so an id's `podSeat`
 * here is always the one it was minted with — an empty seat is no seat at
 * all, never a numbering gap.
 */
export function podPlayers(room: RoomRecord, entrants: readonly string[]): PodPlayer[] {
	if (isTournamentRoom(room)) {
		return tournamentTable(room).flatMap((place, podSeat) => {
			if (place.kind === 'empty') return [];
			const id = place.kind === 'human' ? place.id : aiEntrantId(podSeat);
			return entrants.includes(id) ? [{ id, podSeat }] : [];
		});
	}
	return podTable(room).flatMap((place, podSeat) => {
		const id = place.kind === 'human' ? place.id : aiEntrantId(podSeat);
		return entrants.includes(id) ? [{ id, podSeat }] : [];
	});
}

/**
 * Every pairing entrant seated in a TOURNAMENT pod, in seat order: every
 * human AND every EXPLICITLY AI seat, each AI given its own entrant id
 * (`aiEntrantId`) — the operator, 2026-10-22, reversing the plan's original
 * "no AI seats in a tournament pod". An untouched empty seat is not an
 * entrant (`tournamentTable`'s own doc). A draft pod never calls this: every
 * seat of its table drafted, so `draftEntrants` reads `podTable` instead.
 */
export function podEntrants(room: RoomRecord): string[] {
	return tournamentTable(room).flatMap((place, seat) => {
		if (place.kind === 'human') return [place.id];
		if (place.kind === 'ai') return [aiEntrantId(seat)];
		return [];
	});
}

/**
 * A draft pod's Swiss entrants once its drafters are done building: every seat that drafted, its bots
 * as AI entrants (`aiEntrantId`) beside its humans — the operator, 2026-11-07: "full swiss with bots,
 * whatever would normally happen with humans. don't 'fill extra slots' orchestrate the tournament with
 * however many bots were put into seats." So a pod of one human and N bots is an (N+1)-entrant Swiss,
 * with the rounds, pairings, byes and standings a pod of that many humans would have. Two bots paired
 * together play a bot game (`GameHooks.playBotGame`). A room that drafts as several pods (`podDrafts`) pairs its
 * humans alone: each pod's bots filled a table of their own, not a seat anyone put them in.
 */
export function draftEntrants(room: RoomRecord, humans: string[]): string[] {
	if (room.game.podDrafts !== null) return humans;
	return podTable(room).map((place, seat) => (place.kind === 'human' ? place.id : aiEntrantId(seat)));
}

/** The AI this room's games are played against: a pod's across-the-table bot, or for a 1v1 room a character nobody here wears. */
export function roomAi(room: RoomRecord): AiPersona {
	if (isDraftRoom(room)) {
		const opponent = aiOpponent(room);
		if (opponent !== null) return opponent;
	}
	return personaOf(drawAvatar(`${room.id}:ai`, room.members.map((m) => m.avatarId)));
}

/** An AI entrant's character: a tournament pod's own (its seat's, kept through the pod's life), or a draft pod's shared bot (`roomAi`). */
export function entrantPersona(room: RoomRecord, id: string, checks: Pick<GameHooks, 'pilotOf'>): AiPersona {
	if (!isAiEntrant(id)) return roomAi(room);
	return seatPersona(room, rawSeat(room, aiEntrantSeat(id)), checks);
}

/**
 * The AI at a pod seat: its character, named for the real player whose list it plays in a Challenge
 * (`RoomRecord.aiDeckAssignments`). The name is read from the library each time, never stored (R12).
 */
function seatPersona(room: RoomRecord, seat: number, checks: Pick<GameHooks, 'pilotOf'>): AiPersona {
	const persona = personaOf(resolvedAiAvatar(room, seat) ?? seatAvatar(room, seat));
	const deck = room.game.aiDeckAssignments?.[`ai:${String(seat)}`];
	const player = deck === undefined ? undefined : checks.pilotOf?.(deck);
	return player === undefined ? persona : { ...persona, name: player };
}

/**
 * The game-seat index of the table's `podSeat`-th place: an AI entrant's id counts the seats not closed
 * (`podTable`, `tournamentTable`), and its character is kept by the seat itself (`room.podAi`).
 */
function rawSeat(room: RoomRecord, podSeat: number): number {
	let place = -1;
	for (let i = 0; i < room.seats.length; i++) {
		if (room.seats[i] === POD_CLOSED) continue;
		place += 1;
		if (place === podSeat) return i;
	}
	return podSeat;
}

/** `PodView.personas`: every AI entrant the pod's players, pairings and results name. */
function podPersonas(room: RoomRecord, humans: readonly string[], checks: Pick<GameHooks, 'pilotOf'>): PodView['personas'] {
	const pod = room.game.pod;
	const ids = [...humans, ...(pod?.pairings.flatMap((p) => p.players) ?? []), ...(pod?.results.flatMap((r) => [r.playerA, r.playerB ?? r.playerA]) ?? [])];
	return Object.fromEntries([...new Set(ids)].filter((id) => id === POD_AI || isAiEntrant(id)).map((id) => [id, entrantPersona(room, id, checks)]));
}

/** The draft room's own AI character: the bot that drafted across the table from its first human (`draftRooms.ts`'s `botPoolAcross`, by the same rule). A pod round's bot wears its own (`entrantPersona`). */
function aiOpponent(room: RoomRecord): AiPersona | null {
	const table = podTable(room);
	const human = table.findIndex((place) => place.kind === 'human');
	const seat = botSeatAcross(Math.max(0, human), table.length, (s) => table[s]?.kind === 'ai');
	const place = seat === null ? undefined : table[seat];
	return place?.kind === 'ai' ? place.persona : null;
}

/**
 * A series' result, recorded once when the series ends (`#settleSeries`): a
 * Bo3 when it is decided, a Bo1 when the room moves on without a Rematch. A
 * Bo3 that ends undecided is a Bo1 of its one finished game, or the Bo3 drawn
 * (`winner: null`) once two are finished. A seat is the member who played it,
 * or `null` for Forge's AI.
 */
export interface SeriesEnd {
	roomId: string;
	tableId: string;
	mode: string;
	bestOf: 1 | 3;
	seats: [{ memberId: string; name: string } | null, { memberId: string; name: string } | null];
	wins: [number, number];
	games: SeriesGame[];
	winner: 0 | 1 | null;
}

/**
 * Where a bot game's side gets its deck: the entrant's locked snapshot (`room.lockedDecks`, opaque here
 * as everywhere in this file), a fresh deal from the room's format (a tournament's `per-round`), or the
 * pool its seat drafted (a draft pod's bot, `draftEntrants`).
 */
export type BotDeckSource = { kind: 'locked'; deck: unknown } | { kind: 'deal' } | { kind: 'drafted'; draftId: string; seat: number };

/** One bot game to play: two AI entrants of `roomId`'s pod, paired together in `round`. */
export interface BotGameAsk {
	roomId: string;
	round: number;
	players: [string, string];
	/** Each side's character's name: what Forge calls its player. */
	names: [string, string];
	decks: [BotDeckSource, BotDeckSource];
	bestOf: 1 | 3;
}

/**
 * What `RoomView.pod` needs that this file cannot answer on its own: whether
 * a pod's DRAFT is complete (`draftRooms.ts`'s `DraftState.status`), whether
 * a given drafter's deck is saved and legal (`draftRooms.ts`'s `builtDeckOf`
 * plus `gate.ts`'s own check — "the gate's draft check" the brief names),
 * the table player-state to seat a drafter with once a round pairs them
 * (same opaque shape `http/routes.ts` itself reads back through
 * `playerState`/`setPlayerState`; this file never looks inside it), and —
 * optionally — playing a bot-vs-bot pairing out instead of settling it at
 * once.
 *
 * **The per-room-instance half of a game's hooks into the lobby** (the
 * static half, true of a game type on its own with no server behind it, is
 * `@hadoku/shared`'s `GameTypeSpec`). Wired per game type (`useGameType`),
 * not baked into any one `Lobby` instance's own code and never naming a
 * particular game: `http/routes.ts`'s `attachTables` — which already holds
 * `draftRooms`, the gate's `checkSeat`, and this very `Lobby` (as
 * `TablesRooms`) — builds Magic's own implementation and registers it under
 * BOTH of Magic's own ids (`'constructed-1v1'` and `'draft'`), one object
 * serving both exactly as the single field it replaced did (`usesPod` is
 * already "does this room's lobby use its game seats and `pod` at all", true for
 * both). A game type never wired (every test that never calls
 * `useGameType` for it, and the instant between `openLobby` returning and
 * `attachTables` running at boot) answers as if nothing has ever been
 * built — a room can only wait longer in `drafting`/`building`, never see a
 * wrong answer the other way.
 *
 * `holdsSeriesDeck` is the one question about a Constructed table: whether a
 * member's table state still holds the deck it played the current series
 * with — what keeps a finished Bo1 open to a Rematch (`#rematchable`).
 * Unwired, every seat does, so only the seats and members decide.
 *
 * `playBotGame`, absent (the default): two AI entrants paired together
 * settle at once (`#pairRound`). Wired: it plays their match out in Forge,
 * headless (`play/botgames.ts`; the operator, 2026-11-07: "can we have the
 * bots play real games against each other?" — "real games, headless"),
 * answering each side's games won, or `null` when there is no result
 * (Forge failed, the server was full past the wait, or the game ran past
 * its clock) — the room settles that pairing the old way then.
 */
export interface GameHooks {
	draftComplete(podId: string): boolean;
	built(podId: string, memberId: string): boolean;
	seatState(podId: string, memberId: string): unknown;
	holdsSeriesDeck(state: unknown): boolean;
	/**
	 * Each round's bare name (`PodView.roundNames`) — `room/plan.ts`'s
	 * `roundNamesOf`, bound to `draftRooms.ts`'s resolver for a single
	 * source's own name (the same rule `cubeMetaOf` labels it from).
	 */
	roundNamesOf(plan: DraftPlan): [string, string, string];
	/**
	 * Tournament, Classic only: whether `memberId`'s own per-room state
	 * (`member.state`, the same blob `PUT …/deck` writes) already holds a
	 * deck legal for the room's pool — the lock's own "ready" check for
	 * Classic (`docs/planning/tournament-mode-plan.md`'s Design: *"Classic: a
	 * legal deck chosen"*). An AI entrant is always ready and never reaches
	 * here (`#lockTournament`'s own gate).
	 */
	hasLegalSeatDeck(roomId: string, memberId: string): boolean;
	/**
	 * Tournament, Classic/All Random, `tournamentDecks === 'locked'`: this
	 * entrant's deck right now, to snapshot as its locked choice at the lock
	 * — a human's own CURRENT `PUT …/deck` state, read back verbatim, or a
	 * freshly dealt one for an AI entrant (the room's format/library, the
	 * same way a vs-bot table deals the AI one). Opaque to `room/lobby.ts`,
	 * which only stores and replays whatever this returns.
	 */
	currentTournamentDeck(roomId: string, entrant: string): unknown;
	/**
	 * Tournament, Classic/All Random, every round's `#newPodTable`: seat
	 * `entrant` (a member id, or a tournament AI entrant id — `isAiEntrant`)
	 * at `tableId` with `deck` — a `locked` snapshot (`currentTournamentDeck`'s
	 * own shape) replayed as-is, or `null` for `per-round` (a human's own
	 * deck is cleared so `PUT …/deck` is required again for Classic, or left
	 * for the table's own ready-time deal for All Random; an AI entrant is
	 * dealt fresh here instead). The table's OTHER seat, when it is an AI
	 * entrant (`null` in `TableRecord.seats`), holds nothing of its own: its
	 * deck rides the human partner's `state.aiDeck`, exactly as a vs-bot
	 * table already works.
	 */
	seatTournamentDeck(roomId: string, tableId: string, entrant: string, deck: unknown | null): void;
	/** The real player who played a library deck (its `pilot`): a Challenge AI's name. Absent, or `undefined`, keeps the seat's own character name. */
	pilotOf?(deckId: string): string | undefined;
	/** See this interface's own doc, last paragraph. Optional: absent plays no bot game. */
	playBotGame?(ask: BotGameAsk): Promise<{ wins: [number, number]; gameMs: number[] } | null>;
}

/** The bare name a single source gets with no `DraftRooms` wired (no jar/no cube store): its id or code, which is also what the real resolver falls back to. */
function fallbackSourceName(source: PoolSource): string {
	return source.kind === 'cube' ? source.cubeId : source.code;
}

export const NO_GAME_HOOKS: GameHooks = {
	draftComplete: () => false,
	built: () => false,
	seatState: () => null,
	holdsSeriesDeck: () => true,
	roundNamesOf: (plan) => roundNamesOf(plan, fallbackSourceName),
	hasLegalSeatDeck: () => false,
	currentTournamentDeck: () => null,
	seatTournamentDeck: () => {},
};

/**
 * A draft room's rounds, once `playPod` has dealt round 1. Null before
 * that (still `lobby`, `drafting` or `building` — see `podPhaseOf`).
 */
export interface PodRecord {
	/** The humans seated for the draft, in POD SEAT order — `pairing.ts`'s own player list. Fixed for the pod's life. */
	humans: string[];
	/** 1-based once round 1 has started; never 0 once `pod` exists. One past `rounds` once the pod is done. */
	round: number;
	/** `roundsFor(humans.length)`, fixed once `pod` exists. */
	rounds: number;
	/** Every finished round's results so far, byes included. */
	results: MatchResult[];
	/** The CURRENT round's pairings. Empty once the pod is done. */
	pairings: { tableId: string; players: [string, string] }[];
	/** The CURRENT round's bye, or null. Cleared once the pod is done. */
	bye: string | null;
	/** Entrants the leader disqualified (`dqPlayer`), in order. Absent on a record written before it. */
	dropped?: string[];
	/**
	 * The CURRENT round's bot games not yet ended (`GameHooks.playBotGame`): two AI entrants paired together, with no
	 * table. Each leaves for `results` when it ends. Absent on a record written before it.
	 */
	botGames?: { players: [string, string] }[];
}

function isStoredMatchResult(v: unknown): v is MatchResult {
	if (typeof v !== 'object' || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		typeof r.round === 'number' &&
		typeof r.playerA === 'string' &&
		(r.playerB === null || typeof r.playerB === 'string') &&
		typeof r.gamesA === 'number' &&
		typeof r.gamesB === 'number' &&
		(r.gameMs === undefined || (Array.isArray(r.gameMs) && r.gameMs.every((ms) => typeof ms === 'number')))
	);
}

function isStoredPodPairing(v: unknown): v is { tableId: string; players: [string, string] } {
	if (typeof v !== 'object' || v === null) return false;
	const p = v as Record<string, unknown>;
	return (
		typeof p.tableId === 'string' &&
		Array.isArray(p.players) &&
		p.players.length === 2 &&
		p.players.every((x) => typeof x === 'string')
	);
}

export function isStoredPodRecord(v: unknown): v is PodRecord {
	if (typeof v !== 'object' || v === null) return false;
	const p = v as Record<string, unknown>;
	if (!Array.isArray(p.humans) || !p.humans.every((h) => typeof h === 'string')) return false;
	if (typeof p.round !== 'number' || typeof p.rounds !== 'number') return false;
	if (!Array.isArray(p.results) || !p.results.every(isStoredMatchResult)) return false;
	if (!Array.isArray(p.pairings) || !p.pairings.every(isStoredPodPairing)) return false;
	if (p.dropped !== undefined && !(Array.isArray(p.dropped) && p.dropped.every((d) => typeof d === 'string'))) return false;
	if (p.botGames !== undefined && !(Array.isArray(p.botGames) && p.botGames.every((g) => isStoredPodPairing({ tableId: '', ...(g as object) })))) return false;
	return p.bye === null || typeof p.bye === 'string';
}

/** A stored pod's seats for a room of `gameType`: never fewer than that type's pod opens with (`initialPodSize`). */
export function isStoredPodSeats(v: unknown, gameType: string): v is (string | null)[] {
	return Array.isArray(v) && v.length >= initialPodSize(gameType) && v.length <= POD_MAX_SEATS && v.every((s) => s === null || typeof s === 'string');
}

export function isStoredPodSplit(v: unknown): v is PodSplit {
	if (typeof v !== 'object' || v === null) return false;
	const p = v as { seed?: unknown; pods?: unknown };
	return typeof p.seed === 'string' && Array.isArray(p.pods) && p.pods.every((pod) => Array.isArray(pod) && pod.every((m) => typeof m === 'string'));
}

/** Each entrant's locked deck is an object (Classic/Random's opaque deck choice; an older record's Gauntlet deck-id array) — never a bare primitive. */
export function isStoredLockedDecks(v: unknown): v is Record<string, unknown> {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	return Object.values(v).every((x) => typeof x === 'object' && x !== null);
}

/** A room's Gauntlets by table id (`RoomRecord.gauntlets`'s own doc): a plain object, every value a Gauntlet this build understands. */
export function isStoredGauntlets(v: unknown): v is Record<string, GauntletState> {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	return Object.values(v).every(isGauntletState);
}

/**
 * The room's own gate-free phase: `lobby`/`drafting`/`building`/`rounds`/`done`
 * — see `GameHooks`. Only called for a room `usesPod`.
 *
 * A TOURNAMENT pod never sees `drafting`/`building`: `#lockTournament` sets
 * `draftStartedAt` and a (possibly still-empty) `pod` as ONE atomic
 * mutation, specifically so that nothing — not even a RE-ENTRANT read
 * through `GameHooks` mid-lock (`#newPodTable`'s `seatTournamentDeck` calls
 * back into `rooms.get()` before pairing is finished) — can ever observe
 * `draftStartedAt !== null` with `pod === null`. If it ever does, that is a
 * real bug upstream, not a case this function silently answers a phase for:
 * `rounds`/`done` with no pod is impossible, so this throws rather than
 * lying about which phase it is (a real run of exactly that lie is what
 * crashed `podViewOf`'s blind cast below, 2026-10-22).
 */
export function podPhaseOf(room: RoomRecord, checks: GameHooks): PodPhase {
	if (room.game.draftStartedAt === null) return 'lobby';
	if (isDraftRoom(room)) {
		const pods = room.game.podDrafts?.length ?? 1;
		for (let pod = 0; pod < pods; pod++) if (!checks.draftComplete(podDraftId(room.id, pod))) return 'drafting';
		if (room.game.pod === null) return 'building';
	}
	if (room.game.pod === null) throw new Error(`podPhaseOf: room ${room.id} has draftStartedAt set and no pod`);
	return room.game.pod.round > room.game.pod.rounds ? 'done' : 'rounds';
}

/** `PodView.seats` once the pod has left the `lobby` phase — see `podViewOf`. */
const EMPTY_POD_SEATS: PodView['seats'] = new Array(POD_SEATS).fill(null) as PodView['seats'];

/**
 * The members seated in the pod, in seat order — not the open seats, and not
 * the seats the AI holds (`POD_AI`, the AI button: the operator, 2026-10-19,
 * *"i need an AI button same as how it's used in the constructed 1v1 lobby"*).
 */
export function seatedHumans(room: RoomRecord): string[] {
	return podTable(room).flatMap((place) => (place.kind === 'human' ? [place.id] : []));
}

function podSeatsView(room: RoomRecord, checks: Pick<GameHooks, 'pilotOf'>): PodView['seats'] {
	return room.seats.map((id, i) => {
		if (id === null) return null;
		if (id === POD_AI) {
			const persona = seatPersona(room, i, checks);
			return { memberId: POD_AI, name: persona.name, avatarId: persona.avatarId } as PodMember;
		}
		if (id === POD_CLOSED) return { memberId: POD_CLOSED, name: '' } as PodMember;
		const member = room.members.find((m) => m.id === id);
		return member === undefined ? null : ({ memberId: id, name: member.name } as PodMember);
	}) as PodView['seats'];
}

/**
 * The standings' players: the pod's humans, and the draft pod's single
 * shared bot once a result names it. A literal `=== POD_AI`, deliberately —
 * a TOURNAMENT pod's own AI entrant (`isAiEntrant`) is always already in
 * `humans` (`podEntrants`'s own doc), so adding it again here on a looser
 * `isPodAi` match would double it in the standings.
 */
function players(humans: string[], results: MatchResult[]): { id: string }[] {
	const ai = results.some((r) => r.playerA === POD_AI || r.playerB === POD_AI);
	return [...humans, ...(ai ? [POD_AI] : [])].map((id) => ({ id }));
}

/** A pod's tournament id (`Tournament.id`), one per draft: the seed its standings' last tiebreak draws from. */
export function tournamentId(room: RoomRecord): string {
	return `${room.id}-${room.game.draftStartedAt}`;
}

/** The whole field's one standings, every row its own rank and naming the tiebreak that put it below the one above. */
export function podStandings(room: RoomRecord, humans: string[], results: MatchResult[]): RankedStandingsRow[] {
	return rankedStandings(players(humans, results), results, tournamentId(room));
}

/**
 * `RoomView.pod`, for a room `usesPod` — `viewOf` answers `null` for every
 * other room. A DRAFT room's `planFields` are `room.plan`'s, frozen the
 * instant `draftStartedAt` is set (`PUT …/pod/plan` refuses from there — see
 * `RoomRecord.plan`'s own doc), so reading it here is right in every phase,
 * not just `lobby`. A constructed TOURNAMENT pod drafts no pool at all:
 * `plan`/`roundNames`/`verdict` are `null` (`PodView.plan`'s own doc).
 */
export function podViewOf(room: RoomRecord, checks: GameHooks): PodView {
	const phase = podPhaseOf(room, checks);
	const tournament = isTournamentRoom(room);
	const planFields = tournament ? { plan: null, roundNames: null, verdict: null } : { plan: room.game.plan, roundNames: checks.roundNamesOf(room.game.plan), verdict: room.game.planVerdict };
	// Filled only in `lobby` — the wire contract's own words ("lobby phase: the
	// 8 pod seats"). Once drafting starts, who is at what SEAT is the draft
	// engine's own business (`room/draftRooms.ts`'s `viewForParticipant`), and
	// `startPodRounds`'s `PodRecord.humans`/`pairings` are what `rounds`/`done`
	// answer from — this field is not a second source for either.
	const seats = phase === 'lobby' ? podSeatsView(room, checks) : EMPTY_POD_SEATS;
	if (phase === 'lobby') {
		const split = heldSplit(room);
		return { phase, seats, round: 0, rounds: 0, results: [], standings: [], pairings: [], bye: null, dropped: [], drafters: [], ...(split === null ? {} : { pods: split.pods }), built: [], personas: {}, ...planFields };
	}
	// Seated at `draftStartedAt` and fixed from there (`#dealPodRounds`'s own
	// `humans`), falling back to the CURRENT seats for a pod whose rounds have
	// not started yet (`drafting`/`building`) — there is no fixed list to fall
	// back to before `#dealPodRounds` has run.
	const humans = room.game.pod?.humans ?? seatedHumans(room);
	if (phase === 'drafting') {
		return { phase, seats, round: 0, rounds: 0, results: [], standings: [], pairings: [], bye: null, dropped: [], drafters: humans, pods: room.game.podDrafts ?? [humans], built: [], personas: podPersonas(room, humans, checks), ...planFields };
	}
	// Done building: pressed Play (`playPod`) with a deck that is still legal.
	// A bot built its deck as it drafted (`botDeck.ts`).
	const built = humans.filter((id) => isAiEntrant(id) || (room.game.podPlaying.includes(id) && checks.built(memberDraftId(room, id), id)));
	const pods = tournament ? [] : (room.game.podDrafts ?? [humans]);
	if (phase === 'building') {
		return { phase, seats, round: 0, rounds: roundsFor(tournament ? humans.length : draftEntrants(room, humans).length), results: [], standings: [], pairings: [], bye: null, dropped: [], drafters: humans, pods, built, personas: podPersonas(room, humans, checks), ...planFields };
	}
	// `podPhaseOf` already answers `rounds`/`done` only when `room.pod !== null`
	// (it throws otherwise, above) — but this cast is the one place that
	// invariant actually gets relied on, so it checks again rather than
	// trusting a call several lines back never to drift out of sync with it.
	if (room.game.pod === null) throw new Error(`podViewOf: room ${room.id} is ${phase} with no pod`);
	const pod = room.game.pod;
	// The AI you played is ranked beside you (the operator, 2026-10-19: "why am i the only one in that room").
	const ranked = podStandings(room, humans, pod.results);
	return {
		phase,
		seats,
		round: Math.min(pod.round, pod.rounds),
		rounds: pod.rounds,
		results: pod.results,
		standings: ranked,
		pairings: pod.pairings,
		botGames: pod.botGames ?? [],
		bye: pod.bye,
		dropped: pod.dropped ?? [],
		drafters: humans,
		pods,
		// A tournament pod never builds a deck: every entrant who locked in
		// counts as "built" at once, rather than reading as permanently empty.
		built: tournament ? humans : built,
		personas: podPersonas(room, humans, checks),
		...planFields,
	};
}
