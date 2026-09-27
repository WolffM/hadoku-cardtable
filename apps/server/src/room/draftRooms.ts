/**
 * Rooms holding a draft. Socket-free on purpose.
 *
 * `@wolffm/rooms-server` is a box of primitives, not a framework — there is no
 * `createRoomServer` and no `authenticate` hook, so the wiring is ours. This
 * file is the half of that wiring that has no transport in it: the registry,
 * the seat transitions, and the disconnect grace that makes a dropped socket
 * survivable. `emit.ts` and `socket.ts` are the half that needs `io`, and
 * keeping them apart is what lets the refresh hazard below be tested by calling
 * functions rather than by racing two sockets.
 *
 * ## One seat table, not two
 *
 * `CoreRoomState` arrives with a seat table and the draft engine arrives with
 * `state.table`. Two tables would be two answers to "which seat is Alice in",
 * and every consumer would have to pick one: `leaveRoom` writes to the room's,
 * `viewFor` reads the engine's. So the engine's table IS the room's —
 * `RoomRegistry.seed` takes a seat-table FACTORY and `open` hands it one that
 * returns `state.table`, so the room is BORN holding it.
 *
 * That is the whole of the difference from the aliasing this used to do
 * (`room.seats = state.table`, immediately after `seed`). Same end state, but
 * one owner of the field instead of two and no window in which something could
 * read `room.seats` and get the other table — which is exactly the shape
 * `seatRows` exists to keep unreachable: the engine's table is bounded at
 * `seatCount`, the registry's default is unbounded, and a renderer that caught
 * the default would draw a pod with however many players had arrived.
 *
 * ## `leaveRoom` used to unseat a participant who was still here
 *
 * Through 0.38.x, `leaveRoom` called `unseatParticipant` on EVERY disconnect,
 * including one the room layer cannot tell apart from a departure: a stale
 * socket whose close lands AFTER its replacement has joined and re-seated the
 * participant. That close unseated a drafter sitting right there on a live
 * connection — a `spectator` with an empty seat and a reservation held for
 * themselves, which for an eight-person pod forty-five minutes in is the pod.
 * This file carried the repair: re-seat the participant after `leaveRoom` when
 * another live client still carried their id.
 *
 * **`@wolffm/rooms-server@0.39.4` deletes the connection FIRST and gives up the
 * seat only when `clientByParticipant` finds nothing else carrying the
 * identity** — our bug report, fixed once in the package rather than in each
 * consumer. So the re-seat is gone from here; what remains is the `guarded`
 * flag, which now REPORTS that a live duplicate kept the seat rather than
 * repairing it. `socket.ts` logs it and `e2e/draft.spec.ts` reads that log, so
 * it is still the observable that says the ordering happened at all.
 *
 * ## …but that is not the order a refresh actually arrives in
 *
 * Wave 10 measured a real browser refresh on loopback: the old socket's close
 * lands ~36 ms BEFORE the new socket joins. By the time the stale close is
 * processed there is no other live client, so the package's own check has
 * nothing to find — the seat is vacated with a hold, and the RESERVATION is
 * what brings the drafter back to it. **Watchparty deliberately did not take
 * the grace below, and they were right to leave it here**: it covers this
 * ordering, which nothing upstream does, and moving it up would put a timer
 * and a broadcast callback inside the package.
 *
 * What the reservation alone costs is visible: vacate, broadcast, re-seat,
 * broadcast — the rest of the pod watched the seat go `held` and come back
 * inside ~80 ms. So a disconnect with nobody else carrying the id gets the
 * same treatment the package gives a live duplicate, for a short grace
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
 * real answer. Turning it on is the operator's decision, not this file's.
 *
 * `RoomRegistry.onRoomDelete` IS wired, though, and deliberately before there
 * is anything to delete: a room owns pending `vacating` timers, and the only
 * reason draining them at a GC sweep would have been correct is that GC was
 * the one delete path. Registering the drain on the registry means a future
 * admin close, a game-over reap or GC being switched on is covered by
 * construction rather than by somebody remembering. Callbacks run BEFORE the
 * room leaves the map, so the room is still resolvable inside one.
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
	 * Null only for the one statement between `RoomRegistry.seed` returning and
	 * `open` filling it in. The registry's `createApp` callback is handed a
	 * timestamp and nothing else — not the room id — so the draft cannot be
	 * built there, even though the seat table now can be.
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

/**
 * A standard pod: eight seats, three fifteen-card packs, a two-minute hold.
 *
 * **Eight seats, always.** A draft room does not choose its seat count and
 * nothing in the UI offers one (wave 23): the room has however many humans
 * readied, the pod has eight seats, and the seats nobody claimed are bots. That
 * reconciliation is `createDraft(… humans: [])` plus eviction on connect — see
 * `build` below — so a room of one and a room of eight are the same code path.
 */
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
	/**
	 * Get or create the room for a draft. Creating one deals the whole draft.
	 *
	 * So the CALLER decides when a draft begins, and there is exactly one: the
	 * socket's `join`, which refuses unless the lobby says that room's draft has
	 * been started (`room/socket.ts`'s readiness gate). Calling this for an
	 * arbitrary id is what the deleted "Start a pod" button did.
	 */
	open(draftId: string): DraftRoom;
	/** The room for a draft that already exists, or undefined. */
	find(draftId: string): DraftRoom | undefined;
	all(): DraftRoom[];
	/**
	 * Forget a room and everything it owns.
	 *
	 * The ONE delete path, and deliberately not reached by a sweep: GC is off
	 * (see the header), so nothing in the running server calls this. It exists
	 * because the registry's `onRoomDelete` drain has to be reachable to be
	 * believable — a cleanup hook that no path can invoke is a hook nobody
	 * knows is broken — and because when GC or an admin close does arrive, it
	 * arrives as a caller rather than as a second cleanup.
	 */
	delete(draftId: string): void;
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

	// Anything a room owns that outlives the map entry. Today that is the
	// deferred vacates; GC is OFF (see the header), so nothing calls this yet
	// — which is the point of registering it here rather than at the one
	// delete path that happens to exist.
	registry.onRoomDelete((roomId) => {
		const room = registry.get(roomId);
		if (room === undefined) return;
		for (const timer of room.app.vacating.values()) clearTimeout(timer);
		room.app.vacating.clear();
	});

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
			// Nobody is seated at creation: all eight seats are bots, and every
			// human who connects evicts one. That is how "bots fill the seats
			// nobody took, at the instant the draft starts" is implemented —
			// nothing counts humans, because the draft is not built until the
			// room starts it and a seat is taken by arriving.
			humans: [],
			reservationTtlMs: params.reservationTtlMs,
		});

	return {
		cube: options.cube,
		params,
		open(draftId) {
			// Idempotent: an existing room is returned untouched, and in
			// particular its draft is NOT re-dealt. `seed` would do the same,
			// but asking first is what lets the draft be built BEFORE the room
			// exists — which is what makes the seat table single-sourced.
			const existing = registry.get(draftId);
			if (existing !== undefined) return existing;

			const state = build(draftId);
			// The seat-table FACTORY. `room.seats` IS `state.table` from the
			// moment the room exists; nothing ever assigns to the field. See
			// this module's header.
			const room = registry.seed(draftId, draftId, () => state.table);
			room.app.state = state;
			return room;
		},
		find: (draftId) => {
			const room = registry.get(draftId);
			return room?.app.state === null ? undefined : room;
		},
		all: () => registry.all().filter((r) => r.app.state !== null),
		delete: (draftId) => registry.delete(draftId),
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
 * Two outcomes, and only one of them is still ours:
 *
 * - **guarded**: another live client carries this participant id (a second
 *   tab, or a stale socket reaped after its replacement joined). The PACKAGE
 *   keeps the seat — `leaveRoom` only unseats a participant's last connection
 *   — so this flag reports the ordering rather than repairing it.
 * - **held**: nobody else carries it, and the room has a disconnect grace, so
 *   they are put straight back into the REMEMBERED seat (reserved for them, so
 *   they land where they were rather than appended after everyone who stayed)
 *   and the vacate is deferred to `vacateAfterGrace`. A rejoin inside the
 *   grace cancels it. This is the real order of a browser refresh — close
 *   first, join second — and nothing upstream covers it.
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
			// rooms-server >=0.39.0 kept the seat itself: it deletes the client
			// first, then unseats only when nothing else carries the identity.
			// Nothing to repair — this branch exists to REPORT that the
			// ordering happened, which is what `socket.ts` logs and what the
			// e2e reads back.
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
