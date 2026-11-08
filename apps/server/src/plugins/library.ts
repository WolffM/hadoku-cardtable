/** The deck library, and whether this server has a Forge build at all. */
import { CONFIG } from '../config.js';
import { loadTablesLibrary } from '../http/index.js';
import { jvmHostConfig } from '../play/index.js';
import type { CardtablePlugin } from './state.js';

export const libraryPlugin: CardtablePlugin = {
	name: 'library',
	phase: 'stores',
	setup(ctx) {
		const { state } = ctx;
		// Every library deck, read here, and every catalogued era's frozen pool, read AFTER the server
		// listens (`library.warm()`, plugins/listen.ts) or when a request asks for that era first. The
		// pools are 46 MB of JSON parsed and checked synchronously: the slowest step of a boot by far
		// (~2 s on hokon), and on a loaded claw the step a boot sat in for 30 s without listening.
		// Warmed one file per turn of the event loop, so no request waits on more than one era. The
		// lobby (a new room's era, from `formats`) and `attachTables` share this one copy.
		state.library = loadTablesLibrary(state.repoRoot, undefined, { pools: 'later' });
		ctx.bootPhase('library');

		// Read once, before the pools: the draft pool service's own JVM needs the same jar/res config
		// the match JVMs do, and it is wired before `attachRooms` so `checkPlan` has a real
		// `ForgePools` from the start.
		state.forge = jvmHostConfig();
		if (!state.forge.ok) {
			console.warn(`[cardtable] play: no Forge (${state.forge.reason}) — POST /api/play/matches answers 503, and every draft plan is refused until one is`);
		}
		if (CONFIG.newRoomFormat !== undefined && CONFIG.newRoomFormat !== 'newest') {
			throw new Error(`CARDTABLE_NEW_ROOM_FORMAT must be 'newest' or unset, not ${JSON.stringify(CONFIG.newRoomFormat)}`);
		}
	},
};
