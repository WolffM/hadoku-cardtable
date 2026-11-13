/**
 * Every match's action log and public stream (read back by `GET /api/replays*`), the rebuild of a
 * match whose stream has expired, and the parked games either player can pick up again.
 */
import { join } from 'node:path';
import { jsonLogger } from '@hadoku/service-kernel/log';
import { FREE_PICK } from '@hadoku/shared';
import { CONFIG } from '@hadoku/game-server/config';
import { attachParked } from '../http/parked.js';
import { attachReplays } from '../http/replays.js';
import { createArtIds } from '../play/art-ids.js';
import { coldStartsFrom, jvmHostFactory, roomDeckCosts } from '../play/index.js';
import { openParkedStore } from '../play/parked.js';
import { bridgeDigest, createRecorder, forgePin, serverVersion } from '../play/recording/recorder.js';
import { canRebuildBoolean, rebuildForReplays } from '../play/recording/rebuild.js';
import { sweepRecordings } from '@hadoku/game-server/play/recording/retention';
import { queueColdStarts } from '@hadoku/game-server/play/start-queue';
import { draftIdOfPool } from '../room/lobby.js';
import type { CardtablePlugin } from './state.js';

const RECORDINGS_SWEEP_MS = 60 * 60_000;

export const recordingsPlugin: CardtablePlugin = {
	name: 'recordings',
	phase: 'routes',
	setup(ctx) {
		const { api, state } = ctx;
		const { forge, lobby, catalog } = state;
		state.deckCosts = roomDeckCosts(state.tables.library, state.defaultCubeCards);
		const deckCosts = state.deckCosts;

		// Hooked entirely from outside `match.ts`/`host.ts`: the host factory play is given (wrapped
		// here) and `PlayDeps.onEnvelope`. `pin`/`bridge`/`server` are each read once, at boot, from
		// values this server already has, never a `git` shell-out at runtime.
		const recordingsLog = jsonLogger('cardtable-recording');
		const dir = CONFIG.recordingsDir;
		state.serverBuild = serverVersion(state.pkgRoot);
		state.recorder = createRecorder({
			dir,
			identity: {
				pin: forge.ok ? forgePin(forge.config.jar) : null,
				bridge: forge.ok ? bridgeDigest(forge.config.bridgeSource) : 'no-forge',
				server: state.serverBuild,
			},
			roomOf: (matchId) => lobby.roomOfMatch(matchId)?.id ?? null,
			deckCosts,
			catalog,
			// The recorder only asks once a match is running, by which time play is attached.
			seatsOf: (matchId) => state.play?.matches.get(matchId)?.seatIdentities(),
			usersOf: (matchId) => {
				const match = state.play?.matches.get(matchId);
				const room = lobby.roomOfMatch(matchId);
				if (match === undefined || room === undefined) return undefined;
				const users = new Map(lobby.usersOf(room.id).map((u) => [u.memberId, u.userId]));
				return match.seats.map((s) => (s.owner === null ? null : (users.get(s.owner) ?? null)));
			},
			log: recordingsLog,
		});
		sweepRecordings(dir, Date.now(), recordingsLog);
		setInterval(() => sweepRecordings(dir, Date.now(), recordingsLog), RECORDINGS_SWEEP_MS).unref();
		ctx.bootPhase('recordings');

		// A match whose public stream has expired is rebuilt on its own JVM, through a separate
		// same-sized boot queue from play's, so a rebuild's boot never crowds out a real match's. Its
		// own work directory: a pool sweeps its directory when made and takes back every JVM it finds
		// there, so a rebuild pool sharing the play pool's would adopt live matches' JVMs. Without
		// Forge, a match whose stream is gone answers `source: 'none'`/404 rather than a crash.
		const rebuildHost = forge.ok
			? queueColdStarts(jvmHostFactory({ ...forge.config, workDir: join(forge.config.workDir, 'rebuild') }, { warm: false, log: recordingsLog }), coldStartsFrom(), recordingsLog)
			: null;
		attachReplays(api, {
			dir,
			isTesting: (roomId) => (roomId === null ? false : lobby.get(roomId)?.testing === true),
			stillPlaying: (matchId, caller) => lobby.stillPlaying(matchId, caller),
			people: state.people,
			artIds: (decks) => createArtIds(catalog ?? null, decks),
			log: recordingsLog,
			canRebuild: canRebuildBoolean,
			...(rebuildHost === null ? {} : { rebuild: (matchId: string) => rebuildForReplays(matchId, { recordingsDir: dir, host: rebuildHost, log: recordingsLog, deckCosts, catalog }) }),
		});

		// A game both players walked away from is parked once the rejoin grace runs out, and either of
		// them picks it up again from the stats popout's Unfinished games, from its last turn-start
		// snapshot. On disk for good, beside the rooms.
		const parkedLog = jsonLogger('cardtable-parked');
		state.parked = openParkedStore({
			dir: CONFIG.parkedDir,
			log: parkedLog,
			roomOf: (matchId) => lobby.roomOfMatch(matchId),
			formatName: (pool) => (draftIdOfPool(pool) !== null ? 'Draft' : pool === FREE_PICK ? 'Free pick' : (state.library.format(pool)?.pool.name ?? pool)),
			pin: forge.ok ? forgePin(forge.config.jar) : null,
		});
		attachParked(api, { store: state.parked, lobby, play: () => state.play, log: parkedLog, ...(CONFIG.testNoRateLimits ? { resumeRateLimit: null } : {}) });
	},
};
