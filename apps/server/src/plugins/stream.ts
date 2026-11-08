/**
 * Streamed Forge: noVNC's pages through the containers (the HTTP half, above the SPA fallback),
 * and its RFB socket (the upgrade half). Inert unless ~/.local/share/cardtable/stream/STREAMS
 * names containers; stream/index.ts has the gate and the interim limits.
 */
import { jsonLogger } from '@hadoku/service-kernel/log';
import { CONFIG } from '../config.js';
import { attachStream, attachStreamRoutes, streamLayout } from '../stream/index.js';
import { createRoomStreams, findContainerScript, scriptRunner, MAX_ROOM_SEATS } from '../stream/alloc.js';
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
		state.roomStreams =
			script === null
				? null
				: createRoomStreams({
						// A lobby room or a draft pod: can anyone still reach this room?
						roomExists: (roomKey) => state.lobby.get(roomKey) !== undefined || state.draftRooms?.find(roomKey) !== undefined,
						script: scriptRunner(script),
						log: state.streamLog,
					});

		/** Seats to provision for a room, or null for one that wants none: `clientMode` is the room's own, fixed at create (D19). */
		const streamedSeats = (roomKey: string): number | null => {
			const room = state.lobby.get(roomKey);
			if (room === undefined || room.clientMode !== 'streamed') return null;
			const seats = room.gameType === 'draft' ? (state.draftRooms?.params.seatCount ?? MAX_ROOM_SEATS) : 2;
			return Math.min(seats, MAX_ROOM_SEATS);
		};
		// Fire-and-forget: a cold container is ~18 s to a usable window, so the request is answered
		// "not up yet" rather than held. `allocate` is idempotent, so a reloading browser stacks nothing.
		state.ensureRoomStreams = (roomKey) => {
			const streams = state.roomStreams;
			if (streams === null || streams.find(roomKey) !== undefined) return;
			const seats = streamedSeats(roomKey);
			if (seats === null) return;
			void streams.allocate(roomKey, seats).then((result) => {
				if (!result.ok) state.streamLog({ evt: 'stream-allocate-refused', room: roomKey, reason: result.reason, detail: result.detail });
			});
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
