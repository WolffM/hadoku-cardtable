/*
 * The clock, injected.
 *
 * Every deadline in this package — the persistence debounce, the service
 * heartbeat, the `lost` transition, the `holdMs` window — is a duration, and a
 * duration measured against `Date.now()` and `globalThis.setTimeout` is a
 * duration a test can only observe by sleeping. `holdMs` is ten minutes. So the
 * clock is a parameter.
 *
 * It is deliberately three methods. Anything richer (intervals, cancellation
 * tokens, a scheduler) would be a second thing to keep correct, and nothing
 * here needs it: an interval is a timer that reschedules itself.
 */

/** A handle returned by `setTimer`. Opaque; only `clearTimer` reads it. */
export type TimerHandle = number;

export interface Clock {
  /** Milliseconds since the epoch, or since the manual clock's start. */
  now(): number;
  /** Run `fn` after `ms`. Never fires synchronously, even for `ms <= 0`. */
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

/**
 * The real clock.
 *
 * Timers are `unref`'d: a pending debounce must never be the reason a process
 * refuses to exit. The whole point of §4.4's flush-on-SIGTERM is that shutdown
 * is driven by the signal handler, not by whatever timers happen to be idle.
 */
export const systemClock: Clock = (() => {
  let next = 0;
  const live = new Map<TimerHandle, ReturnType<typeof setTimeout>>();
  return {
    now: () => Date.now(),
    setTimer(fn: () => void, ms: number): TimerHandle {
      const handle = ++next;
      const t = setTimeout(() => {
        live.delete(handle);
        fn();
      }, Math.max(0, ms));
      (t as { unref?: () => void }).unref?.();
      live.set(handle, t);
      return handle;
    },
    clearTimer(handle: TimerHandle): void {
      const t = live.get(handle);
      if (t === undefined) return;
      clearTimeout(t);
      live.delete(handle);
    },
  };
})();

/**
 * A clock tests drive by hand.
 *
 * `advance` fires every timer that comes due *in order*, moving `now` to each
 * timer's own deadline before running it — so a callback that reads the clock
 * sees the time it was scheduled for, not the end of the jump. A callback that
 * schedules another timer inside the same window is picked up by the loop.
 */
export class ManualClock implements Clock {
  #now: number;
  #seq = 0;
  #timers = new Map<TimerHandle, { at: number; order: number; fn: () => void }>();

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimer(fn: () => void, ms: number): TimerHandle {
    const handle = ++this.#seq;
    this.#timers.set(handle, { at: this.#now + Math.max(0, ms), order: handle, fn });
    return handle;
  }

  clearTimer(handle: TimerHandle): void {
    this.#timers.delete(handle);
  }

  /** How many timers are outstanding. Used to assert "nothing was scheduled". */
  get pending(): number {
    return this.#timers.size;
  }

  /** Move time forward by `ms`, running whatever comes due along the way. */
  advance(ms: number): void {
    const target = this.#now + Math.max(0, ms);
    for (;;) {
      let due: { handle: TimerHandle; at: number; order: number; fn: () => void } | null = null;
      for (const [handle, t] of this.#timers) {
        if (t.at > target) continue;
        if (due === null || t.at < due.at || (t.at === due.at && t.order < due.order)) {
          due = { handle, at: t.at, order: t.order, fn: t.fn };
        }
      }
      if (due === null) {
        this.#now = target;
        return;
      }
      this.#timers.delete(due.handle);
      this.#now = due.at;
      due.fn();
    }
  }
}
