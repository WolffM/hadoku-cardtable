/**
 * The relay runtime's socket route. Thin by design — the logic lives in
 * `play/relay-socket.ts`, which this file only wires to the running
 * server's own `io`. No relay match exists yet, so `rosterOf` refuses every
 * join: nothing a player can see changes. Giving it a real roster is the
 * one line left once something builds a relay match.
 */
import { CONFIG } from '../config.js';
import { attachRelay } from '../play/relay-socket.js';
import type { CardtablePlugin } from './state.js';

export const relayPlugin: CardtablePlugin = {
	name: 'relay',
	phase: 'sockets',
	setup(ctx) {
		const relay = attachRelay(ctx.io, {
			minTier: CONFIG.minTier,
			rosterOf: () => undefined,
		});
		return {
			shutdown: () => {
				relay.close();
			},
		};
	},
};
