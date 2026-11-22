/**
 * Cardtable's own wiring for the shell's generic usage counter (`@hadoku/ui-shell/usage`): the URL
 * to post to and how an address names a screen, a room's table counted apart from its room.
 */
import { USAGE_BATCH_MAX, USAGE_PATH } from '@hadoku/platform-wire/telemetry';
import { startUsage as startUsageShell, targetName, type UsageAddress, type UsageDeps as ShellUsageDeps } from '@hadoku/ui-shell/usage';

import { apiUrl, appBase } from './http.ts';
import { locationRoute } from './screens/route.ts';

export { targetName };

/**
 * The screen an address shows, by its route's kind; a room's table is its own screen, and a table's
 * full-screen step (`room/table/<step>`) its own again.
 */
export function screenOf(address: UsageAddress, base: string = appBase()): string {
  const route = locationRoute(address, base);
  if (route.kind !== 'room' || route.tableId === undefined) return route.kind;
  return route.step === undefined ? 'room/table' : `room/table/${route.step}`;
}

export function startUsage(deps: Partial<ShellUsageDeps> = {}): () => void {
  return startUsageShell({ url: apiUrl(USAGE_PATH), screenOf: (address) => screenOf(address), batchMax: USAGE_BATCH_MAX, ...deps });
}
