/**
 * The header-settings preference toggles a spec drives (T6): one copy, used
 * by every spec that needs to flip a setting and PROVE it took, rather than
 * each copying the same click-and-confirm.
 */

import { expect, type Page } from '@playwright/test';

import { serverLog } from './board.ts';
import { closeHeaderSettings, openHeaderSettings } from './w32.ts';

/**
 * Fast Mode is ON by default inside the e2e harness (`prefs.ts`'s override); a spec that needs
 * the pacer's own chain turns it off — and PROVES it: the checkbox read on, the click took, and
 * the server logged this seat's `info` row with `fastMode: false` (the client telemetry every
 * settings change writes). The server-confirmed form (`w59-stack.spec.ts`'s own, T6) — a spec that
 * only needs the checkbox unchecked, with no server round trip to wait on, still does that itself.
 */
export async function turnFastModeOff(page: Page, stack: { serverLogFile: string }, seat: number): Promise<void> {
  const toggle = (await openHeaderSettings(page)).locator('[data-testid="live-settings-fast-mode"]');
  await expect(toggle, `seat ${seat}: the Fast Mode box reads ON before the click (the harness default)`).toBeChecked();
  await toggle.click();
  await expect(toggle, `seat ${seat}: the click took`).not.toBeChecked();
  await closeHeaderSettings(page);
  await expect
    .poll(() => serverLog(stack).some((r) => r.evt === 'client' && r.kind === 'info' && r.seat === seat && r.fastMode === false), {
      timeout: 10_000,
      message: `seat ${seat}: the server logged Fast Mode off`,
    })
    .toBe(true);
}
