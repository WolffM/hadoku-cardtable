/**
 * Adapter: cardtable's binding of `@hadoku/service-kernel/relays`'s `attachClientEvents`
 * (w93-K3). `POST /api/client-events`: client telemetry from a screen with no match
 * (`@hadoku/platform-wire/telemetry`'s `PageEventSchema`). A match's screen sends its telemetry over the match
 * socket and it lands in the play log (`play/socket.ts`, `forge:client`); a page outside a match
 * has no such socket, so it sends the same flat facts here, and they land in the same stdout log
 * as `client` events, under `svc: 'cardtable-client'`, keyed by page and user. Nothing is stored
 * and nothing is answered but 204.
 *
 * Every export and signature below is unchanged from before this moved into the kernel:
 * `index.ts` and `play/socket.ts` import this path exactly as they did. The cardtable-specific
 * bits are `@hadoku/platform-wire/telemetry`'s schema, path and per-second cap, bound here — the kernel itself
 * never imports it.
 *
 * Read them with `grep -a '"svc":"cardtable-client"' ~/.pm2/logs/cardtable-ppe-out.log` (PPE) or
 * `cardtable-out.log` (production).
 */
import type { Router } from 'express';

import { CLIENT_EVENT_MAX_PER_SECOND, PAGE_EVENT_PATH, PageEventSchema } from '@hadoku/platform-wire/telemetry';
import { attachClientEvents as kernelAttachClientEvents } from '@hadoku/service-kernel/relays';

import { userIdOf } from '../edge-auth.js';
import { jsonLogger, type JsonLog } from '@hadoku/service-kernel/log';

export { malformedFacts } from '@hadoku/service-kernel/relays';

export interface ClientEventsDeps {
	log?: JsonLog;
	now?: () => number;
}

export function attachClientEvents(api: Router, deps: ClientEventsDeps = {}): void {
	kernelAttachClientEvents(api, {
		schema: PageEventSchema,
		path: PAGE_EVENT_PATH,
		maxPerSecond: CLIENT_EVENT_MAX_PER_SECOND,
		userIdOf,
		log: deps.log ?? jsonLogger('cardtable-client'),
		now: deps.now,
	});
}
