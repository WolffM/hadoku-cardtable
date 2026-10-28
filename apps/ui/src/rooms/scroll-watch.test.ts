import { PageEventSchema } from '@hadoku/shared';
import { describe, expect, it } from 'vitest';

import { browserOf, IDLE_MS, MAX_REPORTS, MIN_FRAMES, watchScroll, type ScrollWatchHost } from './scroll-watch.ts';

const LIST = { id: 'shell' } as unknown as EventTarget;
const OTHER = { id: 'chat' } as unknown as EventTarget;

/** A host with a hand-driven clock, frame queue and scroll listener. */
function fakeHost(rooms = 40) {
  let now = 0;
  let nextId = 1;
  const frames = new Map<number, (t: number) => void>();
  let listener: ((e: Event) => void) | null = null;
  const sent: Record<string, string | number | boolean>[] = [];
  const host: ScrollWatchHost = {
    win: {
      requestAnimationFrame: (cb) => {
        frames.set(nextId, cb);
        return nextId++;
      },
      cancelAnimationFrame: (id) => {
        frames.delete(id);
      },
      devicePixelRatio: 1.25,
      innerWidth: 1920,
      innerHeight: 1080,
    },
    doc: {
      addEventListener: (_type: string, l: EventListenerOrEventListenerObject) => {
        listener = l as (e: Event) => void;
      },
      removeEventListener: () => {
        listener = null;
      },
    } as unknown as ScrollWatchHost['doc'],
    now: () => now,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
    scrolls: (t) => t === LIST,
    rooms: () => rooms,
    ui: '0.32.1',
    send: (data) => sent.push(data),
  };
  const scroll = (target = LIST): void => listener?.({ target } as unknown as Event);
  /** Advance by `gap` ms and run the pending frame, scrolling the list first when `moving`. */
  const frame = (gap: number, moving = true): void => {
    now += gap;
    if (moving) scroll();
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, cb] of pending) cb(now);
  };
  return { host, sent, scroll, frame, listening: () => listener !== null, pending: () => frames.size };
}

describe('browserOf', () => {
  it('names the family and major version', () => {
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; rv:144.0) Gecko/20100101 Firefox/144.0')).toEqual({ browser: 'firefox', version: 144 });
    expect(browserOf('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')).toEqual({ browser: 'chrome', version: 141 });
    expect(browserOf('Mozilla/5.0 AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toEqual({ browser: 'edge', version: 141 });
    expect(browserOf('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.2 Safari/605.1.15')).toEqual({ browser: 'safari', version: 18 });
    expect(browserOf('curl/8')).toEqual({ browser: 'other', version: 0 });
  });
});

describe('watchScroll', () => {
  it('sends one summary per burst: frames, median, p95, the dropped ones, and the page’s facts', () => {
    const t = fakeHost();
    const stop = watchScroll(t.host);
    t.scroll();
    t.frame(16);
    // 18 smooth frames, one dropped (33 ms), one slow (60 ms): 20 counted gaps.
    for (let i = 0; i < 18; i += 1) t.frame(16);
    t.frame(33);
    t.frame(60);
    expect(t.sent).toEqual([]);
    // Still frames until the burst is idle: not counted.
    while (t.pending() > 0) t.frame(16, false);
    expect(t.sent).toHaveLength(1);
    const data = t.sent[0]!;
    expect(data).toMatchObject({ what: 'scroll', frames: 20, p50: 17, over25: 2, over50: 1, max: 60, browser: 'firefox', version: 144, dpr: 1.25, vw: 1920, vh: 1080, rooms: 40, ui: '0.32.1' });
    expect(data.p95).toBe(34);
    expect(PageEventSchema.safeParse({ page: 'front', kind: 'perf', data }).success).toBe(true);
    stop();
    expect(t.listening()).toBe(false);
  });

  it('ignores a scroll of anything but the list, and a nudge too short to judge', () => {
    const t = fakeHost();
    watchScroll(t.host);
    t.scroll(OTHER);
    expect(t.pending()).toBe(0);
    t.scroll();
    for (let i = 0; i < MIN_FRAMES - 1; i += 1) t.frame(16);
    t.frame(IDLE_MS + 1, false);
    expect(t.sent).toEqual([]);
  });

  it('reports a burst still open when it stops, and at most MAX_REPORTS bursts a page', () => {
    const t = fakeHost();
    const stop = watchScroll(t.host);
    for (let b = 0; b < MAX_REPORTS + 3; b += 1) {
      t.scroll();
      for (let i = 0; i < MIN_FRAMES + 1; i += 1) t.frame(16);
      while (t.pending() > 0) t.frame(16, false);
    }
    expect(t.sent).toHaveLength(MAX_REPORTS);

    const u = fakeHost();
    const stopU = watchScroll(u.host);
    u.scroll();
    for (let i = 0; i < MIN_FRAMES + 1; i += 1) u.frame(16);
    stopU();
    expect(u.sent).toHaveLength(1);
    expect(u.pending()).toBe(0);
    stop();
  });
});
