/**
 * The one handshake gate: each of four copies of "sanitize, rank, refuse,
 * report" (HTTP's `requireMinTier`, the room socket, the play socket, the
 * stream's raw upgrade) folded into one verdict (`floor`) and one refusal
 * report. `requireMinTier` keeps its name and export in `edge-auth.ts`, and
 * now calls `floor` too.
 */

import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { edgeProvenance, rankOf, sanitizeHeaders, tierOf } from './edge-auth.js';
import { reportSealRefused } from './telemetry.js';

/** HTTP gates itself via `requireMinTier`, which calls {@link floor} directly. */
export type GateSurface = 'draft-socket' | 'play-socket' | 'stream';

/** `minTier`: `CONFIG.minTier` in production. `surface`: the `reportSealRefused` label. */
export interface GateOptions {
	minTier: string;
	surface: GateSurface;
}

/** Sanitize `headers` in place against edge provenance, then rank the result against `minTier`. */
export function floor(headers: Record<string, unknown>, minTier: string): { ok: boolean; tier: string } {
	sanitizeHeaders(headers);
	const tier = tierOf({ headers } as unknown as Request);
	return { ok: rankOf(tier) >= rankOf(minTier), tier };
}

/** Provenance + the floor on a socket.io handshake. `next(new Error('not found'))` is the client's `connect_error`. */
export function gateSocketIo(io: SocketIOServer, opts: GateOptions): void {
	io.engine.use(edgeProvenance);
	io.use((socket, next) => {
		const result = floor(socket.request.headers as Record<string, unknown>, opts.minTier);
		if (!result.ok) {
			reportSealRefused(opts.surface, socket.request.headers, null);
			next(new Error('not found'));
			return;
		}
		next();
	});
}

/** The floor for a raw upgrade: no middleware chain runs, so the caller answers the refusal itself. */
export function gateUpgrade(req: IncomingMessage, opts: GateOptions): { ok: boolean; tier: string } {
	const result = floor(req.headers as Record<string, unknown>, opts.minTier);
	if (!result.ok) reportSealRefused(opts.surface, req.headers, req.url ?? null);
	return result;
}
