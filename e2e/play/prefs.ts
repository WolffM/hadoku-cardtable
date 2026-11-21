/**
 * The header-settings preference toggles a spec drives (T6): one copy, used
 * by every spec that needs to flip a setting and PROVE it took, rather than
 * each copying the same click-and-confirm.
 */

import { expect, type Page } from '@playwright/test';

import { serverLog } from './board.ts';
import { closeSettings, openSettings } from './w32.ts';

export type GameSpeed = 'normal' | 'fast' | 'instant';

/**
 * Set Game speed through the Gameplay tab's radios, as a player does, and see the press take. A controlled
 * radio is clicked, never `check()`ed (React redraws it from the saved preference).
 */
export async function setGameSpeed(page: Page, speed: GameSpeed): Promise<void> {
  const radio = (await openSettings(page)).getByTestId(`live-settings-speed-${speed}`);
  await radio.click();
  await expect(radio, `Game speed ${speed} took`).toBeChecked();
  await closeSettings(page);
}

/**
 * Game speed is Instant by default inside the e2e harness (`prefs.ts`'s override, wave 47's Fast Mode); a
 * spec that needs the pacer's own chain sets it to Normal — and PROVES it: Instant read on, the press took,
 * and the server logged this seat's `info` row with `fastMode: false` (the client telemetry every settings
 * change writes; `fastMode` is still Instant's name there).
 */
export async function turnFastModeOff(page: Page, stack: { serverLogFile: string }, seat: number): Promise<void> {
  await expect((await openSettings(page)).getByTestId('live-settings-speed-instant'), `seat ${seat}: Instant before the press (the harness default)`).toBeChecked();
  await setGameSpeed(page, 'normal');
  await expect
    .poll(() => serverLog(stack).some((r) => r.evt === 'client' && r.kind === 'info' && r.seat === seat && r.fastMode === false), {
      timeout: 10_000,
      message: `seat ${seat}: the server logged Fast Mode off`,
    })
    .toBe(true);
}
