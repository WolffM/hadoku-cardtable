/**
 * Where a slow stretch's time went, in any browser (the operator, 2026-10-23: "just telemetry is fine
 * actually as long as its comprehensive"). Chrome attributes a long frame itself (`frame-watch.ts`'s
 * `loaf`); Firefox and Safari attribute nothing, so every stretch the operator's own Firefox reported
 * read `attribution: none`. Our own hot paths add their time here, by label, and `frame-watch.ts` reports
 * what each spent inside a stretch — whatever the stretch spent beyond them was the browser's: style,
 * layout, paint and compositing.
 *
 * - `forge`: a frame from the server, applied to the match (`match.ts`'s `ingest`).
 * - `board`: the board's render, from its function to its layout effects (`Board.tsx`), `effects` included.
 * - `effects`: what a new view draws — hits, rams, departures (`numbers.ts`'s `notify`).
 * - `gestures`: the gesture layer's paint — the attack and block arrows, the marks (`gestures/install.ts`).
 *
 * Two clock reads per timed call and a map write: nothing that is itself worth timing.
 */

export type WorkLabel = 'forge' | 'board' | 'effects' | 'gestures';

const spent = new Map<WorkLabel, number>();
/** A label already being timed: a call inside it (an `ingest` replaying its buffer) is counted once. */
const running = new Set<WorkLabel>();

/** The milliseconds each label has spent since the page loaded. */
export function workSpent(): ReadonlyMap<WorkLabel, number> {
  return spent;
}

/** Add `ms` to `label`, for work timed by its own clock reads (a render from its function to its effects). */
export function addWork(label: WorkLabel, ms: number): void {
  if (ms > 0) spent.set(label, (spent.get(label) ?? 0) + ms);
}

/** Run `fn`, adding its time to `label`. */
export function timed<T>(label: WorkLabel, fn: () => T): T {
  if (running.has(label)) return fn();
  running.add(label);
  const began = performance.now();
  try {
    return fn();
  } finally {
    running.delete(label);
    addWork(label, performance.now() - began);
  }
}
