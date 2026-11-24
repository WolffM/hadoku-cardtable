/**
 * Magic's draft record (`drafts.ts`): `<stateDir>/history/drafts.jsonl` (`CONFIG.dataDir` is the
 * state dir when one is set).
 *
 * One store per process, opened on first use, the way `users/index.ts` holds the user store, so
 * every reader (the socket's finished draft, a closed room's abandoned one, the pools' usage, the
 * account erase) shares one file and one queue of writes. A test opens its own with
 * `createDraftRecordStore(dir, log)` and hands it to the two recorders below, or to
 * `useDraftRecordStore` when the recorder is reached through the socket or a closed room.
 *
 * - `recordDraftDone`: the pick that completes a draft (`room/socket.ts`, beside `podDraftDone`).
 * - `recordDraftsAbandoned`: a room closed while a pod of it is still drafting (`plugins/rooms.ts`'s
 *   `roomClosed`). The lobby has already forgotten the room by then, so the rounds come from the
 *   draft's own `roundSources`, its people are kept by name only, and it names no event.
 *
 * A finished draft's `eventId` is its pod's tournament id (`room/pods.ts`'s `tournamentId`,
 * `<roomId>-<draftStartedAt>`), the same value a match from that pod reports as its `event` attr.
 *
 * A testing room's draft is nobody's (`lobby.ts`'s `#archive` keeps it out of the tournaments the
 * same way), so it is not recorded.
 */

import { join } from 'node:path';
import type { DraftState } from '@hadoku/draft';
import type { PoolSource } from '@hadoku/shared';
import { CONFIG } from '@hadoku/game-server/config';
import { TESTING_STAND_IN_ID } from '@hadoku/game-server/room/lobby';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { stateOf, type DraftRoom, type DraftRooms } from '../room/draftRooms.js';
import type { Lobby } from '../room/lobby.js';
import { podOfDraftId } from '../room/pods.js';
import { createDraftRecordStore, draftRecordOf, draftSourceOf, poolSourceOfKey, type DraftRecord, type DraftRecordStore, type DraftSource } from './drafts.js';

export * from './drafts.js';

type Log = (entry: Record<string, unknown>) => void;

const log: Log = jsonLogger('cardtable-history');

let shared: DraftRecordStore | null = null;

/** The process's store, under the state dir. */
export function draftRecordStore(): DraftRecordStore {
	shared ??= createDraftRecordStore(join(CONFIG.dataDir, 'history'), log);
	return shared;
}

/**
 * The store every recorder below uses by default, in place of the state dir's: a test that drives
 * drafts through the socket or closes rooms hands its own here before the first one ends, so none
 * writes into the checkout's `apps/server/data`. `null` goes back to the state dir's.
 */
export function useDraftRecordStore(store: DraftRecordStore | null): void {
	shared = store;
}

type NameOf = (src: PoolSource) => string;

/** The commonest set code among the cards round `round` dealt (a dealt card's id ends `#<round>:<seat>:<i>`). */
function dealtSetOf(state: DraftState, round: number): string | null {
	const tally = new Map<string, number>();
	const cards = [...state.pools.flat(), ...state.queues.flat(2), ...(state.rounds[round] ?? []).flat()];
	for (const card of cards) {
		const at = /#(\d+):\d+:\d+$/.exec(card.cardId);
		if (at === null || Number(at[1]) !== round) continue;
		tally.set(card.setCode, (tally.get(card.setCode) ?? 0) + 1);
	}
	let best: string | null = null;
	for (const [code, n] of tally) if (best === null || n > tally.get(best)!) best = code;
	return best;
}

/**
 * Each pack round's source: the room's plan when the lobby still has it, else the draft's own
 * `roundSources`. A realistic round is keyed null there (its boosters come made from Forge), so with
 * no plan its set is the one its dealt boosters were printed in.
 */
function roundsOf(state: DraftState, plan: { rounds: readonly PoolSource[] } | null, nameOf: NameOf): DraftSource[] {
	if (plan !== null) return plan.rounds.map((src) => draftSourceOf(src, nameOf));
	return Array.from({ length: state.packCount }, (_, round) => {
		const src = poolSourceOfKey(state.roundSources[round] ?? null);
		if (src !== null) return draftSourceOf(src, nameOf);
		const code = dealtSetOf(state, round);
		return { kind: 'set', code: code ?? 'unknown', style: 'realistic' } as const;
	});
}

function save(store: DraftRecordStore, record: DraftRecord): void {
	store.append(record).then(
		() => log({ event: 'draft-recorded', record }),
		(err: unknown) => log({ event: 'draft-record-failed', draftId: record.draftId, outcome: record.outcome, detail: (err as Error).message }),
	);
}

export interface DraftDoneDeps {
	lobby: Pick<Lobby, 'get' | 'podDraft' | 'usersOf' | 'departedOf'>;
	rooms: Pick<DraftRooms, 'nameOf'> | null;
}

/** A draft just completed: record it, once. */
export function recordDraftDone(room: DraftRoom, deps: DraftDoneDeps, store: DraftRecordStore = draftRecordStore(), now: number = Date.now()): void {
	const state = stateOf(room);
	if (state.status !== 'complete' || store.has(state.draftId, room.createdAt)) return;
	const { roomId, pod } = podOfDraftId(state.draftId);
	const view = deps.lobby.get(roomId);
	if (view?.testing === true) return;
	// The pod's tournament (`room/pods.ts`'s `tournamentId`: the room id and its `draftStartedAt` in ms), the id a
	// match from it reports as its `event`. The view carries the start as ISO, which keeps the milliseconds.
	const started = view?.game?.draftStartedAt ?? null;
	const draftStartedAt = started === null ? null : Date.parse(started);
	const deal = deps.lobby.podDraft(state.draftId);
	const users = new Map([...deps.lobby.usersOf(roomId), ...deps.lobby.departedOf(roomId)].map((u) => [u.memberId, u.userId]));
	const nameOf: NameOf = (src) => deps.rooms?.nameOf(src) ?? (src.kind === 'cube' ? src.cubeId : src.code);
	save(
		store,
		draftRecordOf({
			state,
			roomId,
			pod: deal?.podOf === undefined ? null : pod,
			eventId: draftStartedAt === null ? null : `${roomId}-${draftStartedAt}`,
			rounds: roundsOf(state, deal?.plan ?? null, nameOf),
			userIdOf: (participantId) => users.get(participantId) ?? null,
			startedAt: room.createdAt,
			endedAt: now,
			outcome: 'complete',
		}),
	);
}

/** Room `roomId` was closed: each of its pods still drafting is recorded as abandoned. */
export function recordDraftsAbandoned(roomId: string, rooms: DraftRooms | null, store: DraftRecordStore = draftRecordStore(), now: number = Date.now()): void {
	const pods = (rooms?.all() ?? []).filter((r) => r.app.state !== null && podOfDraftId(r.roomId).roomId === roomId);
	for (const room of pods) {
		const state = stateOf(room);
		if (state.status === 'complete' || store.has(state.draftId, room.createdAt)) continue;
		const seated = state.table.seats.some((s) => s.occupant?.kind === 'human' && s.occupant.participantId === TESTING_STAND_IN_ID);
		if (seated || TESTING_STAND_IN_ID in state.table.remembered) continue;
		save(
			store,
			draftRecordOf({
				state,
				roomId,
				pod: pods.length > 1 ? podOfDraftId(state.draftId).pod : null,
				eventId: null,
				rounds: roundsOf(state, null, (src) => rooms!.nameOf(src)),
				userIdOf: () => null,
				startedAt: room.createdAt,
				endedAt: now,
				outcome: 'abandoned',
			}),
		);
	}
}
