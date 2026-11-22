/**
 * Every per-frame loop on one `requestAnimationFrame`: every loop's read, then every loop's write, so N loops
 * cost one layout a frame, not N (a board wipe's eleven trails and stand-ins forced 30–60 ms a frame,
 * 2026-11-01). `step` is the read, given the frame's start time, and returns the write, or null once over. A
 * loop added mid-frame runs next frame; one that throws ends alone, rethrown once the frame is through.
 */
export type FrameStep = (now: number) => (() => void) | null;

const loops = new Set<FrameStep>();
let frame: number | null = null;

/** Run `step` every frame, its read with every other loop's reads and its write after them. Returns the stop. */
export function everyFrame(step: FrameStep): () => void {
  loops.add(step);
  frame ??= requestAnimationFrame(run);
  return () => {
    loops.delete(step);
  };
}

/** `write` once, with the next frame's writes. Returns the cancel. */
export function nextFrame(write: () => void): () => void {
  const stop = everyFrame(() => (stop(), write));
  return stop;
}

/** Test-only: forgets every loop and the frame owed, as when a test leaves fake timers with one still due. */
export function resetFrames(): void {
  loops.clear();
  frame = null;
}

function run(now: number): void {
  frame = null;
  let failed: { error: unknown } | null = null;
  const writes: [FrameStep, () => void][] = [];
  for (const step of [...loops]) {
    try {
      const write = step(now);
      if (write === null) loops.delete(step);
      else writes.push([step, write]);
    } catch (error) {
      loops.delete(step);
      failed ??= { error };
    }
  }
  for (const [step, write] of writes) {
    try {
      write();
    } catch (error) {
      loops.delete(step);
      failed ??= { error };
    }
  }
  if (loops.size > 0) frame ??= requestAnimationFrame(run);
  if (failed !== null) throw failed.error;
}
