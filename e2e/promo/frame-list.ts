/**
 * How the rig lays the screencast's frames out in time: the ffmpeg concat list `stop` hands to
 * {@link FILM_FILTER}, one entry per captured frame with how long it holds.
 *
 * The screencast sends a frame only when the compositor draws one, so its arrivals say when the screen
 * changed: a frame holds until the next one arrives.
 *
 * {@link FILM_FILTER} blends between the frames it is given across however long lies between them. Over a
 * missed frame that is what it is for; over a still screen it is a crossfade the page never drew. In cut 4
 * a hovered deck list faded out, each Gauntlet pick and ban faded in, and a face turned by the wheel
 * crossfaded, each over the whole still before it (1.3–2.8 s, a linear ramp toward the next frame), with
 * nothing on the page moving. So past {@link STILL_MS} a frame is given again one frame before its
 * successor, and the blend has only that last frame to cross.
 */

/** The film's frame rate. */
export const FPS = 60;

/**
 * The filter that turns the variable-rate list into the film: 60 fps CFR, a frame the screencast missed
 * blended from its two neighbours rather than a repeat of the one before, so a single missed frame reads
 * as motion, not a hitch.
 */
export const FILM_FILTER = `minterpolate=fps=${FPS}:mi_mode=blend,format=yuv420p`;

/** A gap longer than this between two frames is a still screen, not frames the screencast missed. */
export const STILL_MS = 100;

/** The concat list for frames named `000001.jpg`… that arrived at `arrivals`, filmed from `t0` to `end` (epoch ms). */
export function frameList(arrivals: readonly number[], t0: number, end: number): string {
  const name = (i: number): string => `file '${String(i + 1).padStart(6, '0')}.jpg'\n`;
  // The clip's clock is t0 (what the marks count from): the first frame holds from t0 to its successor.
  const times = [t0, ...arrivals.slice(1), end];
  const step = 1000 / FPS;
  const entry = (i: number, ms: number): string => `${name(i)}duration ${(ms / 1000).toFixed(4)}\n`;
  const list = arrivals
    .map((_, i) => {
      const gap = times[i + 1]! - times[i]!;
      return gap > STILL_MS ? entry(i, gap - step) + entry(i, step) : entry(i, gap);
    })
    .join('');
  // A still screen sends no frames, and minterpolate ends at the last frame it is given, ignoring how long
  // that frame was meant to hold: so the last frame is given again at the clip's real end. (A Victory
  // screen is still, and is the shot: Progenitus lost its last five seconds to this.)
  const last = name(arrivals.length - 1);
  return `${list}${last}duration 0.0167\n${last}`;
}
