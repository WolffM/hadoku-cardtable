/**
 * The rooms and drafts an earlier process left, read back and settled (`boot.ts`), plus how a room
 * closing or forfeiting reaches its matches and its draft.
 *
 * Persisted, because this repo redeploys several times a day and an in-memory room would take its
 * members and its password with it every time (`CONFIG.dataDir`). Built before the draft socket,
 * whose readiness gate is a lobby read.
 */
import { podPickNumber } from '@hadoku/draft';
import { CONFIG } from '../config.js';
import { restoreRooms } from '../boot.js';
import { busyReport } from '../busy.js';
import { endForfeitedGame } from '../http/table-actions.js';
import { DEFAULT_PLAN, stateOf, type PoolSourceResolver } from '../room/draftRooms.js';
import { emitDraftUpdate, draftEmitPolicy } from '../room/emit.js';
import { newestFormat } from '../room/lobby.js';
import { seedTestingRooms } from '../room/testing-rooms.js';
import { seedReplay } from '../room/seed-replay.js';
import { jsonLogger } from '@hadoku/service-kernel/log';
import type { CardtablePlugin } from './state.js';

/**
 * A disconnected drafter keeps their seat this long before it is vacated and held, so a browser
 * refresh (whose old socket closes BEFORE the new one joins, ~36 ms on loopback) is invisible to
 * the rest of the pod. Five seconds covers a reload through the edge with room to spare.
 */
const DISCONNECT_GRACE_MS = 5_000;

export const roomsPlugin: CardtablePlugin = {
	name: 'rooms',
	phase: 'stores',
	async setup(ctx) {
		const { state } = ctx;
		const poolResolver: PoolSourceResolver = {
			cards(src) {
				if (src.kind === 'cube') return state.cubeStore.cards(src.cubeId) ?? [];
				// Both set styles answer with the set's non-basic singletons (`setsStore.cachedCards`):
				// `deal()` never asks for a realistic round's cards, so this is only `cubeMetaOf`'s
				// wire-facing size, and `[]` there made `CubeMeta.size` 0 and failed the whole `state`.
				return state.setsStore.cachedCards(src.code) ?? [];
			},
			name(src) {
				if (src.kind === 'cube') return state.cubeStore.list().find((c) => c.id === src.cubeId)?.name ?? src.cubeId;
				return state.setsStore.nameOf(src.code) ?? src.code;
			},
		};
		const draftPolicy = draftEmitPolicy(jsonLogger('cardtable-draft'));
		// A deploy mid-pod resumes it, a draft room whose draft did not come back goes back to its
		// lobby, and the idle rooms are swept. A new room opens on a random era unless
		// `CONFIG.newRoomFormat` pins it.
		const { lobby, draftRooms } = await restoreRooms({
			lobby: {
				dir: CONFIG.roomsDir,
				formats: state.library.formats,
				...(CONFIG.newRoomFormat === 'newest' ? { defaultFormat: newestFormat(state.library.formats) } : {}),
				log: state.roomsLog,
				onTournament: (t) => state.tournaments.record(t),
				onSeriesEnd: (end) => state.matchStats.seriesEnd(end),
				// A room's plan checks itself in the background, with the same function PUT …/pod/plan runs.
				checkPlan: state.checkDraftPlan,
			},
			drafts:
				state.cubeStore.list().length > 0
					? {
							resolver: poolResolver,
							defaultPlan: DEFAULT_PLAN,
							params: { disconnectGraceMs: DISCONNECT_GRACE_MS },
							// The grace ran out: the seat was vacated on a timer, with no socket event to answer.
							onDeferredChange: (room) => emitDraftUpdate(ctx.io, room, draftPolicy),
							// A 45-minute draft must survive this process restarting on every push to main.
							storeDir: CONFIG.draftsDir,
						}
					: null,
			log: state.roomsLog,
		});
		state.lobby = lobby;
		state.draftRooms = draftRooms;
		// A plan name read before the set names warmed showed the bare code; every draft room is read
		// again once they arrive. Wired before `listen`, so no view is served without it.
		state.setsStore.onNamed(() => lobby.poolNamesChanged());
		ctx.bootPhase('rooms');

		// The seeded, admin-only testing rooms. Idempotent by name, so calling it again (at listen, and
		// after an admin closes one) recreates only what is missing. Never on the boot path: nothing
		// optional may keep `listen` waiting, and an async function runs to its first `await` at once,
		// so even unawaited its fifty fsynced room writes held a first boot on a slow disk.
		state.runTestingRoomSeed = (): Promise<void> =>
			seedTestingRooms({
				lobby,
				log: state.roomsLog,
				newestSetCode: async () => (await state.setsStore.list())[0]?.code ?? null,
				checkPlan: state.checkDraftPlan,
				library: state.library,
			});
		// A historical replay room, seeded the same off-boot way the testing
		// rooms are (`seed-replay.ts`'s own doc): idempotent by name, so a warm
		// hook that runs twice recreates nothing. Set only when the operator
		// names a tournament to replay — absent, nothing seeds and no cost is
		// paid. `CARDTABLE_REPLAY_TOURNAMENT` is the repo-root-relative
		// `tournament.json`; `CARDTABLE_REPLAY_COLLECTION` its library
		// collection id; `CARDTABLE_REPLAY_SEAT` (0-7) whose player YOU replay.
		state.runReplaySeed = (): Promise<void> => {
			const tournament = process.env.CARDTABLE_REPLAY_TOURNAMENT;
			if (tournament === undefined || tournament === '') return Promise.resolve();
			const collection = process.env.CARDTABLE_REPLAY_COLLECTION ?? '';
			const seat = process.env.CARDTABLE_REPLAY_SEAT ?? '5';
			const full = process.env.CARDTABLE_REPLAY_FULL === '1';
			return seedReplay(lobby, { tournament, collection, seat: Number(seat), full }, state.roomsLog);
		};
		/** A tournament entrant's leave dropped them from a match: its games end as their forfeit, and its seats' decks are restored. */
		state.roomForfeited = (roomId, tableId, loser, matches) => {
			for (const id of matches) endForfeitedGame(state.play?.matches.get(id), loser);
			state.tables.seriesEnded(roomId, tableId);
		};
		state.roomClosed = (roomId, matches) => {
			for (const id of matches) state.play?.matches.get(id)?.stop();
			// An unfinished draft has no deck to keep; a finished one stays on its drafters' Decks page.
			const draft = draftRooms?.find(roomId);
			if (draft !== undefined && stateOf(draft).status !== 'complete') draftRooms?.delete(roomId);
		};

		ctx.gauge('rooms', () => lobby.list().length);
		ctx.gauge('drafts', () => draftRooms?.all().length ?? 0);
		// The deploy asks before it stops us, so a release waits for a live match or pod.
		ctx.busy(
			() =>
				busyReport({
					matches: () => state.play?.matches.active() ?? [],
					drafts: () =>
						(draftRooms?.all() ?? []).map((r) => ({
							id: r.roomId,
							status: r.app.state?.status,
							packNumber: r.app.state?.packNumber,
							pickNumber: r.app.state === null ? undefined : podPickNumber(r.app.state),
						})),
				}).runs,
		);
	},
};
