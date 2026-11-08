/**
 * The one handshake gate — cardtable's binding of the platform kernel
 * (`@hadoku/service-kernel/http`): each of three copies of "sanitize, rank,
 * refuse, report" (the room socket, the play socket, the stream's raw
 * upgrade) folded into one verdict (`floor`) and one refusal report.
 * HTTP's own copy is `requireMinTier`, bound in `edge-auth.ts` — both files
 * bind the one shared `createGate` instance in `kernel.ts` (w93-Z).
 */

import { gate } from './kernel.js';

/** HTTP gates itself via `requireMinTier` (`edge-auth.ts`), which calls {@link floor} directly. */
export type GateSurface = 'draft-socket' | 'play-socket' | 'stream';

/** `minTier`: `CONFIG.minTier` in production. `surface`: the `reportSealRefused` label. */
export interface GateOptions {
	minTier: string;
	surface: GateSurface;
}

/** Sanitize `headers` in place against edge provenance, then rank the result against `minTier`. */
export const floor = gate.floor;

/** Provenance + the floor on a socket.io handshake. `next(new Error('not found'))` is the client's `connect_error`. */
export const gateSocketIo = gate.gateSocketIo;

/** The floor for a raw upgrade: no middleware chain runs, so the caller answers the refusal itself. */
export const gateUpgrade = gate.gateUpgrade;
