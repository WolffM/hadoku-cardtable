/**
 * Every per-frame loop on the board, run on one `requestAnimationFrame`: first every loop's read,
 * then every loop's write. A loop that reads a box and then writes a style forces the NEXT loop's
 * read to lay the page out again, so N loops each reading on their own frame cost N layouts a frame
 * where they need one. Measured on the trailer's Blasphemous Act (cut 3, 2026-11-01): eleven hits
 * in flight, each trail reading its ball and then dropping embers, and each entry stand-in following
 * its row card, forced 30–60 ms of layout into every frame of the wipe.
 *
 * `step` is the read. It returns the write to run once every loop has read, or null when the loop
 * is over. A loop added during a frame first runs on the next one. A step or write that throws ends
 * its own loop (as a loop that throws before asking for its next frame always did) and is rethrown
 * once the frame is through, so the others still run.
 */
export type FrameStep = () => (() => void) | null;

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

function run(): void {
  frame = null;
  let failed: { error: unknown } | null = null;
  const writes: [FrameStep, () => void][] = [];
  for (const step of [...loops]) {
    try {
      const write = step();
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
  if (loops.size > 0) frame = requestAnimationFrame(run);
  if (failed !== null) throw failed.error;
}
