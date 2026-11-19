/**
 * Cardtable's rooms, served here (`@hadoku/game-server/room/serve`, moved there from
 * `room/serve.ts` in wave 119 §S): the chrome's room socket, on the same `io` the draft socket and
 * the room feed use. `sockets` phase: it reads `state.lobby` and the one tracker (`rooms`,
 * `stores` phase), `state.people` (`routes` phase) and `state.play` (`play`, before it).
 */
import { join } from 'node:path';
import { CONFIG } from '@hadoku/game-server/config';
import { attachServedRoom } from '@hadoku/game-server/room/serve';
import { ROOM_ID_RE } from '@hadoku/shared';
import { jsonLogger } from '@hadoku/service-kernel/log';
import type { CardtablePlugin } from './state.js';

const logRoom = jsonLogger('cardtable-room');

export const roomPlugin: CardtablePlugin = {
	name: 'room',
	phase: 'sockets',
	async setup(ctx) {
		const { io, state } = ctx;
		state.servedRoom = await attachServedRoom(io, {
			lobby: state.lobby,
			presence: state.seatPresence,
			people: state.people,
			isMatch: (id) => state.play?.matches.find(id) !== undefined,
			minTier: CONFIG.minTier,
			stateDir: () => join(CONFIG.dataDir, 'chat'),
			appId: 'cardtable',
			roomIdRe: ROOM_ID_RE,
			onEvent: (level, event, fields) => logRoom({ evt: event, level, ...fields }),
			// Who a room's spectator row names moved (`roomBody`'s `here`): its open screens read it again.
			onRoster: (roomId) => state.roomFeed.changed(roomId),
		});
		ctx.bootPhase('room');
	},
};
