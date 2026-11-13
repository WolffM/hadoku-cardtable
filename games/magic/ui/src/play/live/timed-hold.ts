/*
 * A hold through Forge's silence: the screen keeps drawing what it last had for a moment after a
 * press, and never longer than {@link HOLD_MAX_MS}. The bar's (`./bar-hold.ts`) and the board
 * offer's (`./offer-hold.ts`) are the two.
 *
 * Both are timed on one {@link HoldClock}: wall time, unless something standing in for Forge times
 * the silence itself (`./replay-server.ts`, whose replay never answers a press).
 */

/** The longest a client-side hold may stand. */
export const HOLD_MAX_MS = 2_000;

/** When a hold was taken ({@link holdNow}). */
export interface TimedHold {
  readonly since: number;
}

/** What a hold is timed on: when it is taken and measured, and its lapse. */
export interface HoldClock {
  now(): number;
  /** Runs `run` once `ms` have passed on this clock. */
  after(ms: number, run: () => void): void;
}

const WALL_CLOCK: HoldClock = {
  now: () => Date.now(),
  after: (ms, run) => {
    setTimeout(run, ms);
  },
};

let clock = WALL_CLOCK;

/** From now on every hold is taken, measured and lapsed on `next`; `null` goes back to wall time. */
export function setHoldClock(next: HoldClock | null): void {
  clock = next ?? WALL_CLOCK;
}

/** Now, on the hold clock: what a hold's `since` is taken from and what it is measured against. */
export function holdNow(): number {
  return clock.now();
}

/** Whether `hold` still stands at `now`. */
export function holdStands<H extends TimedHold>(hold: H | null, now: number): hold is H {
  return hold !== null && now - hold.since < HOLD_MAX_MS;
}

/** Runs `lapse` once the hold's time is up, unless `current()` is no longer `hold` by then. */
export function lapseHold<H extends TimedHold>(hold: H, current: () => H | null, lapse: () => void): void {
  clock.after(HOLD_MAX_MS, () => {
    if (current() === hold) lapse();
  });
}
