/**
 * A game's edge auth and tier gate, built from its own config: the one pair every game server
 * needs (provenance on every request and socket handshake, the floor below `/health`), so no game
 * wires `createEdgeAuth`/`createGate` by hand. Cardtable's own binding (`kernel.ts`) is this,
 * over its `CONFIG`.
 */

import { createEdgeAuth, rankOf, tierOf, type EdgeAuth } from '@hadoku/service-kernel/auth';
import { createGate, type Gate, type SealRefusedReporter } from '@hadoku/service-kernel/http';

import type { GameServerConfig } from './config.js';

export interface GameAuth {
	edgeAuth: EdgeAuth;
	/** The gate at the game's own floor: the HTTP floor, and every socket's handshake. */
	gate: Gate;
}

export interface GameAuthOptions {
	/** Told of every request or handshake the seal refused. Default: logged under `svc`. */
	reportSealRefused?: SealRefusedReporter;
	/** The log's `svc` for the default reporter. */
	svc?: string;
}

type AuthConfig = Pick<GameServerConfig, 'edgeAuthSecret' | 'allowUnverifiedEdge' | 'devTier' | 'minTier'>;

/** Read lazily: a config built on first access (`lazyConfig`) is not forced by building this. */
export function createGameAuth(config: AuthConfig, options: GameAuthOptions = {}): GameAuth {
	const edgeAuth = createEdgeAuth({
		edgeAuthSecret: () => config.edgeAuthSecret,
		allowUnverifiedEdge: () => config.allowUnverifiedEdge,
		devTier: () => config.devTier,
	});
	const svc = options.svc ?? 'game-server';
	const report: SealRefusedReporter =
		options.reportSealRefused ??
		((surface, headers, path) => {
			const tier = headers['x-hadoku-tier'];
			console.log(JSON.stringify({ t: new Date().toISOString(), svc, evt: 'seal-refused', surface, tier: typeof tier === 'string' ? tier : 'public', path }));
		});
	const gate = createGate({
		sanitizeHeaders: edgeAuth.sanitizeHeaders,
		edgeProvenance: edgeAuth.edgeProvenance,
		tierOf,
		rankOf,
		reportSealRefused: report,
		minTier: () => config.minTier,
	});
	return { edgeAuth, gate };
}
