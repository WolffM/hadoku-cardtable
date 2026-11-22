/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/relays`'s `attachUsage` (w93-K3).
 * `POST /api/usage`: the browser's usage batches (`packages/game-ui/src/usage.ts`), counted here and posted
 * to telemetry once per window: one `usage` event for everyone (which screens were shown and which
 * controls pressed, how often, by how many people, by tier) and one `usage-user` event per person
 * with their own ordered trail. The tier reported is the edge's (`edgeTierOf`), so a member reads
 * as a member, not as the friend cardtable's gates treat them as. Nothing is answered but 204.
 *
 * Every export and signature below is unchanged from before this moved into the kernel:
 * `index.ts` imports this path exactly as it did. The cardtable-specific bits are
 * `@hadoku/platform-wire/telemetry`'s schema and path, bound here — the kernel itself never imports it.
 */
import type { Router } from 'express';

import { USAGE_PATH, UsageBatchSchema } from '@hadoku/platform-wire/telemetry';
import {
	attachUsage as kernelAttachUsage,
	MAX_BATCHES_PER_MINUTE,
	USAGE_TOP,
	USAGE_TRAIL_MAX,
	USAGE_WINDOW_MS,
	type UsageCounter,
} from '@hadoku/service-kernel/relays';

import { edgeTierOf, userIdOf, userNameOf } from '../edge-auth.js';
import { report as defaultReport, type Report } from '../telemetry.js';

export { MAX_BATCHES_PER_MINUTE, USAGE_TOP, USAGE_TRAIL_MAX, USAGE_WINDOW_MS };
export type { UsageCounter };

export interface UsageDeps {
	report?: Report;
	now?: () => number;
	windowMs?: number;
}

export function attachUsage(api: Router, deps: UsageDeps = {}): UsageCounter {
	return kernelAttachUsage(api, {
		schema: UsageBatchSchema,
		path: USAGE_PATH,
		tierOf: edgeTierOf,
		userIdOf,
		nameOf: userNameOf,
		report: deps.report ?? defaultReport,
		now: deps.now,
		windowMs: deps.windowMs,
	});
}
