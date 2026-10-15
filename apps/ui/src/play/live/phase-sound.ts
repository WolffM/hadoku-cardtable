/*
 * The phase sound plays for a phase the game stops in, never for one it passes through.
 *
 * The operator, 2026-10-15: "can we make it so skipped phases dont trigger the 'next phase' sound? i notice i
 * hear it through every combat phase which is annoying." Telemetry for that game: five `g.phase` a seat, 160 ms
 * apart, every combat nobody attacked in. Forge sends each step as its own frame and the server auto-passes the
 * step's priority window, so a skipped step looks exactly like a real one when it arrives; what tells them apart
 * is whether the step HOLDS. So a new phase's sound waits: it plays the moment a window opens in that phase for
 * either seat (`hold`), or once the phase has stayed current for {@link PHASE_SETTLE_MS}; a newer phase before
 * either replaces it, and the passed-through one never sounds.
 *
 * A window counts only if it opened in this phase: a bar or the other seat's report from the phase before can
 * still read as open for a beat after the step changes (the server tells the other seat 150 ms late), so the
 * windows already open when the phase began are remembered by identity and never count as its hold.
 */

import type { DelayedSoundEvent } from '../../sound/index.ts';

/** Longer than any step Forge passes straight through (160 ms measured), shorter than a stop anyone waits on. */
export const PHASE_SETTLE_MS = 700;

export interface PhaseSoundGate {
  /** A view entered a new phase, with these windows already open: its sound waits for the phase to hold. Replaces a phase still waiting. */
  enter(key: string, event: DelayedSoundEvent, open: readonly object[]): void;
  /** The windows open now: one that was not open when the phase began plays its sound, if still waiting. */
  hold(open: readonly object[]): void;
  /** Drop whatever is waiting (End Turn, the board going away). */
  drop(): void;
}

export function phaseSoundGate(
  play: (event: DelayedSoundEvent, key: string, how: 'held' | 'settled') => void,
  schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): PhaseSoundGate {
  let waiting: { key: string; event: DelayedSoundEvent; timer: unknown; before: ReadonlySet<object> } | null = null;
  const fire = (how: 'held' | 'settled'): void => {
    if (waiting === null) return;
    const { key, event, timer } = waiting;
    waiting = null;
    cancel(timer);
    play(event, key, how);
  };
  return {
    enter(key, event, open) {
      if (waiting !== null) cancel(waiting.timer);
      waiting = { key, event, timer: schedule(() => fire('settled'), PHASE_SETTLE_MS), before: new Set(open) };
    },
    hold(open) {
      if (waiting !== null && open.some((window) => !waiting!.before.has(window))) fire('held');
    },
    drop() {
      if (waiting !== null) cancel(waiting.timer);
      waiting = null;
    },
  };
}
