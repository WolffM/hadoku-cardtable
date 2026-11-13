/*
 * The control bar's one invariant: if the latest window the server sent this seat has an
 * enabled button, this seat can press something.
 *
 * A dead bar (prod m-3bc0ad1f5ac1, m-d87aabc2c3e2, 2026-10-11 — the operator: "how can we
 * prevent this from happening once and for all?") is a seat whose game is waiting on it with
 * nothing on its screen to press. The client may still hold a live bar back for a moment — a
 * press it has just sent must not be pressed twice — but only through {@link pressableBar},
 * with a reason, and never for longer than `HOLD_MAX_MS` (`./timed-hold.ts`): past that the server's own
 * bar is what is drawn. {@link barStuck} is the check that the rest of the screen kept the
 * promise, and what `LiveBoard` reports as `bar-stuck` when it did not.
 */

import type { LiveButtons } from './match.ts';
import { holdStands, type TimedHold } from './timed-hold.ts';

/** How long the screen may offer nothing to press under a live server window before it is reported. */
export const BAR_STUCK_MS = 2_000;

/** A client-side hold on the bar, and why. */
export interface BarHold extends TimedHold {
  readonly reason: string;
}

/** The bar this seat may press at `now`: the server's, with both buttons off while a hold stands. */
export function pressableBar(bar: LiveButtons | null, hold: BarHold | null, now: number): LiveButtons | null {
  if (bar === null || !holdStands(hold, now)) return bar;
  return { ...bar, enable1: false, enable2: false };
}

/**
 * Every surface that can take this seat's input, by name: `true` when it is drawn and
 * pressable. The control box's End Turn, the decision pop-up's two, and every pop-up or
 * board mode that owns the input while it is open (an ask, a payment, a selection, the
 * yes/no, the coin toss's Play/Draw, the mulligan pick, declaring combat on the board).
 */
export type BarSurfaces = Readonly<Record<string, boolean>>;

/**
 * The seat is stuck: the server's latest bar has an enabled button and no surface takes
 * input. `yielding` (Forge's "Yielding until end of turn", whose Cancel the operator chose
 * not to draw) is the one live bar that is meant to have nothing to press.
 */
export function barStuck(serverBar: LiveButtons | null, yielding: boolean, surfaces: BarSurfaces): boolean {
  if (serverBar === null || yielding || !(serverBar.enable1 || serverBar.enable2)) return false;
  return !Object.values(surfaces).some(Boolean);
}
