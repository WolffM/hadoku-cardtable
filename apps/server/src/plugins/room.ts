/**
 * Cardtable's rooms, served here (`room/serve.ts`): the chrome's room socket, on the same `io` the
 * draft socket and the room feed use. `sockets` phase: it reads `state.lobby` and the one tracker
 * (`rooms`, `stores` phase), `state.people` (`routes` phase) and `state.play` (`play`, before it).
 */
import { join } from 'node:path';
import { CONFIG } from '../config.js';
import { attachServedRoom } from '../room/serve.js';
import { jsonLogger } from '@hadoku/service-kernel/log';
import type { CardtablePlugin } from './state.js';

const logRoom = jsonLogger('cardtable-room');

export const roomPlugin: CardtablePlugin = {
	name: 'room',
	phase: 'sockets',
	async setup(ctx) {
		const { io, state } = ctx;
		await attachServedRoom(io, {
			lobby: state.lobby,
			presence: state.seatPresence,
			people: state.people,
			isMatch: (id) => state.play?.matches.find(id) !== undefined,
			minTier: CONFIG.minTier,
			stateDir: () => join(CONFIG.dataDir, 'chat'),
			onEvent: (level, event, fields) => logRoom({ evt: event, level, ...fields }),
		});
		ctx.bootPhase('room');
	},
};
