/**
 * cardtable's binding of `@hadoku/service-kernel`'s auth and gate: the env prefix and the one
 * `createEdgeAuth`/`createGate` pair that `edge-auth.ts` and `gate.ts` share, built from `CONFIG`.
 */
import type { SealRefusedReporter } from '@hadoku/service-kernel/http';
import { createGameAuth } from './auth.js';
import { CONFIG } from './config.js';
import { reportSealRefused } from './telemetry.js';

/** `assertFloor`'s env prefix (`edge-auth.ts`) — hadoku_site's wrapper sets `CARDTABLE_MIN_TIER`. */
export const ENV_PREFIX = 'CARDTABLE';

const auth = createGameAuth(CONFIG, {
	// `reportSealRefused`'s own surface type is cardtable's closed set (`telemetry.ts`); the
	// kernel's is an open `string` so it knows no game's surface names. Every surface this gate
	// ever reports is in that set.
	reportSealRefused: reportSealRefused as SealRefusedReporter,
});

export const edgeAuth = auth.edgeAuth;
export const gate = auth.gate;
