/**
 * Cardtable's own chat namespace (`room/chat.ts`), mounted on the same `io`
 * the draft socket and the room feed already use. `sockets` phase, after
 * `rooms` (`stores`): `state.lobby` must exist before `admit` can read it.
 *
 * Nothing here is shared on `state` — chat's `admit` is a one-shot check per
 * `join`/`chat_send`, so nothing else in this process needs to reach the
 * served instance. If that changes, add the field to `plugins/state.ts` then.
 */
import { join } from 'node:path';
import { CONFIG } from '../config.js';
import { attachRoomChat } from '../room/chat.js';
import { jsonLogger } from '@hadoku/service-kernel/log';
import type { CardtablePlugin } from './state.js';

const logChat = jsonLogger('cardtable-chat');

export const chatPlugin: CardtablePlugin = {
	name: 'chat',
	phase: 'sockets',
	async setup(ctx) {
		const { io, state } = ctx;
		await attachRoomChat(io, {
			lobby: state.lobby,
			minTier: CONFIG.minTier,
			stateDir: () => join(CONFIG.dataDir, 'chat'),
			onEvent: (level, event, fields) => logChat({ evt: event, level, ...fields }),
		});
		ctx.bootPhase('chat');
	},
};
