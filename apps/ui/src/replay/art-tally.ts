/*
 * How a replay's drawn faces came out: with their art, or as the text tile. Told to the server log
 * once per replay (`ReplayScreen`), so whether replays draw their art is answered by prod's own log,
 * not by a viewer's report.
 */

export interface ArtTally {
  /** Every card face the board draws. */
  faces: number;
  /** Faces whose art has decoded. */
  withArt: number;
  /** Faces drawn as the text tile: no art id, or an image that failed. */
  fallback: number;
  /** Faces whose art has not finished loading (a lazy image off screen). */
  pending: number;
}

/** The tally of every card face under `root`, as drawn right now. */
export function tallyArt(root: ParentNode): ArtTally {
  const tally: ArtTally = { faces: 0, withArt: 0, fallback: 0, pending: 0 };
  for (const face of root.querySelectorAll('[data-testid="card"]')) {
    tally.faces += 1;
    const img = face.querySelector<HTMLImageElement>('img.card__art');
    if (img === null || img.style.display === 'none') tally.fallback += 1;
    else if (!img.complete) tally.pending += 1;
    else if (img.naturalWidth > 0) tally.withArt += 1;
    else tally.fallback += 1;
  }
  return tally;
}

/** How long a replay's board settles before its faces are counted, and how often the count is retried while some still load. */
export const ART_TALLY_SETTLE_MS = 3_000;
export const ART_TALLY_GIVE_UP_MS = 15_000;

/**
 * Counts `root`'s faces once they have settled: the first count with nothing pending, or the last
 * one at {@link ART_TALLY_GIVE_UP_MS}. A board with no faces yet is not counted. Returns a cancel.
 */
export function whenArtSettles(root: () => ParentNode | null, report: (tally: ArtTally) => void): () => void {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = (): void => {
    const node = root();
    const tally = node === null ? null : tallyArt(node);
    const late = Date.now() - started >= ART_TALLY_GIVE_UP_MS;
    if (tally !== null && tally.faces > 0 && (tally.pending === 0 || late)) {
      timer = null;
      report(tally);
      return;
    }
    if (late) {
      timer = null;
      return;
    }
    timer = setTimeout(check, ART_TALLY_SETTLE_MS);
  };
  timer = setTimeout(check, ART_TALLY_SETTLE_MS);
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}
