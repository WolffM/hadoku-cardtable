/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/relays`'s `attachUsage` (w93-K3).
 * `POST /api/usage`: the browser's usage batches (`apps/ui/src/usage.ts`), counted here and posted
 * to telemetry as one `usage` event per window — which screens were shown and which controls
 * pressed, how often, by how many people, by tier. Nothing per click is kept, and nothing is
 * answered but 204.
 *
 * Every export and signature below is unchanged from before this moved into the kernel:
 * `index.ts` imports this path exactly as it did. The cardtable-specific bits are `@hadoku/shared`'s
 * schema and path, bound here — the kernel itself never imports `@hadoku/shared`.
 */
import type { Router } from 'express';

import { USAGE_PATH, UsageBatchSchema } from '@hadoku/shared';
import {
	attachUsage as kernelAttachUsage,
	MAX_BATCHES_PER_MINUTE,
	USAGE_TOP,
	USAGE_WINDOW_MS,
	type UsageCounter,
} from '@hadoku/service-kernel/relays';

import { tierOf, userIdOf } from '../edge-auth.js';
import { report as defaultReport, type Report } from '../telemetry.js';

export { MAX_BATCHES_PER_MINUTE, USAGE_TOP, USAGE_WINDOW_MS };
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
		tierOf,
		userIdOf,
		report: deps.report ?? defaultReport,
		now: deps.now,
		windowMs: deps.windowMs,
	});
}
