/*
 * Keep preference traffic on the test's own server.
 *
 * `@wolffm/themes` builds its prefs client from `__HADOKU_PREFS_API_BASE__`
 * and falls back to the SDK's hardcoded `https://hadoku.me/prefs` when that
 * global is unset — so whoami and every preference read leave the machine.
 * Harmless until something mounted a component that reads preferences: when
 * RoomChrome landed (8d71303) both browsers in the draft spec started calling
 * `https://hadoku.me/session/whoami`, and the off-host guard caught it.
 *
 * The global is the package's own documented seam for exactly this, so the
 * override belongs in the harness rather than in the app's production path.
 */
import type { BrowserContext } from '@playwright/test';

export async function keepPrefsLocal(context: BrowserContext, origin: string): Promise<void> {
  await context.addInitScript(
    (base: string) => {
      (globalThis as Record<string, unknown>).__HADOKU_PREFS_API_BASE__ = base;
    },
    `${origin}/prefs`
  );
}
