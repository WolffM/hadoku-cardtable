/**
 * Rooms holding a draft. Socket-free on purpose.
 *
 * `@wolffm/rooms-server` is a box of primitives, not a framework — there is no
 * `createRoomServer` and no `authenticate` hook, so the wiring is ours. This
 * file is the half of that wiring that has no transport in it: the registry,
 * the seat transitions, and the guard and grace that make a dropped socket
 * survivable. `emit.ts` and `socket.ts` are the half that needs `io`, and
 * keeping them apart is what lets the refresh hazard below be tested by calling
 * functions rather than by racing two sockets.
 *
 * ## One seat table, not two
 *
 * `CoreRoomState` arrives with its own `createSeatTable(null)` and the draft
 * engine arrives with `state.table`. Two tables would be two answers to "which
 * seat is Alice in", and every consumer would have to pick one: `leaveRoom`
 * writes to the room's, `viewFor` reads the engine's. So `openDraftRoom`
 * ALIASES them — `room.seats` IS `state.table`, same object — and there is one
 * source of truth for seating, exactly as `seats.ts`'s "roles are derived,
 * never stored" intends. It also means the hazard below lands where it can be
 * seen, rather than silently desynchronising two tables.
 *
 * ## `leaveRoom` unseats a participant who is still here
 *
 * `leaveRoom` (rooms-server 0.38.111, `state.js`) calls `unseatParticipant` on
 * EVERY disconnect, including one the room layer cannot tell apart from a
 * departure: a stale socket whose close lands AFTER its replacement has joined
 * and re-seated the participant. That close unseats a drafter who is sitting
 * right there with a live connection. (This was written as the refresh case;
 * a refresh turned out to arrive in the other order — next section.) Replayed
 * against the real package the result is a `spectator` with an empty seat and a
 * reservation held for themselves — for an eight-person pod forty-five minutes
 * in, that is the pod.
 *
 * Upstream has not fixed it, so the hosting app guards the call:
 * `leaveDraftRoom` re-seats the participant when another live client still
 * carries their id. `seatParticipant` prefers the remembered seat and a
 * participant is never blocked by their own reservation, so they land back in
 * the seat they were in rather than appended after everyone who stayed.
 *
 * ## …but that is not the order a refresh actually arrives in
 *
 * Wave 10 measured a real browser refresh on loopback: the old socket's close
 * lands ~36 ms BEFORE the new socket joins. By the time the stale close is
 * processed there is no other live client, so the guard above has nothing to
 * guard — the seat is vacated with a hold, and the RESERVATION is what brings
 * the drafter back to it. The guard still earns its place, for the ordering
 * that does put a live socket beside a dying one: a second tab, or an old
 * connection the server only notices is dead at socket.io's ping timeout, long
 * after its replacement joined. It is just not the refresh mechanism.
 *
 * What the reservation alone costs is visible: vacate, broadcast, re-seat,
 * broadcast — the rest of the pod watched the seat go `held` and come back
 * inside ~80 ms. So a disconnect with nobody else carrying the id gets the
 * same treatment the guard gives a live duplicate, for a short grace
 * (`disconnectGraceMs`): the participant is put straight back, nothing is
 * broadcast, and the vacate-with-hold is DEFERRED. A rejoin inside the grace
 * cancels it and is a no-op to everyone else (`joinDraftRoom` reports
 * `changed: false`, so only the joiner is answered). A drafter who does not
 * come back is vacated when the grace runs out, exactly as before, and the
 * room's `onDeferredChange` hook broadcasts it — the reservation TTL starts
 * then. One rule now covers both orderings: a seat is not given up while its
 * participant is plausibly still here.
 *
 * `disconnectGraceMs` defaults to 0, which is the old behaviour to the letter
 * (vacate on the close, hook never called); production sets it in `index.ts`.
 *
 * ## Why a seat change bumps `seq`
 *
 * The engine bumps `seq` on every pick. It does not bump it when somebody sits
 * down, because seating is not the engine's business — but `DraftView` carries
 * the seat rows, so a join that did not advance the cursor would reach every
 * other client as a `duplicate` and be dropped, and the pod would never see the
 * new player arrive. Every transition here that changes the table advances the
 * cursor, and only when it actually changed something.
 *
 * ## Two things this deliberately does NOT do
 *
 * **No GC.** `collectGC` reaps a room whose `clients.size` is 0, and for a
 * forty-five-minute draft that is every room the instant a network blip lands
 * on the last connected player — the reservation exists precisely because an
 * empty client map is not an empty pod. So rooms live for the life of the
 * process, which is a slow leak and a much smaller one than destroying a game
 * in progress. Persistence (P6, `packages/room-store`) is where this gets a
 * real answer.
 *
 * **No bot backfill on a drop.** `unseatParticipant` empties the seat rather
 * than handing it to a bot, so `waitingOn` keeps naming it and the round waits
 * for the drafter to come back. That is what a held seat MEANS; padding it with
 * a bot would pick their cards for them while they reconnect. The cost is that
 * one dropped player stalls the pod until they return or the hold expires, and
 * that is a product decision to revisit with a real pod, not a bug to paper
 * over here.
 */

import {
	clientByParticipant,
	joinRoom,
	leaveRoom,
	RoomRegistry,
	type ClientMeta,
	type CoreRoomState,
} from '@wolffm/rooms-server';
import {
	roleOf,
	seatOf,
	seatParticipant,
	unseatParticipant,
	type ParticipantId,
	type SeatId,
} from '@wolffm/rooms-protocol';
import { createDraft, spectatorView, viewFor, type DraftState } from '@hadoku/draft';
import { cursorOf, type CubeMeta, type DraftCard, type DraftView, type WireCursor } from '@hadoku/shared';

import { participantHandle } from './identity.js';

/** The hosting app's room state: one draft. */
export interface DraftApp {
	/**
	 * Null only between `RoomRegistry.seed` and `openDraftRoom` filling it in.
	 * The registry's `createApp` callback is handed a timestamp and nothing
	 * else — not the room id — so the draft cannot be built there.
	 */
	state: DraftState | null;
	/** How long a disconnected participant keeps their seat before it is vacated. */
	disconnectGraceMs: number;
	/** Called after a deferred vacate changed the table, so it can be broadcast. */
	onDeferredChange: (room: DraftRoom) => void;
	/** Pending deferred vacates, by participant. */
	vacating: Map<ParticipantId, ReturnType<typeof setTimeout>>;
}

/** The hosting app's per-connection state. */
export interface DraftClient {
	/** The edge tier this connection was admitted at. Diagnostic; never emitted. */
	tier: string;
}

export type DraftRoom = CoreRoomState<DraftApp, DraftClient>;

export interface DraftParams {
	seatCount: number;
	packCount: number;
	packSize: number;
	/** How long a dropped drafter's seat is held against other people. */
	reservationTtlMs: number;
	/**
	 * How long a disconnected drafter stays SEATED before the seat is vacated
	 * and the hold starts. 0 vacates on the close. See the module header.
	 */
	disconnectGraceMs: number;
}

/** A standard pod: eight seats, three fifteen-card packs, a two-minute hold. */
export const DEFAULT_PARAMS: DraftParams = {
	seatCount: 8,
	packCount: 3,
	packSize: 15,
	reservationTtlMs: 120_000,
	disconnectGraceMs: 0,
};

export interface DraftRoomsOptions {
	pool: readonly DraftCard[];
	cube: CubeMeta;
	params?: Partial<DraftParams>;
	/** Injectable so a test can pin the epoch. */
	now?: () => number;
	/**
	 * Told when a deferred vacate (see `disconnectGraceMs`) changed a room's
	 * table, which happens on a timer with no socket event to answer. Without
	 * it the change still advances `seq` and rides the room's next broadcast.
	 */
	onDeferredChange?: (room: DraftRoom) => void;
}

export interface DraftRooms {
	readonly cube: CubeMeta;
	readonly params: DraftParams;
	/** Get or create the room for a draft. Creating one deals the whole draft. */
	open(draftId: string): DraftRoom;
	/** The room for a draft that already exists, or undefined. */
	find(draftId: string): DraftRoom | undefined;
	all(): DraftRoom[];
}

export function createDraftRooms(options: DraftRoomsOptions): DraftRooms {
	const params: DraftParams = { ...DEFAULT_PARAMS, ...options.params };
	const now = options.now ?? Date.now;
	const onDeferredChange = options.onDeferredChange ?? (() => undefined);
	const registry = new RoomRegistry<DraftApp, DraftClient>(() => ({
		state: null,
		disconnectGraceMs: params.disconnectGraceMs,
		onDeferredChange,
		vacating: new Map(),
	}));

	const build = (draftId: string): DraftState =>
		createDraft({
			draftId,
			// A new INCARNATION every time a draft is built, so a client holding
			// state from the process that died before this one is told the draft
			// it knows no longer exists rather than being left to compare
			// sequence numbers across two different shuffles.
			epoch: `${draftId}:${now()}`,
			// The id IS the seed: the same pod id deals the same draft, which is
			// what makes a bug report reproducible and a restore possible.
			seed: draftId,
			pool: options.pool,
			seatCount: params.seatCount,
			packCount: params.packCount,
			packSize: params.packSize,
			// Nobody is seated at creation. Humans arrive over the socket and
			// evict a bot, which `seatParticipant` does for them.
			humans: [],
			reservationTtlMs: params.reservationTtlMs,
		});

	return {
		cube: options.cube,
		params,
		open(draftId) {
			// `seed` returns the existing room when there is one, so this is
			// idempotent; `??=` is what makes the draft built exactly once.
			const room = registry.seed(draftId, draftId);
			if (room.app.state === null) {
				const state = build(draftId);
				room.app.state = state;
				// The alias. See this module's header.
				room.seats = state.table;
			}
			return room;
		},
		find: (draftId) => {
			const room = registry.get(draftId);
			return room?.app.state === null ? undefined : room;
		},
		all: () => registry.all().filter((r) => r.app.state !== null),
	};
}

/** The draft in a room. Absent is an invariant violation, not a case. */
export function stateOf(room: DraftRoom): DraftState {
	const state = room.app.state;
	if (state === null) {
		throw new Error(`room ${room.roomId} was seeded without a draft — openDraftRoom was skipped`);
	}
	return state;
}

/** The cursor everything in this room is stamped with right now. */
export function cursorFor(room: DraftRoom): WireCursor {
	return cursorOf(spectatorView(stateOf(room)));
}

/**
 * The payload for one participant, and nothing else.
 *
 * Seated → their own pack and pool. Unseated → the spectator arm, which has no
 * card fields at all. This is the function `emitPerRecipient` is handed; there
 * is deliberately no variant that returns "the view" without a recipient.
 */
export function viewForParticipant(room: DraftRoom, participantId: ParticipantId): DraftView {
	const state = stateOf(room);
	const seat = seatOf(room.seats, participantId);
	return seat === null ? spectatorView(state) : viewFor(state, seat);
}

/** Advance the stream. Called when something changed that a payload shows. */
function bumpSeq(state: DraftState): void {
	state.seq += 1;
}

function nameSeat(state: DraftState, seat: SeatId, participantId: ParticipantId): void {
	// The digest handle, never the friend key and never the edge's `X-User-Id`.
	// This string goes to every other seat in the pod.
	state.displayNames[seat] = participantHandle(participantId);
}

export interface JoinOutcome {
	client: ClientMeta<DraftClient>;
	/** Where they ended up, or null when the pod is full of people. */
	seat: SeatId | null;
	/** Whether the seat table changed — i.e. whether the cursor advanced. */
	changed: boolean;
}

/**
 * Seat a connection.
 *
 * `joinRoom` registers the client AND calls `seatParticipant` itself, so this
 * adds what the package cannot know: the display name, and whether anything
 * moved. A re-join from a participant who is already seated is idempotent all
 * the way down — `seatParticipant` returns the seat they are in — so a
 * reconnect does not renumber the table.
 */
export function joinDraftRoom(
	room: DraftRoom,
	clientId: string,
	participantId: ParticipantId,
	tier: string,
): JoinOutcome {
	const state = stateOf(room);
	// Back inside the grace: they never left the seat, so there is nothing to
	// vacate and — because the seat is still theirs — nothing changes below.
	cancelVacate(room, participantId);
	const before = seatOf(room.seats, participantId);
	const client = joinRoom<DraftApp, DraftClient>(room, clientId, clientId, participantId, () => ({
		tier,
	}));
	const seat = seatOf(room.seats, participantId);
	const changed = seat !== before;
	if (seat !== null && changed) {
		nameSeat(state, seat, participantId);
		bumpSeq(state);
	}
	return { client, seat, changed };
}

/**
 * Release a seat on an explicit "I'm leaving", holding it for the TTL.
 *
 * `hold: true` is the table's default, spelled out because the choice matters
 * and is invisible otherwise: a viewer leaving a watch party should free their
 * slot at once, and a drafter should not cost the other seven their pod.
 */
export function releaseSeat(room: DraftRoom, participantId: ParticipantId): boolean {
	const state = stateOf(room);
	cancelVacate(room, participantId);
	const vacated = unseatParticipant(room.seats, participantId, { hold: true });
	if (vacated === null) return false;
	bumpSeq(state);
	return true;
}

export interface LeaveOutcome {
	/** Who the departing socket belonged to, or null if it was not a member. */
	participantId: ParticipantId | null;
	/** True when the guard had to put a still-connected participant back. */
	guarded: boolean;
	/** True when nobody else carried the id and the vacate was deferred by the grace. */
	held: boolean;
	/** Whether the seat table changed. */
	changed: boolean;
}

/**
 * Drop a connection, and undo the unseat while the participant is plausibly
 * still here.
 *
 * `leaveRoom` unseats on every close. Two cases put them straight back into
 * the REMEMBERED seat — which `unseatParticipant` recorded on the way out and
 * which is reserved for them, so they return to the seat they were in rather
 * than being appended:
 *
 * - **guarded**: another live client still carries this participant id (a
 *   second tab, or a stale socket reaped after its replacement joined). They
 *   are here; nothing is deferred.
 * - **held**: nobody else carries it, and the room has a disconnect grace. The
 *   vacate is deferred to `vacateAfterGrace`; a rejoin inside the grace cancels
 *   it. This is the real order of a browser refresh — close first, join second.
 *
 * Only someone who was seated is put back: a spectator closing one of two tabs
 * must not be seated by the other one's existence.
 */
export function leaveDraftRoom(room: DraftRoom, clientId: string): LeaveOutcome {
	const state = stateOf(room);
	const meta = room.clients.get(clientId);
	const participantId = meta?.participantId ?? null;
	const before = participantId === null ? null : seatOf(room.seats, participantId);

	leaveRoom<DraftApp, DraftClient>(room, clientId);

	let guarded = false;
	let held = false;
	if (participantId !== null && before !== null) {
		if (clientByParticipant(room, participantId) !== undefined) {
			seatParticipant(room.seats, participantId);
			guarded = true;
		} else if (room.app.disconnectGraceMs > 0) {
			seatParticipant(room.seats, participantId);
			vacateAfterGrace(room, participantId);
			held = true;
		}
	}

	const after = participantId === null ? null : seatOf(room.seats, participantId);
	const changed = before !== after;
	if (changed) bumpSeq(state);
	return { participantId, guarded, held, changed };
}

/** Schedule the vacate a disconnect deferred. At most one per participant. */
function vacateAfterGrace(room: DraftRoom, participantId: ParticipantId): void {
	cancelVacate(room, participantId);
	const timer = setTimeout(() => {
		room.app.vacating.delete(participantId);
		// No "are they back?" check: a rejoin cancels this timer synchronously
		// (`joinDraftRoom`), so reaching here means they did not come back.
		// Exactly what `leaveRoom` would have done on the close, only later.
		if (unseatParticipant(room.seats, participantId, { hold: true }) === null) return;
		bumpSeq(stateOf(room));
		room.app.onDeferredChange(room);
	}, room.app.disconnectGraceMs);
	// A pending vacate is not a reason for the process to stay alive.
	timer.unref();
	room.app.vacating.set(participantId, timer);
}

function cancelVacate(room: DraftRoom, participantId: ParticipantId): void {
	const timer = room.app.vacating.get(participantId);
	if (timer === undefined) return;
	clearTimeout(timer);
	room.app.vacating.delete(participantId);
}

/** Whether this participant currently holds a seat. Derived, never stored. */
export function isSeated(room: DraftRoom, participantId: ParticipantId): boolean {
	return roleOf(room.seats, participantId) === 'player';
}
