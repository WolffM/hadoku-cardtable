/**
 * Cardtable's frame-rate tally (`@hadoku/service-kernel/relays`'s `framesTally`): one for the whole
 * server, fed every `perf` line as it is logged — a match's over its socket (`play/socket.ts`), a
 * page's over `POST /api/client-events` (`http/client-events.ts`) — and posted as one `frames` event
 * every 5 minutes, which the daily report reads (`packages/devkit/src/telemetry/watch.ts`).
 */
import { framesTally } from '@hadoku/service-kernel/relays';

import { report } from './telemetry.js';

export const frames = framesTally({ report });
