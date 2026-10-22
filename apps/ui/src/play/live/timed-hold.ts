/*
 * A hold through Forge's silence: the screen keeps drawing what it last had for a moment after a
 * press, and never longer than {@link HOLD_MAX_MS}. The bar's (`./bar-hold.ts`) and the board
 * offer's (`./offer-hold.ts`) are the two.
 */

/** The longest a client-side hold may stand. */
export const HOLD_MAX_MS = 2_000;

/** When a hold was taken (`Date.now()`). */
export interface TimedHold {
  readonly since: number;
}

/** Whether `hold` still stands at `now`. */
export function holdStands<H extends TimedHold>(hold: H | null, now: number): hold is H {
  return hold !== null && now - hold.since < HOLD_MAX_MS;
}

/** Runs `lapse` once the hold's time is up, unless `current()` is no longer `hold` by then. */
export function lapseHold<H extends TimedHold>(hold: H, current: () => H | null, lapse: () => void): void {
  setTimeout(() => {
    if (current() === hold) lapse();
  }, HOLD_MAX_MS);
}
