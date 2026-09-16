/**
 * SPDX-License-Identifier: MIT
 *
 * Part of `@hadoku/room-ask`, which is MIT — the single carve-out in a repo
 * that is otherwise GPL-3.0-or-later. Written clean-room from the requirement
 * in `docs/requests/P4_ASK_REGISTRY.md` and from nothing else.
 */

/** A scheduled callback that can be called off. Cancelling twice is a no-op. */
export interface AskTimer {
  cancel(): void;
}

/**
 * The registry's entire relationship with time. Both halves are injected
 * together because a deadline needs the two to agree: `now()` decides what
 * `issuedAt`/`deadlineAt` say, `setTimer` decides when the ask actually fires.
 * Splitting them is how a test ends up with a clock at t=5000 and a timer that
 * has not run.
 */
export interface AskClock {
  /** Epoch ms. */
  now(): number;
  /** Fire `fn` once, `delayMs` from now. */
  setTimer(delayMs: number, fn: () => void): AskTimer;
}

/** `Date.now` + `setTimeout`. The default, and the only thing that touches the host runtime. */
export function createSystemClock(): AskClock {
  return {
    now: () => Date.now(),
    setTimer(delayMs, fn) {
      const handle = setTimeout(fn, Math.max(0, delayMs));
      // Node-only: an ask's deadline must not hold the process open by itself.
      (handle as unknown as { unref?: () => void }).unref?.();
      return {
        cancel() {
          clearTimeout(handle);
        },
      };
    },
  };
}

export interface ManualClock extends AskClock {
  /**
   * Move time forward, firing every timer that comes due, each one observing
   * `now()` equal to its own deadline rather than the end of the window.
   * Timers armed from inside a callback are picked up in the same sweep if
   * they fall before `target`.
   */
  advance(ms: number): void;
}

interface ManualTimer {
  readonly seq: number;
  readonly dueAt: number;
  readonly fn: () => void;
}

/**
 * A clock tests drive by hand. Deterministic and sleep-free: nothing here ever
 * consults the real time or yields to the event loop.
 */
export function createManualClock(start = 0): ManualClock {
  let current = start;
  let nextSeq = 0;
  const timers = new Map<number, ManualTimer>();

  return {
    now: () => current,

    setTimer(delayMs, fn) {
      const seq = nextSeq++;
      timers.set(seq, { seq, dueAt: current + Math.max(0, delayMs), fn });
      return {
        cancel() {
          timers.delete(seq);
        },
      };
    },

    advance(ms) {
      const target = current + Math.max(0, ms);
      for (;;) {
        let next: ManualTimer | null = null;
        for (const timer of timers.values()) {
          if (timer.dueAt > target) continue;
          // Ties break on arm order, so a deterministic sequence stays one.
          if (next === null || timer.dueAt < next.dueAt || (timer.dueAt === next.dueAt && timer.seq < next.seq)) {
            next = timer;
          }
        }
        if (next === null) break;
        timers.delete(next.seq);
        current = Math.max(current, next.dueAt);
        next.fn();
      }
      current = target;
    },
  };
}
