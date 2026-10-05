/*
 * Keep preference traffic on the test's own server, and set the two global
 * overrides an e2e page reads at module-eval time — never a network call,
 * never the app's production path.
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

/**
 * `apps/ui/src/play/live/prefs.ts`'s own `FAST_MODE_DEFAULT_GLOBAL`, copied
 * rather than imported: that module's type imports reach `../Board.tsx`
 * (`BoardLayout`), and this package's `tsconfig.json` sets no `--jsx` —
 * `e2e/play.spec.ts` and `e2e/isolation.ts` import OTHER pure-logic modules
 * from `apps/ui/src` directly (no `.tsx` in their own graph), which is the
 * precedent this file would otherwise follow; `prefs.ts` is the one module
 * in that directory a `.ts`-only importer cannot reach. If the two ever
 * disagree, `prefs.test.ts` pins the real string.
 */
const FAST_MODE_DEFAULT_GLOBAL = '__CARDTABLE_FAST_MODE_DEFAULT__';

export async function keepPrefsLocal(context: BrowserContext, origin: string): Promise<void> {
  await context.addInitScript(
    (base: string) => {
      (globalThis as Record<string, unknown>).__HADOKU_PREFS_API_BASE__ = base;
    },
    `${origin}/prefs`
  );
}

/**
 * Wave 47, "e2e runs in Fast Mode": every play e2e seat defaults to Fast
 * Mode ON (frames apply the instant they arrive — see `pace.ts`'s own
 * module header on why), through the SAME init-script seam `keepPrefsLocal`
 * already uses above, rather than the harness's own (nonexistent) prefs
 * server: there is no real prefs API behind `${origin}/prefs` in this
 * harness (`keepPrefsLocal`'s whole job is keeping that traffic from
 * leaving 127.0.0.1, not answering it), so a read through it would 404
 * silently and tell the pacer nothing — a global the bundle reads once, at
 * module-eval time, before any component mounts, is the seam that actually
 * works. `e2e/w47-pace.spec.ts` — the one spec that tests pacing — turns
 * Fast Mode back OFF for the seat it measures, through the real settings
 * checkbox, which is a stronger proof than skipping this call for it.
 */
export async function setPlayFastModeDefault(context: BrowserContext, fast: boolean): Promise<void> {
  await context.addInitScript(
    ({ key, value }: { key: string; value: boolean }) => {
      (globalThis as Record<string, unknown>)[key] = value;
    },
    { key: FAST_MODE_DEFAULT_GLOBAL, value: fast },
  );
}
