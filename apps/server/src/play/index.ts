/**
 * The match server. `attachPlay` is the one call `src/index.ts` makes; see
 * `README.md` for the edit, the HTTP and socket contract, and how to run a
 * real match locally.
 */

export { attachPlay, type PlayDeps, type PlayHandle, type PlayLog } from './socket.js';
export { jvmHostConfig, jvmHostFactory, liveJvmCount, type MatchHostFactory } from './host.js';
