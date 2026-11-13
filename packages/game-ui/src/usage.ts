/**
 * Cardtable's own wiring for the shell's generic usage counter (`@hadoku/ui-shell/usage`): the URL
 * to post to and how a route hash names a screen, a room's table counted apart from its room.
 */
import { USAGE_BATCH_MAX, USAGE_PATH } from '@hadoku/platform-wire/telemetry';
import { startUsage as startUsageShell, targetName, type UsageDeps as ShellUsageDeps } from '@hadoku/ui-shell/usage';

import { apiUrl } from './http.ts';
import { parseRoute } from './screens/route.ts';

export { targetName };

/** The screen a hash shows, by its route's kind; a room's table is its own screen. */
export function screenOf(hash: string): string {
  const route = parseRoute(hash);
  return route.kind === 'room' && route.tableId !== undefined ? 'room/table' : route.kind;
}

export function startUsage(deps: Partial<ShellUsageDeps> = {}): () => void {
  return startUsageShell({ url: apiUrl(USAGE_PATH), screenOf, batchMax: USAGE_BATCH_MAX, ...deps });
}
