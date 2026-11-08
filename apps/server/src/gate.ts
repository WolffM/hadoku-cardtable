/**
 * The one handshake gate — cardtable's binding of the platform kernel
 * (`@hadoku/service-kernel/http`): each of three copies of "sanitize, rank,
 * refuse, report" (the room socket, the play socket, the stream's raw
 * upgrade) folded into one verdict (`floor`) and one refusal report.
 * HTTP's own copy is `requireMinTier`, bound in `edge-auth.ts` from the same
 * kernel function — it keeps its name and export there.
 */

import { createEdgeAuth, rankOf, tierOf } from '@hadoku/service-kernel/auth';
import { createGate, type SealRefusedReporter } from '@hadoku/service-kernel/http';
import { CONFIG } from './config.js';
import { reportSealRefused } from './telemetry.js';

/** HTTP gates itself via `requireMinTier` (`edge-auth.ts`), which calls {@link floor} directly. */
export type GateSurface = 'draft-socket' | 'play-socket' | 'stream';

/** `minTier`: `CONFIG.minTier` in production. `surface`: the `reportSealRefused` label. */
export interface GateOptions {
	minTier: string;
	surface: GateSurface;
}

const edgeAuth = createEdgeAuth({
	edgeAuthSecret: () => CONFIG.edgeAuthSecret,
	allowUnverifiedEdge: () => CONFIG.allowUnverifiedEdge,
	devTier: () => CONFIG.devTier,
});

const gate = createGate({
	sanitizeHeaders: edgeAuth.sanitizeHeaders,
	edgeProvenance: edgeAuth.edgeProvenance,
	tierOf,
	rankOf,
	// `reportSealRefused`'s own surface type is cardtable's closed set
	// (`telemetry.ts`); the kernel's is an open `string` so it knows no game's
	// surface names. Every surface this gate ever reports is in that set.
	reportSealRefused: reportSealRefused as SealRefusedReporter,
	minTier: () => CONFIG.minTier,
});

/** Sanitize `headers` in place against edge provenance, then rank the result against `minTier`. */
export const floor = gate.floor;

/** Provenance + the floor on a socket.io handshake. `next(new Error('not found'))` is the client's `connect_error`. */
export const gateSocketIo = gate.gateSocketIo;

/** The floor for a raw upgrade: no middleware chain runs, so the caller answers the refusal itself. */
export const gateUpgrade = gate.gateUpgrade;
