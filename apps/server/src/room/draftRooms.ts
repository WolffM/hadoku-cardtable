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
 * than handing it to a bot, so its packs keep queueing in front of it and the
 * pod waits on that pile for the drafter to come back. That is what a held seat MEANS; padding it with
 * a bot would pick their cards for them while they reconnect. The cost is that
 * one dropped player stalls the pod until they return or the hold expires, and
 * that is a product decision to revisit with a real pod, not a bug to paper
 * over here.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	clientByParticipant,
	joinRoom,
	leaveRoom,
	RoomRegistry,
	type ClientMeta,
	type CoreRoomState,
} from '@wolffm/rooms-server';
import {
	occupantOf,
	seatOf,
	seatParticipant,
	unseatParticipant,
	type ParticipantId,
	type SeatId,
	type SeatTable,
} from '@wolffm/rooms-protocol';
import {
	botSeatAcross,
	createDraft,
	deal,
	fromLockstep,
	isBotSeat,
	spectatorView,
	viewFor,
	watcherView,
	type BotSeat,
	type DraftState,
	type HumanSeat,
	type LockstepState,
	planPool,
	type RealisticPacks,
} from '@hadoku/draft';
import { cursorOf, sourceLabel, type CubeMeta, type DraftCard, type DraftPlan, type DraftView, type PoolSource, type WireCursor } from '@hadoku/shared';
import {
	applySnapshot,
	decodeSnapshot,
	snapshotRoom,
	SnapshotUnreadableError,
	type RestoreContext,
	type RoomCodec,
	type RoomSnapshot,
} from '@hadoku/room-store';

import { participantHandle } from './identity.js';
import { jsonLogger } from '../log.js';

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
	/**
	 * Each drafter's last saved build, `.dck` text. A participant absent from
	 * this map has never saved one — `GET …/mine` then answers `deck: null` and
	 * the deck editor falls back to the drafted pool as-is. Keyed by
	 * `ParticipantId`, same as `builtDecks`'s only reader, `drafts.ts`.
	 */
	builtDecks: Record<ParticipantId, string>;
	/**
	 * What each drafter has done to the deck this pod made them on the Decks
	 * page (`http/decks.ts`): a name of their own, or deleted. Absent is the
	 * default — named after the cube, listed. The deck itself is
	 * `builtDecks` and the pool above; this is only how it is shown.
	 */
	deckMeta: Record<ParticipantId, DeckMeta>;
	/**
	 * Write this pod to disk now. A no-op when persistence is off (`storeDir:
	 * null`) or before `open()` has filled in `state`. Stashed on the app
	 * rather than threaded as a parameter because every mutator that needs it
	 * — `joinDraftRoom`, `releaseSeat`, `leaveDraftRoom`, `saveBuiltDeck` — is a
	 * bare function taking a `DraftRoom`, the same shape `onDeferredChange`
	 * already uses for the same reason.
	 */
	persist: (room: DraftRoom) => void;
	/**
	 * The draft rope: each seat's deadline on the pick in front of it, set by
	 * `room/socket.ts` when the room has a pick timer and read here into that
	 * seat's view. In memory only — a restored pod starts every pick's time
	 * afresh rather than timing a seat out for the minutes the server was down.
	 */
	rope: Map<SeatId, PickDeadline>;
}

/** One seat's deadline: on which pick (`key`), when it runs out, and how long it was given. */
export interface PickDeadline {
	key: string;
	endsAt: number;
	totalMs: number;
}

interface DeckMeta {
	name?: string;
	deleted?: true;
}

/** The hosting app's per-connection state. */
export interface DraftClient {
	/** The edge tier this connection was admitted at. Diagnostic; never emitted. */
	tier: string;
	/**
	 * The seat this connection asked to watch (`watch`), or null for the
	 * default. Read only while the person holds no seat (`viewForClient`).
	 */
	watching: SeatId | null;
}

export type DraftRoom = CoreRoomState<DraftApp, DraftClient>;

interface DraftParams {
	seatCount: number;
	/** `packSize`, not `packCount`: a plan's own `rounds.length` decides how many packs — always 3 (Settled), `DraftPlanSchema`'s own tuple. */
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
	packSize: 15,
	reservationTtlMs: 120_000,
	disconnectGraceMs: 0,
};

/**
 * The shortlist file stem `build-pool --out-dir=` gave MTGO Vintage Cube
 * 2025-12 (`packages/carddata/src/cli/build-pool.ts`'s `slug()`) — the
 * `CubeSummary.id`/`PoolSource.cubeId` this server knows it by.
 */
export const DEFAULT_CUBE_ID = 'mtgo-vintage-cube-2025-04';

/**
 * Settled, 2026-10-21: a new draft room's plan before its leader ever picks one — "the Vintage Cube 2025-12
 * three times". Amended 2026-10-22 by the operator to 2025-04, the newest Vintage Cube whose 540 cards all
 * resolve: 2025-12 dealt 534, its six Through the Omenpaths cards having no text (ledger, "Six MTGO Vintage
 * Cube 2025-12 cards never reach a pool").
 */
export const DEFAULT_PLAN: DraftPlan = {
	rounds: [
		{ kind: 'cube', cubeId: DEFAULT_CUBE_ID },
		{ kind: 'cube', cubeId: DEFAULT_CUBE_ID },
		{ kind: 'cube', cubeId: DEFAULT_CUBE_ID },
	],
};

/**
 * What a room needs to turn a `PoolSource` into cards and a name — the
 * server's one answer to "where do a pod's packs come from", now that it is
 * per room rather than the single file `index.ts` used to load at boot.
 *
 * `index.ts` wires this: today (steps 1-5, before C's `CubeStore` lands) from
 * the shortlist files directly; `createCubeStore`'s `cards`/`list` answer the
 * same two questions once step 6 swaps it in.
 */
export interface PoolSourceResolver {
	/** Every card a source holds — handed straight to `@hadoku/draft`'s `deal()`. */
	cards(src: PoolSource): readonly DraftCard[];
	/** Its bare name — a cube's or a set's own, without a set's style: `PodView.roundNames`, and `CubeMeta.name` once labelled (`sourceLabel`). */
	name(src: PoolSource): string;
}

/**
 * A resolver (and the matching default plan) for a server with exactly one
 * cube, under one id — the shape every draft room used before per-room plans
 * existed. For tests, and for `apps/ui/src/draft/live.ts`'s bundled pool,
 * which never grows a second source.
 */
export function singlePoolResolver(cube: { meta: { name: string }; cards: readonly DraftCard[] }): {
	resolver: PoolSourceResolver;
	defaultPlan: DraftPlan;
} {
	const source: PoolSource = { kind: 'cube', cubeId: 'default' };
	return {
		resolver: { cards: () => cube.cards, name: () => cube.meta.name },
		defaultPlan: { rounds: [source, source, source] },
	};
}

interface DraftRoomsOptions {
	resolver: PoolSourceResolver;
	/** A new room's plan before its leader ever picks one — Settled: Vintage Cube 2025-04 × 3 (2025-12 until 2026-10-22: six of its cards had no text). */
	defaultPlan: DraftPlan;
	params?: Partial<DraftParams>;
	/** Injectable so a test can pin the epoch. */
	now?: () => number;
	/**
	 * Told when a deferred vacate (see `disconnectGraceMs`) changed a room's
	 * table, which happens on a timer with no socket event to answer. Without
	 * it the change still advances `seq` and rides the room's next broadcast.
	 */
	onDeferredChange?: (room: DraftRoom) => void;
	/**
	 * Where pods are persisted (P6, `@hadoku/room-store`'s snapshot format).
	 * `undefined` or `null` — the default — disables persistence outright: pure
	 * in-memory, today's behaviour. `index.ts` opts in explicitly with
	 * `CONFIG.draftsDir`, as it does with `CONFIG.roomsDir`. Defaulting to a real directory instead would make
	 * every OTHER test that builds a `DraftRooms` and does not know this option
	 * exists — `http/tables.test.ts`, `room/socket.test.ts` — start touching
	 * real disk, and possibly colliding on the same `draftId`s this file's own
	 * tests use.
	 */
	storeDir?: string | null;
}

export interface DraftRooms {
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
	/**
	 * The members a pod was dealt to, with their names — `joinDraftRoom`'s say in
	 * who sits and what their seat is called. Empty for a draft nobody sat in,
	 * where a `join` from someone holding no seat takes one, evicting a bot. A
	 * pod dealt to the members who sat takes nobody else: the rest of the room
	 * watches (the operator, 2026-10-19: *"a member who never sat is watching"*;
	 * and 2026-10-20, on watching a draft).
	 */
	drafters(draftId: string): readonly HumanSeat[];
	/**
	 * How a new draft is dealt (`room/lobby.ts`'s `podDraft`, wired once by
	 * `http/routes.ts`'s `attachTables`). Unwired, or `null` for a room nobody
	 * sat in: the params' seats, all of them bots named `Bot <seat>`, and the
	 * first humans to connect evict one each.
	 */
	setPodLookup(lookup: (draftId: string) => PodDeal | null): void;
	/** The cube this room's pod is (or will be) dealt from — round 1's source, by name and declared size. `DraftStateMessage.cube`, `MyDeck.cube`'s source. */
	cubeMetaOf(room: DraftRoom): CubeMeta;
	/** A source's bare name — `PodView.roundNames` for a room still in its lobby, no `DraftRoom` built yet. */
	nameOf(src: PoolSource): string;
	/**
	 * A realistic round's pre-fetched, catalog-mapped packs — `[seat][card]`
	 * — stashed here BEFORE this draft is ever `open()`ed (wave 74 §E step 2:
	 * "realistic boosters are fetched before `deal` and passed in, so `deal`
	 * stays synchronous and seeded"). `http/rooms.ts`'s `POST …/start` is the
	 * only caller: it awaits `ForgePools.boosters` for every realistic round
	 * in the plan, maps each card through the catalog, and calls this once
	 * per such round — all BEFORE `lobby.startDraft` ever runs — so that
	 * `open()`, called later and SYNCHRONOUSLY from the first socket `join`
	 * (`room/socket.ts`), never itself awaits Forge.
	 *
	 * Consumed once, by the next `open()` for this draft id, and dropped
	 * immediately after — a restore reads the dealt packs back from the
	 * pod's own snapshot (this module's header, "Persistence"), never from
	 * here, so nothing is retained past the one deal it was fetched for.
	 */
	cacheRealisticRound(draftId: string, round: number, packs: readonly (readonly DraftCard[])[]): void;
}

/**
 * A pod's say in its draft, read off its seats: how many there are, which
 * player drafts from which (their pod seat is their place at the draft table,
 * so it decides who they pass to and receive from), and what the bots in the
 * rest are called, in seat order.
 */
export interface PodDeal {
	seats: number;
	humans: readonly HumanSeat[];
	/** The AI seats as players, in seat order: each persona's name and character. */
	bots: readonly BotSeat[];
	/**
	 * This pod's plan — the room's own `plan` (`room/lobby.ts`'s `podDraft`),
	 * at whatever it was set to when the draft was built. The lobby refuses to
	 * change it once `draftStartedAt` is set, which is before `build()` ever
	 * runs for a brand-new room, so what is read here is frozen by construction
	 * rather than by a second lock.
	 */
	plan: DraftPlan;
}

/*
 * ## Persistence, hand-rolled rather than `@hadoku/room-store`'s own classes
 *
 * `FileRoomStore`/`RoomPersistence` are both ASYNC (`fs/promises`), because
 * they are built for a host whose room creation can afford to await a load.
 * This one cannot: `open`/`find` are called synchronously from `room/socket.ts`
 * on every `join`, and making them `async` would ripple into a file this
 * module does not own. So the snapshot FORMAT and the pure codec functions
 * (`snapshotRoom`/`decodeSnapshot`/`applySnapshot`) come from
 * `@hadoku/room-store`, but the bytes move over `node:fs`'s synchronous calls,
 * mirroring `FileRoomStore`'s own safety properties (base64url filenames so a
 * `draftId` cannot escape the directory; a temp-file-and-rename write so a
 * reader never sees a half-written snapshot) without being able to reuse that
 * class, which has no synchronous `load`.
 *
 * Restoring is therefore EAGER, at the end of this function, not lazy on first
 * `open`/`find`: a pod nobody has touched since the restart still has to answer
 * `GET …/mine` and show up in `draftedPoolsFor`'s `all()` sweep, and both are
 * synchronous reads with nothing to trigger a load on. Picking up every
 * snapshot in `storeDir` before this function returns is what makes that true
 * without an `await` anywhere in this file.
 *
 * Write-through happens on every mutation this file can see: the end of every
 * mutator it owns (`open`'s initial deal, `joinDraftRoom`, `releaseSeat`,
 * `leaveDraftRoom`, the deferred vacate, `saveBuiltDeck`, via `room.app.persist`),
 * PLUS every assignment to `room.app.state` — including the one this file does
 * not make itself: `room/socket.ts` advances a pick with `room.app.state =
 * advanced.state` directly (its own header explains why — one envelope per
 * pick, bots included). `makeDraftApp` makes `state` an accessor rather than a
 * plain field so that assignment persists too, without `socket.ts` having to
 * know persistence exists. Without it, the pick that COMPLETES a pod — often
 * the last state change before nothing else ever touches the room again — was
 * exactly the one mutation never written to disk.
 */

/** Resolve a safe, reversible filename for a draft id. Same approach `FileRoomStore` uses, and for the same reason: a `draftId` is a join payload, not a trusted path segment. */
function snapshotKey(draftId: string): string {
	return Buffer.from(draftId, 'utf8').toString('base64url');
}

const SNAPSHOT_SUFFIX = '.json';

function snapshotPath(dir: string, draftId: string): string {
	return join(dir, `${snapshotKey(draftId)}${SNAPSHOT_SUFFIX}`);
}

/** Atomic: temp file, then rename over the target. See `fileStore.ts`'s header for why. */
function writeSnapshotSync(dir: string, snapshot: RoomSnapshot): void {
	mkdirSync(dir, { recursive: true });
	const target = snapshotPath(dir, snapshot.roomId);
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(snapshot));
	renameSync(tmp, target);
}

function readSnapshotSync(dir: string, draftId: string): RoomSnapshot | null {
	const path = snapshotPath(dir, draftId);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as RoomSnapshot;
}

/** Every draft id this directory holds a snapshot for, for the eager restore. */
function listSnapshotIdsSync(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(SNAPSHOT_SUFFIX) && !name.includes('.tmp'))
		.map((name) => Buffer.from(name.slice(0, -SNAPSHOT_SUFFIX.length), 'base64url').toString('utf8'));
}

function rmSnapshotSync(dir: string, draftId: string): void {
	rmSync(snapshotPath(dir, draftId), { force: true });
}

/** Set a record this build could not decode aside, intact — §4.5, by hand. */
function quarantineSnapshotSync(dir: string, draftId: string, reason: string): void {
	const source = snapshotPath(dir, draftId);
	if (!existsSync(source)) return;
	const quarantineDir = join(dir, 'quarantine');
	mkdirSync(quarantineDir, { recursive: true });
	const name = `${snapshotKey(draftId)}.${Date.now()}${SNAPSHOT_SUFFIX}`;
	renameSync(source, join(quarantineDir, name));
	writeFileSync(join(quarantineDir, `${name}.reason.txt`), `${reason}\n`, 'utf8');
}

const logDraft = jsonLogger('cardtable-draft');

/** What persists for one pod. Everything else on `DraftApp` is config echoed back in (`disconnectGraceMs`) or reconstructed fresh (`onDeferredChange`, `vacating`, `persist`) — never read off disk. */
interface PersistedDraftApp {
	state: DraftState | null;
	builtDecks: Record<ParticipantId, string>;
	deckMeta?: Record<ParticipantId, DeckMeta>;
}

type PersistedFields = Required<Pick<PersistedDraftApp, 'state' | 'builtDecks' | 'deckMeta'>>;

export function createDraftRooms(options: DraftRoomsOptions): DraftRooms {
	const params: DraftParams = { ...DEFAULT_PARAMS, ...options.params };
	const now = options.now ?? Date.now;
	const onDeferredChange = options.onDeferredChange ?? (() => undefined);
	const storeDir = options.storeDir ?? null;
	let podLookup: (draftId: string) => PodDeal | null = () => null;
	/** `cacheRealisticRound`'s own stash — see `DraftRooms.cacheRealisticRound`'s doc. */
	const realisticByDraft = new Map<string, Map<number, readonly (readonly DraftCard[])[]>>();

	/** Write-through. A no-op while persistence is off or before `open()` has dealt the draft. */
	function persistRoom(room: DraftRoom): void {
		if (storeDir === null || room.app.state === null) return;
		writeSnapshotSync(storeDir, snapshotRoom(room, codec));
	}

	/**
	 * Which room a `DraftApp` belongs to — needed only by `state`'s SETTER
	 * below, which `room/socket.ts` reaches through an assignment
	 * (`room.app.state = advanced.state`), not through any function this file
	 * owns. Bound once, right after the app is attached to its room (`open`,
	 * and the restore loop after `applySnapshot` replaces `room.app`
	 * entirely) — never read before then, since nothing assigns `state`
	 * before that point either.
	 */
	const roomOf = new WeakMap<DraftApp, DraftRoom>();

	/**
	 * Build a `DraftApp`. `state` is an ACCESSOR, not a plain field: picking a
	 * card is `room.app.state = advanced.state` in `room/socket.ts` (that
	 * file's own header explains why — one envelope per pick, bots included),
	 * a file this module does not edit. A plain field would make that
	 * assignment invisible to persistence, and a pick that completes the pod
	 * — the LAST state change before nothing else may ever touch this room
	 * again — would be the one mutation never written to disk. Routing the
	 * assignment itself through `persistRoom` fixes that without `socket.ts`
	 * having to know persistence exists.
	 */
	function makeDraftApp(initial: PersistedFields): DraftApp {
		let current = initial.state;
		const app: DraftApp = {
			disconnectGraceMs: params.disconnectGraceMs,
			onDeferredChange,
			vacating: new Map(),
			builtDecks: initial.builtDecks,
			deckMeta: initial.deckMeta,
			persist: persistRoom,
			rope: new Map(),
			get state() {
				return current;
			},
			set state(next) {
				current = next;
				const room = roomOf.get(app);
				if (room !== undefined) persistRoom(room);
			},
		};
		return app;
	}

	const codec: RoomCodec<DraftApp, DraftClient> = {
		app: {
			version: 1,
			serialize: (app): PersistedDraftApp => ({ state: app.state, builtDecks: app.builtDecks, deckMeta: app.deckMeta }),
			deserialize: (raw, _version, ctx): DraftApp => {
				const persisted = raw as PersistedDraftApp;
				return makeDraftApp({
					// A restore is a rebuild: the epoch is stamped fresh so a client
					// holding a pre-restart cursor gets `epoch-change` rather than
					// reading the restored seq as a flood of duplicates. See this
					// module's header and `draftRestore.test.ts`.
					// A snapshot from before seats carried characters has no `avatarIds`;
					// one from before packs queued has a pack per seat (`fromLockstep`).
					state:
						persisted.state === null
							? null
							: {
									...fromLockstep(persisted.state as DraftState | LockstepState),
									avatarIds: (persisted.state as Partial<DraftState>).avatarIds ?? {},
									epoch: ctx.restoreId,
								},
					builtDecks: persisted.builtDecks ?? {},
					deckMeta: persisted.deckMeta ?? {},
				});
			},
		},
	};

	const registry = new RoomRegistry<DraftApp, DraftClient>(() => makeDraftApp({ state: null, builtDecks: {}, deckMeta: {} }));

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

	// The eager restore. Synchronous and run to completion before this function
	// returns, so a pod nobody has `open`ed or `find`-ed since the restart is
	// already live in the registry — see this section's header.
	if (storeDir !== null) {
		for (const draftId of listSnapshotIdsSync(storeDir)) {
			if (registry.get(draftId) !== undefined) continue;
			const snapshot = readSnapshotSync(storeDir, draftId);
			if (snapshot === null) continue;
			const restoredAt = now();
			const ctx: RestoreContext = { roomId: draftId, restoreId: `restore:${draftId}:${restoredAt}`, restoredAt };
			try {
				const decoded = decodeSnapshot(snapshot, codec, ctx);
				const room = registry.seed(draftId, draftId);
				applySnapshot(room, decoded, restoredAt);
				// AFTER `applySnapshot`, which just replaced `room.app` with the
				// object `codec.app.deserialize` built — binding the room BEFORE
				// that swap would point `state`'s setter at the stub `createApp`
				// built and discarded.
				roomOf.set(room.app, room);
				// `applySnapshot` wrote `room.seats` from its OWN decode of the
				// snapshot's `seats` field — a different object than the seat table
				// inside the `DraftState` the same decode just put in `room.app`.
				// `open()` keeps the two aliased from birth (this module's header,
				// "One seat table, not two"); a restore has to restore THAT
				// invariant, not just the data it carries.
				if (room.app.state !== null) room.seats = room.app.state.table;
				logDraft({ evt: 'draft-restored', draftId, seq: room.app.state?.seq ?? 0 });
			} catch (err) {
				const reason = err instanceof SnapshotUnreadableError ? `${err.reason}: ${err.message}` : String(err);
				quarantineSnapshotSync(storeDir, draftId, reason);
				logDraft({ evt: 'draft-snapshot-quarantined', draftId, reason });
			}
		}
	}

	/** The plan a draft id's pod is set to right now — its own, or the server's default for a room nobody has planned yet. */
	const planFor = (draftId: string): DraftPlan => podLookup(draftId)?.plan ?? options.defaultPlan;

	const build = (draftId: string): DraftState => {
		const pod = podLookup(draftId);
		const plan = pod?.plan ?? options.defaultPlan;
		// A pod with seats closed deals that many fewer (`room/lobby.ts`'s `podDraft`).
		const seatCount = pod?.seats ?? params.seatCount;
		// Consumed once: whatever `cacheRealisticRound` stashed for this draft id
		// (the `/start` route's pre-fetch) is read here and dropped, so a second
		// `build()` for the same id (there is none — `open()` is idempotent, see
		// below) could never replay a stale round against a different deal.
		const realistic = realisticByDraft.get(draftId);
		realisticByDraft.delete(draftId);
		const realisticPacks: RealisticPacks | undefined = realistic === undefined ? undefined : (round) => realistic.get(round);
		return createDraft({
			draftId,
			// A new INCARNATION every time a draft is built, so a client holding
			// state from the process that died before this one is told the draft
			// it knows no longer exists rather than being left to compare
			// sequence numbers across two different shuffles.
			epoch: `${draftId}:${now()}`,
			// The id IS the seed: the same pod id deals the same draft, which is
			// what makes a bug report reproducible and a restore possible — for
			// BOTH `deal()` and `createDraft` itself, which is what keeps the two
			// in step without threading a second seed through.
			seed: draftId,
			packs: deal(plan, options.resolver.cards, draftId, seatCount, params.packSize, realisticPacks),
			seatCount,
			packCount: plan.rounds.length,
			packSize: params.packSize,
			humans: pod?.humans ?? [],
			bots: pod?.bots ?? [],
			reservationTtlMs: params.reservationTtlMs,
		});
	};

	return {
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
			roomOf.set(room.app, room);
			// Triggers `state`'s setter, which persists — so a pod that is dealt
			// and then crashes before anyone picks still comes back with the
			// right seats and the right packs, not a re-deal.
			room.app.state = state;
			return room;
		},
		find: (draftId) => {
			const room = registry.get(draftId);
			return room?.app.state === null ? undefined : room;
		},
		all: () => registry.all().filter((r) => r.app.state !== null),
		delete: (draftId) => {
			registry.delete(draftId);
			// `delete` is unreachable in production today (this module's header,
			// "No GC") — this exists so the on-disk half is not left behind the
			// one time something does call it. §4.6: both halves, always together.
			if (storeDir !== null) rmSnapshotSync(storeDir, draftId);
		},
		drafters(draftId) {
			return podLookup(draftId)?.humans ?? [];
		},
		setPodLookup(lookup) {
			podLookup = lookup;
		},
		cubeMetaOf(room) {
			const src = planFor(room.roomId).rounds[0] as PoolSource;
			const size = planPool(planFor(room.roomId), options.resolver.cards, src).length;
			// `CubeMeta.size` (`@hadoku/shared`'s `CubeMetaSchema`) is
			// `z.number().int().positive()` — a 0 here fails the WHOLE
			// `state` message's schema parse on the browser, which never
			// recovers (the production incident this guards: a realistic
			// round's resolver answered `[]`, since its packs come from
			// `cacheRealisticRound`, never a shared pool). Whatever the
			// resolver answers, the wire never sees a non-positive size: a
			// pod's seats × pack size is still an honest, always-positive
			// stand-in for "how big is this source" when the resolver has
			// nothing better.
			return { name: sourceLabel(src, options.resolver.name(src)), size: size > 0 ? size : params.seatCount * params.packSize };
		},
		nameOf(src) {
			return options.resolver.name(src);
		},
		cacheRealisticRound(draftId, round, packs) {
			let byRound = realisticByDraft.get(draftId);
			if (byRound === undefined) {
				byRound = new Map();
				realisticByDraft.set(draftId, byRound);
			}
			byRound.set(round, packs);
		},
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
 * Seated → their own pack and pool. Unseated but a finished pod's drafter →
 * the seat they drafted, still (see `completedSeatOf`). Neither → the
 * spectator arm, which has no card fields at all. This is the function
 * `emitPerRecipient` is handed; there is deliberately no variant that returns
 * "the view" without a recipient.
 */
export function viewForParticipant(room: DraftRoom, participantId: ParticipantId): DraftView {
	const state = stateOf(room);
	const seat = seatOf(room.seats, participantId) ?? finishedSeatOf(state, room.seats, participantId);
	return seat === null ? spectatorView(state) : viewFor(state, seat);
}

/**
 * The payload for one CONNECTION — `viewForParticipant`, except that a person
 * holding no seat watches one: the seat they asked for, or else the table's
 * first human drafter, or its first seat (the operator, 2026-10-20, on draft
 * spectating: one drafter's pack and picks, read-only). A drafter is never
 * sent anything but their own seat. The socket's emits use this; the HTTP
 * routes keep `viewForParticipant`, which is seat or nothing.
 */
export function viewForClient(room: DraftRoom, client: ClientMeta<DraftClient>, now: number = Date.now()): DraftView {
	const view = viewForParticipant(room, client.participantId);
	if (view.viewer.kind === 'seat') return withRope(room, view, now);
	const state = stateOf(room);
	const watched = watchedSeat(state, client.app.watching);
	return watched === null ? view : withRope(room, watcherView(state, watched), now);
}

/** The viewed seat's rope, as a duration from `now` (`PickTimerViewSchema`): the seat and whoever watches it see the same one. */
function withRope(room: DraftRoom, view: DraftView, now: number): DraftView {
	if (view.viewer.kind === 'spectator') return view;
	const deadline = room.app.rope.get(view.viewer.seatId);
	if (deadline === undefined) return view;
	return { ...view, viewer: { ...view.viewer, timer: { totalMs: deadline.totalMs, msLeft: Math.max(0, deadline.endsAt - now) } } };
}

function watchedSeat(state: DraftState, wanted: SeatId | null): SeatId | null {
	if (wanted !== null && wanted < state.seatCount) return wanted;
	if (state.seatCount === 0) return null;
	const human = state.table.seats.findIndex((s, i) => i < state.seatCount && s.occupant?.kind === 'human');
	return human === -1 ? 0 : human;
}

/**
 * The pool of the bot that drafted across the table from this participant (or,
 * with no bot there, the first bot seat) — what the AI plays at a pod table
 * (`botDeck.ts`). Null when the participant drafted no seat here, or no seat
 * was a bot.
 */
export function botPoolAcross(room: DraftRoom, participantId: ParticipantId): DraftCard[] | null {
	const state = stateOf(room);
	const seat = seatOf(room.seats, participantId) ?? finishedSeatOf(state, room.seats, participantId);
	if (seat === null) return null;
	const chosen = botSeatAcross(seat, state.seatCount, (s) => isBotSeat(state, s));
	return chosen === null ? null : [...state.pools[chosen]!];
}

/**
 * The seat this participant drafted, once its picks are all made — even though
 * they may no longer hold it: left, the 120 s hold ran out, or the process
 * restarted since. A finished seat's pool cannot change, so its drafter owns
 * it for good.
 *
 * That holds before the whole pod is done, too: a finished draft goes straight
 * to the deck builder, which leaves the pod while the other humans may still
 * be making their last pick. Mid-draft it yields to anyone who now sits in
 * that seat, and an unseated participant whose seat is NOT finished is still a
 * spectator.
 *
 * `table.remembered` is `@wolffm/rooms-protocol`'s own durable record of "the
 * seat this participant last held" (`seats.ts`'s header: "Outlives their
 * departure so a returning participant reclaims their old place"). Nothing in
 * this file ever clears it, so it already survives a leave, the hold expiring,
 * AND a restart (it travels inside `room.seats`, which `@hadoku/room-store`'s
 * generic snapshot already carries verbatim) — this function is the one place
 * that reads it for a participant who is NOT currently seated. A seat nobody
 * ever sat in — a bot's — has no participant pointing at it here, so it stays
 * unowned by construction rather than by a check.
 */
function finishedSeatOf(state: DraftState, table: SeatTable, participantId: ParticipantId): SeatId | null {
	const seat = table.remembered[participantId];
	if (seat === undefined) return null;
	if (state.status === 'complete') return seat;
	const finished = (state.pools[seat]?.length ?? 0) >= state.packCount * state.packSize;
	return finished && occupantOf(table, seat) === null ? seat : null;
}

/** Advance the stream. Called when something changed that a payload shows. */
function bumpSeq(state: DraftState): void {
	state.seq += 1;
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
 *
 * A pod's drafter is called by their name in the pod, whenever they sit: a
 * seat reclaimed after a restart was renamed to the participant handle, and
 * the pod lost every name (the operator, 2026-10-20: *"our names died?"*). A
 * seat already wearing the handle takes the name on the next join.
 */
export function joinDraftRoom(
	room: DraftRoom,
	clientId: string,
	participantId: ParticipantId,
	tier: string,
	drafters: readonly HumanSeat[] = [],
): JoinOutcome {
	const state = stateOf(room);
	// Back inside the grace: they never left the seat, so there is nothing to
	// vacate and — because the seat is still theirs — nothing changes below.
	cancelVacate(room, participantId);
	const before = seatOf(room.seats, participantId);
	const drafted = before !== null || room.seats.remembered[participantId] !== undefined;
	if (drafters.length > 0 && !drafted) return { client: watchRoom(room, clientId, participantId, tier), seat: null, changed: false };
	const client = joinRoom<DraftApp, DraftClient>(room, clientId, clientId, participantId, () => ({
		tier,
		watching: null,
	}));
	const seat = seatOf(room.seats, participantId);
	const drafter = drafters.find((h) => h.participantId === participantId);
	const name = drafter?.displayName ?? null;
	const renamed = seat !== null && name !== null && state.displayNames[seat] !== name;
	// A character changed in the room since the deal is drawn at the seat from the next join.
	const recharactered = seat !== null && drafter?.avatarId !== undefined && state.avatarIds[seat] !== drafter.avatarId;
	const changed = seat !== before || renamed || recharactered;
	if (seat !== null && changed) {
		// Without a name in the pod, the digest handle — never the friend key and
		// never the edge's `X-User-Id`. This string goes to every other seat.
		state.displayNames[seat] = name ?? participantHandle(participantId);
		if (drafter?.avatarId !== undefined) state.avatarIds[seat] = drafter.avatarId;
		bumpSeq(state);
		room.app.persist(room);
	}
	return { client, seat, changed };
}

/**
 * Join a connection that takes no seat: `joinRoom` without its
 * `seatParticipant`, which would evict a bot for anyone who asks.
 */
function watchRoom(room: DraftRoom, clientId: string, participantId: ParticipantId, tier: string): ClientMeta<DraftClient> {
	const at = Date.now();
	const meta: ClientMeta<DraftClient> = { clientId, socketId: clientId, participantId, joinedAt: at, lastSeen: at, app: { tier, watching: null } };
	room.clients.set(clientId, meta);
	room.updatedAt = at;
	return meta;
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
	room.app.persist(room);
	return true;
}

interface LeaveOutcome {
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
	if (changed) {
		bumpSeq(state);
		room.app.persist(room);
	}
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
		room.app.persist(room);
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

/**
 * The drafter's last saved build, `.dck` text — or null before the first save.
 * `drafts.ts`'s `GET …/mine` sends this back verbatim; it is never checked
 * here, because `PUT …/deck` already checked it with `gate.ts`'s draft rule
 * before calling `saveBuiltDeck`.
 */
export function builtDeckOf(room: DraftRoom, participantId: ParticipantId): string | null {
	return room.app.builtDecks[participantId] ?? null;
}

/**
 * Save it. Write-through: persisted to disk before this returns, same as every
 * seat transition in this file — a build is lost on a crash only if it was
 * never saved at all.
 */
export function saveBuiltDeck(room: DraftRoom, participantId: ParticipantId, dck: string): void {
	room.app.builtDecks[participantId] = dck;
	room.app.persist(room);
}

/** Rename or delete this drafter's deck — write-through, like a save. */
export function setDeckMeta(room: DraftRoom, participantId: ParticipantId, meta: DeckMeta): void {
	room.app.deckMeta[participantId] = { ...room.app.deckMeta[participantId], ...meta };
	room.app.persist(room);
}
