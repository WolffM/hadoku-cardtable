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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSeat, legalLibraryDecks, publicVerdict } from '../http/gate.ts';
import type { TablesLibrary } from '../http/library.ts';
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
	/** This room's own board, carried onto every match it starts (`CreateRoomInput.scenario`'s doc). */
	scenario?: string;
}

/**
 * The operator, 2026-10-23: "construct some more complex board states … that
 * i can jump into" — the text of `play/scenarios/<name>.state` (the same
 * Forge puzzle `[state]` format and directory `scenario-*.jvm.test.ts` and
 * `e2e/play/scenario.ts` read; `scenario.ts` next door is NOT read here
 * instead — it is a vitest-only test helper (a module-level `afterEach`),
 * never safe to import from code the production server boots).
 *
 * Two candidates, same trick `play/host.ts`'s `defaultBridgeSource` uses for
 * `PlayBridge.java`: under `tsx`/vitest this file runs from
 * `src/room/testing-rooms.ts`, one level above `src/play/scenarios/`; in the
 * esbuild bundle it is ONE file at `dist/index.js`, which collapses that
 * depth — `../play/scenarios` from there resolves to a `play/scenarios` that
 * does not exist (an e2e run on the real built server, proof run 40008992625,
 * is what caught this: `ENOENT …/apps/server/play/scenarios/…`). The second
 * candidate goes back up to the package's own `src/`, which still exists on
 * disk next to a built `dist/` — nothing deletes it.
 */
function scenarioText(name: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, '..', 'play', 'scenarios', `${name}.state`), resolve(here, '..', 'src', 'play', 'scenarios', `${name}.state`)];
	const path = candidates.find((p) => existsSync(p)) ?? candidates[0]!;
	return readFileSync(path, 'utf8');
}

/** A board-state room's own gameType/mode: Classic Constructed, no tournament — one admin starts it against the AI from its own table. */
const BOARD_STATE_MODE: RoomMode = { mode: 'classic', modeOptions: {} };

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
	// The complex boards (operator, 2026-10-23 on), each a Classic 1v1 the admin
	// starts vs the AI from its own table — the normal "add a bot" path
	// (`http/routes.ts`'s `startFromRoom`) carries the scenario through once
	// `scripts/art/build-art-ids.ts` has an art row for every real card named
	// in its `.state` file (`docs/planning/playtest-ledger.md`'s AF row has
	// the exact run). `scenario-tr-board-states.jvm.test.ts` is each file's
	// own proof against real Forge.
	{ name: 'Testing: Board — Midgame', gameType: 'constructed-1v1', mode: BOARD_STATE_MODE, scenario: scenarioText('tr-midgame') },
	{ name: 'Testing: Board — Protection & evasion', gameType: 'constructed-1v1', mode: BOARD_STATE_MODE, scenario: scenarioText('tr-protection') },
	{ name: 'Testing: Board — Combat', gameType: 'constructed-1v1', mode: BOARD_STATE_MODE, scenario: scenarioText('tr-combat') },
	{ name: 'Testing: Board — Stack', gameType: 'constructed-1v1', mode: BOARD_STATE_MODE, scenario: scenarioText('tr-stack') },
	{ name: 'Testing: Board — Big board', gameType: 'constructed-1v1', mode: BOARD_STATE_MODE, scenario: scenarioText('tr-bigboard') },
	// The operator, 2026-10-23: "a very complex board with tons of creatures and potential triggers".
	{ name: 'Testing: Board — Trigger storm', gameType: 'constructed-1v1', mode: BOARD_STATE_MODE, scenario: scenarioText('tr-triggers') },
	// The operator, 2026-10-26: "give me a test room with a gifts ungiven deck and four mana on turn one".
	{ name: 'Testing: Board — Gifts Ungiven', gameType: 'constructed-1v1', mode: BOARD_STATE_MODE, scenario: scenarioText('tr-gifts') },
];

/** The set-draft room's own stable name — never the set's name, so a new set releasing never orphans this one and spawns a second. */
export const TESTING_SET_DRAFT_NAME = 'Testing: Set draft';

/**
 * The two "already in progress" tournament rooms (the operator, 2026-10-23:
 * "some rooms that have tournaments and games in progress so i can validate
 * the ui and game actions better"). Each is seeded through the SAME lobby
 * APIs a real field uses — `sitPod`/`aiPod`/`recordGameResult` — never a
 * parallel pod-construction path, with `TESTING_SEED_CALLER` standing in for
 * the human entrant through round 1, then leaving: `join`'s "an emptied
 * room's leader left with everyone else: whoever comes in first leads it"
 * already covers a seeded room that empties a SECOND time (round 1 starts
 * with the same empty-room convention the four lobby-phase rooms use), and
 * `room/lobby.ts`'s `#settleSeries` now skips `onSeriesEnd` for any
 * `room.testing` table, so that `leave()` re-settling round 1's decided
 * series never reaches the real match-stats store.
 */
export const TESTING_CLASSIC_ROUND2_NAME = 'Testing: Constructed tournament — round 2';
export const TESTING_GAUNTLET_ROUND2_NAME = 'Testing: Gauntlet tournament — round 2';

export interface TestingRoomsDeps {
	lobby: Lobby;
	log?: (entry: Record<string, unknown>) => void;
	/** The newest set code the catalog currently offers, or `null` with no jar/catalog (every unit test). Omitted entirely: the same as always answering `null`. */
	newestSetCode?: () => Promise<string | null>;
	/** The same verdict function `attachRooms` is given for `PUT …/pod/plan`. Omitted entirely: the same as `newestSetCode` always answering `null`. */
	checkPlan?: (plan: DraftPlan) => Promise<PoolVerdict>;
	/**
	 * The real deck gate's library (`http/gate.ts`, `http/library.ts`) — the
	 * SAME one `index.ts` already builds for `attachTables`, needed for one
	 * legal Classic library deck to seat `TESTING_SEED_CALLER` with before a
	 * Classic tournament's lock (`#lockTournament`'s own
	 * `PodChecks.hasLegalSeatDeck` gate, which reads back exactly the shape
	 * `legalClassicDeckState` below builds). Omitted entirely (every unit test
	 * that never wires it): `TESTING_CLASSIC_ROUND2_NAME` is skipped and
	 * logged, same discipline as `newestSetCode`. The Gauntlet room needs none
	 * of this — `humanReady` there is just the room's own `ready` flag.
	 */
	library?: TablesLibrary;
}

function noopLog(): void {}

function seedOne(lobby: Lobby, spec: TestingRoomSpec, log: (entry: Record<string, unknown>) => void): void {
	const result = lobby.create(TESTING_SEED_CALLER, {
		name: spec.name,
		gameType: spec.gameType,
		clientMode: 'builtin',
		mode: spec.mode,
		testing: true,
		...(spec.scenario === undefined ? {} : { scenario: spec.scenario }),
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
 * A `TablePlayerState` holding ONE legal Classic library deck for `format` —
 * the exact shape `http/routes.ts`'s `PUT …/deck` route builds (`choice` /
 * `verdict` / `text`), built from a REAL `checkSeat` verdict rather than a
 * fabricated `{ legal: true }`, so `PodChecks.hasLegalSeatDeck` (which reads
 * this shape straight back off the member) passes on a deck that genuinely
 * is legal. "The picker's first legal option" — `legalLibraryDecks`'s own
 * offered order — rather than a fixed deck id, the same rule
 * `e2e/tr-board-state-room.spec.ts` already picked for a board-state room
 * (a fixed id can stop being legal under a library change). `null` when
 * `format` offers no legal library deck at all (a thin test library).
 */
function legalClassicDeckState(library: TablesLibrary, format: string): unknown | null {
	const ctx = { library, draftPool: null };
	const offered = legalLibraryDecks(format, ctx);
	if ('error' in offered || offered.ids.length === 0) return null;
	const deckId = offered.ids[0]!;
	const rules = { kind: 'standard' as const, format };
	const verdict = checkSeat({ deck: { library: deckId }, rules }, ctx);
	if ('error' in verdict) return null;
	return { v: 1, deck: { choice: { deck: { library: deckId }, rules }, verdict: publicVerdict(verdict), text: verdict.text }, seriesDeck: null };
}

/**
 * Seat `TESTING_SEED_CALLER` at pod seat 0 plus two AI entrants at seats 1
 * and 2 (`roundsFor(3) === 2` — this field plays exactly two Swiss rounds,
 * enough for "round 2" to exist and no more), THEN `makeEntrantReady` (never
 * before: `sitPod`/`aiPod` each retry the lock — `#maybeLockTournament`'s own
 * doc — and locking at 2 entrants, the instant the seed is ready and one AI
 * is seated, is exactly the bug this order avoids: `roundsFor(2) === 1`, one
 * round and done, never a round 2), and record round 1's one live pairing
 * (seat order puts the seed against the LOWER AI seat; the higher one draws
 * round 1's bye — `@hadoku/draft`'s `round1`) as a 2-0 win for the seed.
 * `#finishPodTable` advances the pod to round 2 by itself, in the same
 * `recordGameResult` call, exactly as a real table's last game would.
 *
 * `makeEntrantReady` must itself retrigger the lock (`setReady` does;
 * `setPlayerState` does not, so a Classic caller's own one has to follow it
 * with a redundant re-`sitPod`, which does).
 *
 * Answers round 2's own table id, or `null` with the room (and its match
 * stats, since this is always `room.testing`) untouched beyond what already
 * logged the refusal: the tournament never locked, round 1's result was
 * refused, or round 2 never opened.
 */
function playRound1VsTwoAi(lobby: Lobby, roomId: string, name: string, makeEntrantReady: () => void, log: (entry: Record<string, unknown>) => void): string | null {
	lobby.sitPod(roomId, TESTING_SEED_CALLER.id, 0);
	lobby.aiPod(roomId, TESTING_SEED_CALLER.id, 1, true);
	lobby.aiPod(roomId, TESTING_SEED_CALLER.id, 2, true);
	makeEntrantReady();
	const locked = lobby.get(roomId);
	if (locked === undefined || locked.pod === null || locked.pod.pairings.length === 0) {
		log({ event: 'testing-room-seed-failed', name, reason: 'tournament-did-not-lock' });
		return null;
	}
	const round1TableId = locked.pod.pairings[0]!.tableId;
	for (const matchId of [`${roomId}-r1-g1`, `${roomId}-r1-g2`]) {
		const recorded = lobby.recordGameResult(roomId, round1TableId, { matchId, winner: 0 });
		if (!recorded.ok) {
			log({ event: 'testing-room-seed-failed', name, reason: 'record-game-result-refused' });
			return null;
		}
	}
	const afterRound1 = lobby.get(roomId);
	if (afterRound1 === undefined || afterRound1.pod === null || afterRound1.pod.round !== 2 || afterRound1.pod.pairings.length === 0) {
		log({ event: 'testing-room-seed-failed', name, reason: 'round-2-did-not-open' });
		return null;
	}
	return afterRound1.pod.pairings[0]!.tableId;
}

/**
 * "Testing: Constructed tournament — round 2": Classic, `per-round` decks
 * (so round 2's table holds no deck at all once it pairs — `#newPodTable`'s
 * `#seatTournamentDeck` clears a per-round hold on every round, the seed's
 * own included), its round-2 table starting from a board scenario once the
 * admin presses Start — the SAME `startFromRoom` every room's vs-AI start
 * already carries `room.scenario` through (`http/routes.ts`), so this needed
 * no new plumbing. Skipped and logged, never half-built, when `deps.library`
 * is not wired or offers no legal deck for this room's format.
 */
async function seedTournamentRound2Classic(deps: TestingRoomsDeps, log: (entry: Record<string, unknown>) => void): Promise<void> {
	const { lobby } = deps;
	if (deps.library === undefined) {
		log({ event: 'testing-room-seed-skipped', name: TESTING_CLASSIC_ROUND2_NAME, reason: 'no library wired' });
		return;
	}
	const created = lobby.create(TESTING_SEED_CALLER, {
		name: TESTING_CLASSIC_ROUND2_NAME,
		gameType: 'constructed-1v1',
		clientMode: 'builtin',
		mode: { mode: 'classic', modeOptions: {} },
		testing: true,
		scenario: scenarioText('tr-combat'),
	});
	if (!created.ok) {
		log({ event: 'testing-room-seed-failed', name: TESTING_CLASSIC_ROUND2_NAME, reason: created.reason });
		return;
	}
	const roomId = created.room.id;
	const settled = lobby.setSettings(roomId, TESTING_SEED_CALLER.id, { tournament: true, tournamentDecks: 'per-round' });
	if (!settled.ok) {
		log({ event: 'testing-room-settings-failed', name: TESTING_CLASSIC_ROUND2_NAME, reason: settled.reason });
		return;
	}
	const deckState = legalClassicDeckState(deps.library, created.room.format);
	if (deckState === null) {
		log({ event: 'testing-room-seed-skipped', name: TESTING_CLASSIC_ROUND2_NAME, reason: 'no legal deck for this format', format: created.room.format });
		return;
	}
	const makeEntrantReady = (): void => {
		lobby.setPlayerState(roomId, TESTING_SEED_CALLER.id, deckState);
		// `setPlayerState` does not itself retrigger the lock (`playRound1VsTwoAi`'s
		// own doc) — a redundant re-`sitPod` at the same seat does.
		lobby.sitPod(roomId, TESTING_SEED_CALLER.id, 0);
	};
	if (playRound1VsTwoAi(lobby, roomId, TESTING_CLASSIC_ROUND2_NAME, makeEntrantReady, log) === null) return;
	lobby.leave(roomId, TESTING_SEED_CALLER.id);
	log({ event: 'testing-room-seeded', name: TESTING_CLASSIC_ROUND2_NAME, roomId });
}

/**
 * "Testing: Gauntlet tournament — round 2": Gauntlet's own `humanReady` is
 * just the room's `ready` flag (no deck to hold before the lock), and its
 * round-2 table deals fresh through its own draw/banpick/choose flow — never
 * a held deck `#newPodTable` could clear. No board scenario: Gauntlet's
 * `ready` ultimately starts its match through the same `startFromRoom` a
 * Classic vs-AI table does, but nothing here has traced that interaction
 * against a real Forge puzzle `.state` file the way the Classic room's
 * reuses an already-proven path, so this is left a fresh board rather than
 * guessed at.
 */
async function seedTournamentRound2Gauntlet(deps: TestingRoomsDeps, log: (entry: Record<string, unknown>) => void): Promise<void> {
	const { lobby } = deps;
	const created = lobby.create(TESTING_SEED_CALLER, {
		name: TESTING_GAUNTLET_ROUND2_NAME,
		gameType: 'constructed-1v1',
		clientMode: 'builtin',
		mode: { mode: 'gauntlet', modeOptions: {} },
		testing: true,
	});
	if (!created.ok) {
		log({ event: 'testing-room-seed-failed', name: TESTING_GAUNTLET_ROUND2_NAME, reason: created.reason });
		return;
	}
	const roomId = created.room.id;
	const settled = lobby.setSettings(roomId, TESTING_SEED_CALLER.id, { tournament: true });
	if (!settled.ok) {
		log({ event: 'testing-room-settings-failed', name: TESTING_GAUNTLET_ROUND2_NAME, reason: settled.reason });
		return;
	}
	const makeEntrantReady = (): void => {
		lobby.setReady(roomId, TESTING_SEED_CALLER.id, true);
	};
	if (playRound1VsTwoAi(lobby, roomId, TESTING_GAUNTLET_ROUND2_NAME, makeEntrantReady, log) === null) return;
	lobby.leave(roomId, TESTING_SEED_CALLER.id);
	log({ event: 'testing-room-seeded', name: TESTING_GAUNTLET_ROUND2_NAME, roomId });
}

/**
 * Create every testing room this store does not already hold one of, by
 * name. Safe to call on every boot (idempotent — two boots on the same store
 * seed nothing twice) and again right after an admin closes one (`close` is
 * "forgotten, then immediately re-seeded fresh under the same identity" —
 * `http/rooms.ts`'s close route calls this again rather than special-casing
 * a reset).
 *
 * It never rejects: `index.ts` starts it unawaited, where a rejection is
 * unhandled and ends the server. A room whose seeding throws (the set draft's
 * catalog is a pool-JVM round trip that can time out) is logged and skipped.
 *
 * The async seeds all start at once, so none waits on another: the set
 * draft's catalog lookup can take half a minute on a loaded host, and the
 * round-2 rooms need no JVM at all.
 */
export async function seedTestingRooms(deps: TestingRoomsDeps): Promise<void> {
	const { lobby } = deps;
	const log = deps.log ?? noopLog;
	const existing = new Set(lobby.list().filter((r) => r.testing).map((r) => r.name));
	for (const spec of SPECS) {
		if (existing.has(spec.name)) continue;
		seedOne(lobby, spec, log);
	}
	const seeds: [string, (deps: TestingRoomsDeps, log: (entry: Record<string, unknown>) => void) => Promise<void>][] = [
		[TESTING_SET_DRAFT_NAME, seedSetDraft],
		[TESTING_CLASSIC_ROUND2_NAME, seedTournamentRound2Classic],
		[TESTING_GAUNTLET_ROUND2_NAME, seedTournamentRound2Gauntlet],
	];
	await Promise.all(
		seeds
			.filter(([name]) => !existing.has(name))
			.map(async ([name, seed]) => {
				try {
					await seed(deps, log);
				} catch (err) {
					log({ event: 'testing-room-seed-failed', name, detail: err instanceof Error ? err.message : String(err) });
				}
			}),
	);
}
