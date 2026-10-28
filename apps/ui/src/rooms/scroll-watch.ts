/**
 * The room list's scroll smoothness, in the server's log (the operator, 2026-10-28: *"please measure
 * this properly with e2e tests and telemetry not just guessing"*, of Firefox dropping frames while the
 * front page scrolls). A scroll of the box that holds the room list opens a burst; one
 * `requestAnimationFrame` loop times the gap before every frame the list moved in, until it has been
 * still for {@link IDLE_MS}, then sends one `perf` page event (`@hadoku/shared`'s `PageEventSchema`) summarising
 * the burst: how many frames, their median and p95, how many ran over 25 ms (a 60 Hz frame dropped)
 * and over 50 ms, with the browser, its version, the pixel ratio, the window and the room count.
 *
 * No per-frame upload: a frame costs a clock read and a histogram bump (`./frame-watch.ts`'s
 * buckets), and a burst sends one event. Nothing runs while the list is not scrolling.
 */
import type { PageEvent } from '@hadoku/shared';

import { BUCKETS, bucketOf, percentile } from '../play/live/frame-watch.ts';

type Data = PageEvent['data'];

/** A burst is over once the list has not scrolled for this long. */
export const IDLE_MS = 250;
/** A burst still scrolling after this long is reported and the next scroll opens a new one. */
export const MAX_BURST_MS = 10_000;
/** A burst shorter than this many frames is a nudge, not a scroll: nothing is sent. */
export const MIN_FRAMES = 10;
/** A gap over this is a dropped frame at 60 Hz: one and a half frames. */
export const DROP_MS = 25;
/** A gap over this is two frames missed in a row. */
export const SLOW_MS = 50;
/** At most this many bursts reported per page: a long session must not turn its telemetry into traffic. */
export const MAX_REPORTS = 30;

export interface ScrollWatchHost {
  readonly win: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'devicePixelRatio' | 'innerWidth' | 'innerHeight'>;
  readonly doc: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  readonly now: () => number;
  readonly userAgent: string;
  /** Whether a scroll of this target moves the room list. */
  readonly scrolls: (target: EventTarget | null) => boolean;
  /** How many rooms the list draws now. */
  readonly rooms: () => number;
  readonly ui: string;
  readonly send: (data: Data) => void;
}

/** The browser family and its major version, from the user agent; `other` when it names none we know. */
export function browserOf(ua: string): { browser: string; version: number } {
  const families: readonly [string, RegExp][] = [
    ['firefox', /Firefox\/(\d+)/],
    ['edge', /Edg\/(\d+)/],
    ['opera', /OPR\/(\d+)/],
    ['chrome', /Chrome\/(\d+)/],
    ['safari', /Version\/(\d+).*Safari\//],
  ];
  for (const [browser, re] of families) {
    const m = re.exec(ua);
    if (m !== null) return { browser, version: Number(m[1]) };
  }
  return { browser: 'other', version: 0 };
}

/** Start watching; returns the stop. A burst still open when it stops is reported. */
export function watchScroll(host: ScrollWatchHost): () => void {
  const { browser, version } = browserOf(host.userAgent);
  const histogram = new Uint32Array(BUCKETS);
  let frames = 0;
  let over25 = 0;
  let over50 = 0;
  let max = 0;
  let startedAt = 0;
  let lastScrollAt = 0;
  let prevFrame: number | null = null;
  /** Whether the list scrolled since the last frame: the still frames that end a burst are not counted. */
  let moved = false;
  let raf: number | null = null;
  let reports = 0;

  const end = (): void => {
    if (raf !== null) host.win.cancelAnimationFrame(raf);
    raf = null;
    if (frames >= MIN_FRAMES && reports < MAX_REPORTS) {
      reports += 1;
      host.send({
        what: 'scroll',
        frames,
        ms: Math.round(host.now() - startedAt),
        p50: percentile(histogram, frames, 0.5),
        p95: percentile(histogram, frames, 0.95),
        max: Math.round(max),
        over25,
        over50,
        browser,
        version,
        dpr: Math.round(host.win.devicePixelRatio * 100) / 100,
        vw: host.win.innerWidth,
        vh: host.win.innerHeight,
        rooms: host.rooms(),
        ui: host.ui,
      });
    }
    histogram.fill(0);
    frames = 0;
    over25 = 0;
    over50 = 0;
    max = 0;
    prevFrame = null;
  };

  const tick = (t: number): void => {
    raf = null;
    if (prevFrame !== null && moved) {
      const gap = t - prevFrame;
      histogram[bucketOf(gap)]! += 1;
      frames += 1;
      if (gap > DROP_MS) over25 += 1;
      if (gap > SLOW_MS) over50 += 1;
      if (gap > max) max = gap;
    }
    prevFrame = t;
    moved = false;
    const now = host.now();
    if (now - lastScrollAt > IDLE_MS || now - startedAt > MAX_BURST_MS) end();
    else raf = host.win.requestAnimationFrame(tick);
  };

  const onScroll = (e: Event): void => {
    if (!host.scrolls(e.target)) return;
    const now = host.now();
    lastScrollAt = now;
    moved = true;
    if (raf !== null) return;
    startedAt = now;
    raf = host.win.requestAnimationFrame(tick);
  };

  // `scroll` does not bubble from an element: caught on the way down instead, from whichever box scrolls.
  host.doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    host.doc.removeEventListener('scroll', onScroll, { capture: true });
    if (raf !== null) end();
  };
}
