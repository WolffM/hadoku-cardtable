/**
 * The seeded testing rooms (the operator: *"set up some testing rooms for me
 * that are in a separate room section on the front page and are admin only
 * visible"*) — a fixed, named set of rooms, created idempotently at boot
 * through the SAME paths a human leader uses (`Lobby.create`, `setSettings`,
 * `setPodPlan`), never a parallel construction path.
 *
 * ## Identity, not a flag the caller passes
 *
 * Each room's STABLE identity is its `name` — `seedTestingRooms` reads
 * `lobby.list()` first and skips any spec whose name a testing room already
 * holds, so a restart (or a reseed after an admin's close, below) never
 * duplicates one. There is no separate id scheme: the lobby already mints
 * room ids, and nothing here needs to predict them.
 *
 * ## Who "creates" them
 *
 * `Lobby.create` requires a durable caller (`isDurableParticipantId`), so
 * every seeded room is created by `TESTING_SEED_CALLER`, a synthetic `dev:`
 * identity nobody's browser can ever present, which leaves once the room is
 * set up. The room starts empty (`offered()`'s "an empty room is hidden"
 * rule never applies to it — `room/lobby.ts`'s `testing` bypass), the first
 * admin to join leads it (`join`), and any admin in it may close it
 * (`close`'s `testing` bypass).
 *
 * ## The set-draft room needs a catalog
 *
 * Four of the five specs need nothing beyond `Lobby.create`/`setSettings` —
 * the cube-draft room does not even need `setPodPlan`, since
 * `draftRooms.ts`'s `DEFAULT_PLAN` already IS "MTGO Vintage Cube 2025-04 ×
 * 3". Only "Testing: Set draft" needs the newest set Forge's catalog
 * currently offers, which needs a jar. Without one (every unit test, and any
 * boot with no Forge configured) `deps.newestSetCode` answers `null` and
 * this room is skipped and logged — never created with a wrong or empty
 * pool. `index.ts` wires the real `newestSetCode` from `setsStore.list()`
 * (newest first) and the real `checkPlan` it already built for
 * `attachRooms`.
 */

import type { Caller, Lobby } from './lobby.ts';
import type { DraftPlan, PoolVerdict, RoomMode } from '@hadoku/shared';

/**
 * A `dev:` identity (device tier — `isDurableParticipantId` admits it) no
 * real browser can ever present: nobody derives a device id from the literal
 * string `testing-seed`. Exported so a test can recognise "the seed's own
 * member" without hard-coding the id a second time.
 */
export const TESTING_SEED_CALLER: Caller = { id: 'dev:testing-seed', name: 'Testing' };

interface TestingRoomSpec {
	name: string;
	gameType: 'constructed-1v1' | 'draft';
	mode?: RoomMode;
	settings?: { tournament?: boolean; tournamentDecks?: 'locked' | 'per-round' };
}

/** Every testing room but the set draft, which needs an async catalog lookup (`seedSetDraft`, below). */
const SPECS: readonly TestingRoomSpec[] = [
	{ name: 'Testing: Constructed 1v1 (Classic)', gameType: 'constructed-1v1', mode: { mode: 'classic', modeOptions: {} } },
	{
		name: 'Testing: Constructed tournament (Classic, per-round decks)',
		gameType: 'constructed-1v1',
		mode: { mode: 'classic', modeOptions: {} },
		settings: { tournament: true, tournamentDecks: 'per-round' },
	},
	{
		name: 'Testing: Gauntlet tournament',
		gameType: 'constructed-1v1',
		mode: { mode: 'gauntlet', modeOptions: {} },
		settings: { tournament: true },
	},
	// The default plan every fresh draft room opens on is already "MTGO
	// Vintage Cube 2025-04 × 3" (`draftRooms.ts`'s `DEFAULT_PLAN`) — nothing
	// here has to set it.
	{ name: 'Testing: Cube draft (MTGO Vintage Cube 2025-04)', gameType: 'draft' },
];

/** The set-draft room's own stable name — never the set's name, so a new set releasing never orphans this one and spawns a second. */
export const TESTING_SET_DRAFT_NAME = 'Testing: Set draft';

export interface TestingRoomsDeps {
	lobby: Lobby;
	log?: (entry: Record<string, unknown>) => void;
	/** The newest set code the catalog currently offers, or `null` with no jar/catalog (every unit test). Omitted entirely: the same as always answering `null`. */
	newestSetCode?: () => Promise<string | null>;
	/** The same verdict function `attachRooms` is given for `PUT …/pod/plan`. Omitted entirely: the same as `newestSetCode` always answering `null`. */
	checkPlan?: (plan: DraftPlan) => Promise<PoolVerdict>;
}

function noopLog(): void {}

function seedOne(lobby: Lobby, spec: TestingRoomSpec, log: (entry: Record<string, unknown>) => void): void {
	const result = lobby.create(TESTING_SEED_CALLER, {
		name: spec.name,
		gameType: spec.gameType,
		clientMode: 'builtin',
		mode: spec.mode,
		testing: true,
	});
	if (!result.ok) {
		log({ event: 'testing-room-seed-failed', name: spec.name, reason: result.reason });
		return;
	}
	if (spec.settings !== undefined) {
		const settled = lobby.setSettings(result.room.id, TESTING_SEED_CALLER.id, spec.settings);
		if (!settled.ok) log({ event: 'testing-room-settings-failed', name: spec.name, reason: settled.reason });
	}
	lobby.leave(result.room.id, TESTING_SEED_CALLER.id);
	log({ event: 'testing-room-seeded', name: spec.name, roomId: result.room.id });
}

async function seedSetDraft(deps: TestingRoomsDeps, log: (entry: Record<string, unknown>) => void): Promise<void> {
	if (deps.newestSetCode === undefined || deps.checkPlan === undefined) {
		log({ event: 'testing-room-seed-skipped', name: TESTING_SET_DRAFT_NAME, reason: 'no catalog wired' });
		return;
	}
	const code = await deps.newestSetCode();
	if (code === null) {
		log({ event: 'testing-room-seed-skipped', name: TESTING_SET_DRAFT_NAME, reason: 'catalog offers no sets' });
		return;
	}
	const source = { kind: 'set' as const, code, style: 'set-cube' as const };
	const plan: DraftPlan = { rounds: [source, source, source] };
	const verdict = await deps.checkPlan(plan);
	if (!verdict.ok) {
		log({ event: 'testing-room-seed-skipped', name: TESTING_SET_DRAFT_NAME, reason: 'plan refused', code });
		return;
	}
	const created = deps.lobby.create(TESTING_SEED_CALLER, {
		name: TESTING_SET_DRAFT_NAME,
		gameType: 'draft',
		clientMode: 'builtin',
		testing: true,
	});
	if (!created.ok) {
		log({ event: 'testing-room-seed-failed', name: TESTING_SET_DRAFT_NAME, reason: created.reason });
		return;
	}
	const set = deps.lobby.setPodPlan(created.room.id, TESTING_SEED_CALLER.id, plan, verdict);
	deps.lobby.leave(created.room.id, TESTING_SEED_CALLER.id);
	if (!set.ok) log({ event: 'testing-room-plan-failed', name: TESTING_SET_DRAFT_NAME, reason: set.reason });
	else log({ event: 'testing-room-seeded', name: TESTING_SET_DRAFT_NAME, roomId: created.room.id, code });
}

/**
 * Create every testing room this store does not already hold one of, by
 * name. Safe to call on every boot (idempotent — two boots on the same store
 * seed nothing twice) and again right after an admin closes one (`close` is
 * "forgotten, then immediately re-seeded fresh under the same identity" —
 * `http/rooms.ts`'s close route calls this again rather than special-casing
 * a reset).
 */
export async function seedTestingRooms(deps: TestingRoomsDeps): Promise<void> {
	const { lobby } = deps;
	const log = deps.log ?? noopLog;
	const existing = new Set(lobby.list().filter((r) => r.testing).map((r) => r.name));
	for (const spec of SPECS) {
		if (existing.has(spec.name)) continue;
		seedOne(lobby, spec, log);
	}
	if (!existing.has(TESTING_SET_DRAFT_NAME)) await seedSetDraft(deps, log);
}
