/**
 * The match server. `attachPlay` is the one call `src/index.ts` makes; see
 * `README.md` for the edit, the HTTP and socket contract, and how to run a
 * real match locally.
 */

export { attachPlay, type PlayDeps, type PlayHandle, type PlayLog } from './socket.js';
export {
	MAX_CONCURRENT_MATCHES,
	jvmHostConfig,
	jvmHostFactory,
	liveJvmCount,
	type JvmHostFactory,
	type JvmPoolOptions,
	type MatchHostFactory,
} from './host.js';
export { roomFormatNames } from './names.js';
