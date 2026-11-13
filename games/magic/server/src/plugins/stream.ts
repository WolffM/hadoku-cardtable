/**
 * Streamed Forge: noVNC's pages through the containers (the HTTP half, above the SPA fallback),
 * and its RFB socket (the upgrade half). Inert unless ~/.local/share/cardtable/stream/STREAMS
 * names containers; stream/index.ts has the gate and the interim limits.
 */
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG } from '@hadoku/game-server/config';
import { attachStream, attachStreamRoutes, streamLayout } from '@hadoku/game-server/stream/index';
import { createRoomStreams, findContainerScript, scriptRunner, MAX_ROOM_SEATS } from '@hadoku/game-server/stream/alloc';
import { streamedContainerEnv, streamedEngineConfig, streamedHost } from '@hadoku/game-server/play/runtimes/streamed';
import type { CardtablePlugin } from './state.js';

/** How often the room streams are reclaimed: far finer than the 30-minute idle window it enforces, and one `docker ps`. */
const STREAM_SWEEP_MS = 60_000;

/**
 * The HTTP half, and the containers a ROOM owns (D19): a room in `streamed` mode gets one container
 * per seat, provisioned on first request and reclaimed when the room dies or nobody watches it for
 * 30 minutes. MUST be registered above the SPA fallback: below it, /stream/0/vnc.html is answered
 * with index.html and the link renders the cardtable app instead of noVNC (2026-09-21).
 */
export const streamRoutesPlugin: CardtablePlugin = {
	name: 'stream-routes',
	phase: 'routes',
	setup(ctx) {
		const { state } = ctx;
		state.streamCount = streamLayout().streamCount;
		state.streamLog = jsonLogger('cardtable-stream');
		const script = findContainerScript();
		if (script === null) {
			console.warn('[cardtable] no scripts/stream/container.sh — room-keyed streams are OFF (the static bench is unaffected)');
		}
		// The Magic config (which Forge jar/res a container mounts) is resolved and validated HERE,
		// once, rather than left to `container.sh`'s own bash fallback: `scriptRunner`'s `env` then
		// carries exactly what this process checked, so a provision failure names the jar/res this
		// log already named, never a different one the script's own default happened to find.
		// A reason here is NOT "every container will fail": `container.sh`'s own bash defaulting
		// (a fixed `~/.local/share/cardtable/forge.jar`) still runs underneath, unoverridden — this
		// just means THIS process could not confirm or name which jar/res that will turn out to be.
		const magic = script === null ? null : streamedEngineConfig();
		if (magic !== null && !magic.ok) {
			console.warn(`[cardtable] cannot confirm a Forge for the streamed desktop (${magic.reason}) — container.sh's own default decides what a container mounts`);
		}
		// Every room-keyed streamed desktop `ensureRoomStreams` starts, tracked by room key: how a
		// seat's container going up, a failed provision, and a container coming down (asked for, or
		// the allocator's own idle/room-gone sweep below, through `onEnded`) all reach ONE place in
		// this vocabulary (`runtimes/streamed.ts`'s `StreamedMatchHost`) instead of three separate,
		// ad hoc call sites.
		state.streamedHosts = new Map();
		state.roomStreams =
			script === null
				? null
				: createRoomStreams({
						// A lobby room or a draft pod: can anyone still reach this room?
						roomExists: (roomKey) => state.lobby.get(roomKey) !== undefined || state.draftRooms?.find(roomKey) !== undefined,
						script: scriptRunner(script, magic?.ok === true ? streamedContainerEnv(magic.config) : {}),
						log: state.streamLog,
						onEnded: (roomKey, reason) => {
							state.streamedHosts.get(roomKey)?.settled(reason);
							state.streamedHosts.delete(roomKey);
						},
					});

		/** Seats to provision for a room, or null for one that wants none: `clientMode` is the room's own, fixed at create (D19). */
		const streamedSeats = (roomKey: string): number | null => {
			const room = state.lobby.get(roomKey);
			if (room === undefined || room.game.clientMode !== 'streamed') return null;
			const seats = room.gameType === 'draft' ? (state.draftRooms?.params.seatCount ?? MAX_ROOM_SEATS) : 2;
			return Math.min(seats, MAX_ROOM_SEATS);
		};
		// Fire-and-forget: a cold container is ~18 s to a usable window, so the request is answered
		// "not up yet" rather than held. `streamedHost`'s own `allocate` is idempotent, so a reloading
		// browser stacks nothing; `state.streamedHosts` guards against starting a SECOND host for a
		// room already tracked, which `allocate`'s own idempotency does not by itself prevent while
		// the first one is still mid-provision.
		state.ensureRoomStreams = (roomKey) => {
			const streams = state.roomStreams;
			if (streams === null || state.streamedHosts.has(roomKey) || streams.find(roomKey) !== undefined) return;
			const seats = streamedSeats(roomKey);
			if (seats === null) return;
			state.streamedHosts.set(
				roomKey,
				streamedHost(streams, roomKey, seats, {
					fatal: (message) => state.streamLog({ evt: 'stream-allocate-refused', room: roomKey, message }),
					exit: (reason) => {
						state.streamedHosts.delete(roomKey);
						state.streamLog({ evt: 'streamed-host-exit', room: roomKey, reason });
					},
					log: (entry) => state.streamLog(entry),
				}),
			);
		};
		attachStreamRoutes(ctx.app, {
			minTier: CONFIG.minTier,
			streamBasePort: CONFIG.streamBasePort,
			streamCount: state.streamCount,
			rooms: state.roomStreams,
			ensureRoom: state.ensureRoomStreams,
			log: state.streamLog,
		});
	},
};

/**
 * The upgrade half: the floor is re-applied at the upgrade, because an `upgrade` runs no express
 * middleware. Containers outlive this process, so a new one first takes back what the old one left.
 */
export const streamSocketPlugin: CardtablePlugin = {
	name: 'stream-socket',
	phase: 'sockets',
	setup(ctx) {
		const { state } = ctx;
		const handle = attachStream(ctx.httpServer, {
			minTier: CONFIG.minTier,
			streamBasePort: CONFIG.streamBasePort,
			streamCount: state.streamCount,
			rooms: state.roomStreams,
			ensureRoom: state.ensureRoomStreams,
			log: state.streamLog,
		});
		if (handle !== null) {
			console.warn(
				`[cardtable] streamed Forge LIVE — ${state.streamCount} static container(s) at /stream/**${state.roomStreams === null ? '' : ', plus room-keyed streams at /stream/<room>/<seat>/'} (see stream/index.ts)`,
			);
		}
		const streams = state.roomStreams;
		if (streams !== null) {
			void streams.sweepOrphans();
			setInterval(() => void streams.sweep(), STREAM_SWEEP_MS).unref();
		}
	},
};
