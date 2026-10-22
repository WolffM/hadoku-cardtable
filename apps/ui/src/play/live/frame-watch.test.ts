/*
 * `frame-watch.ts`: the frame rate in the match's log. A fake `requestAnimationFrame` and clock drive
 * it frame by frame; a fake document says whether the tab is visible; a stub `PerformanceObserver`
 * hands it Chrome's long animation frames.
 */
import { describe, expect, it } from 'vitest';
import { ClientEventSchema } from '@hadoku/shared';

import {
  MAX_REPORTS,
  RECOVER_MS,
  REPORT_EVERY_MS,
  SUMMARY_EVERY_TURNS,
  animationTop,
  boardFacts,
  loafFields,
  scriptField,
  watchFrames,
  type FrameWatchHost,
  type LongFrame,
  type ObserverClass,
} from './frame-watch.ts';
import type { BoardView } from '../adapter.ts';

type Data = Record<string, string | number | boolean>;

/** A tab: its clock, its rAF queue, its visibility, and every report the watch sent. */
function tab(options: { hidden?: boolean; types?: readonly string[] } = {}) {
  let clock = 1_000;
  let pending: ((t: number) => void) | null = null;
  let nextHandle = 1;
  let visibility: DocumentVisibilityState = options.hidden === true ? 'hidden' : 'visible';
  const listeners = new Set<() => void>();
  const pageHide = new Set<() => void>();
  const sent: Data[] = [];
  let reads = 0;
  const observers: { callback: (list: { getEntries(): readonly unknown[] }) => void; type: string; disconnected: boolean }[] = [];
  const Observer = class {
    static supportedEntryTypes = options.types ?? [];
    readonly record: (typeof observers)[number];
    constructor(callback: (list: { getEntries(): readonly unknown[] }) => void) {
      this.record = { callback, type: '', disconnected: false };
      observers.push(this.record);
    }
    observe(o: { type: string }): void {
      this.record.type = o.type;
    }
    disconnect(): void {
      this.record.disconnected = true;
    }
  } as unknown as ObserverClass;
  const host: FrameWatchHost = {
    report: (data) => {
      expect(ClientEventSchema.safeParse({ matchId: 'm', kind: 'perf', data }).success, JSON.stringify(data)).toBe(true);
      sent.push(data);
    },
    board: () => {
      reads += 1;
      return { phase: 'COMBAT_DECLARE_ATTACKERS', turn: 5, whose: 'yours', mine: 10, theirs: 6, hand: 3, stack: 0, paceQueue: 2, beats: 1, ui: '0.0.0' };
    },
    page: () => ({ anims: 12, animTop: 'board-ram×10,t:left×2', dom: 4000 }),
    raf: (cb) => {
      pending = cb;
      return nextHandle++;
    },
    caf: () => {
      pending = null;
    },
    now: () => clock,
    doc: {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    } as unknown as FrameWatchHost['doc'],
    win: {
      innerWidth: 2080,
      innerHeight: 1324,
      addEventListener: (_: string, l: () => void) => pageHide.add(l),
      removeEventListener: (_: string, l: () => void) => pageHide.delete(l),
    } as unknown as FrameWatchHost['win'],
    observer: Observer,
  };
  return {
    host,
    sent,
    observers,
    get scheduled() {
      return pending !== null;
    },
    /** One frame, `gap` ms after the last. */
    frame(gap: number): void {
      clock += gap;
      const run = pending;
      pending = null;
      run?.(clock);
    },
    frames(count: number, gap: number): void {
      for (let i = 0; i < count; i += 1) this.frame(gap);
    },
    hidePage(): void {
      for (const l of pageHide) l();
    },
    get pageHideListeners() {
      return pageHide.size;
    },
    setVisibility(v: DocumentVisibilityState): void {
      visibility = v;
      for (const l of listeners) l();
    },
    get reads() {
      return reads;
    },
    get clock() {
      return clock;
    },
    of(what: string): Data[] {
      return sent.filter((d) => d.what === what);
    },
  };
}

describe('watchFrames', () => {
  it('reports a run of long frames once, with its numbers and what the board was doing', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    t.frames(120, 16); // two smooth seconds, the first frame only starting the clock
    t.frames(10, 80); // 800 ms at 12.5 fps
    t.frames(2, 16);
    t.frame(150);
    t.frames(80, 16); // recovered
    expect(t.of('stretch')).toHaveLength(1);
    const [stretch] = t.of('stretch');
    expect(stretch).toMatchObject({ n: 1, frames: 13, worstMs: 150, over50: 11, over100: 1, freeze: false, suppressed: 0, attribution: 'none', longs: 0, why: 'recovered', window: '2080x1324' });
    // From the first slow gap's start to the last one's end: 10×80 + 2×16 + 150.
    expect(stretch!.ms).toBe(982);
    expect(stretch!.fps).toBe(13.2);
    // Read as it opened and at its worst frame, its last.
    expect(t.reads).toBe(2);
    expect(t.of('board')).toEqual([{ what: 'board', n: 1, atMs: 982, phase: 'COMBAT_DECLARE_ATTACKERS', turn: 5, whose: 'yours', mine: 10, theirs: 6, hand: 3, stack: 0, paceQueue: 2, beats: 1, ui: '0.0.0', anims: 12, animTop: 'board-ram×10,t:left×2', dom: 4000 }]);
    expect(t.of('loaf'), 'no attribution offered').toEqual([]);
    watch.dispose();
  });

  it('reads the board as a stretch opens and at each new worst frame in it, never on a smooth frame', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    t.frames(500, 16);
    expect(t.reads).toBe(0);
    t.frame(300); // opens
    t.frames(3, 80); // slower than nothing so far: no new worst
    t.frame(350); // a new worst
    t.frames(5, 60);
    t.frames(200, 16);
    expect(t.reads).toBe(2);
    expect(t.of('board')[0]).toMatchObject({ atMs: 300 + 3 * 80 + 350 });
    watch.dispose();
  });

  it('opens on a single freeze, and ends the stretch only once the frames have recovered for a while', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    t.frames(30, 16);
    t.frame(400);
    t.frames(Math.floor((RECOVER_MS - 50) / 16), 16);
    expect(t.of('stretch'), 'not recovered yet').toEqual([]);
    t.frame(60); // a slow gap inside the stretch keeps it open
    t.frames(Math.ceil(RECOVER_MS / 16) + 1, 16);
    expect(t.of('stretch')).toHaveLength(1);
    expect(t.of('stretch')[0]).toMatchObject({ freeze: true, worstMs: 400, over50: 2, over100: 1 });
    watch.dispose();
  });

  it('ignores two slow frames in a second: a hiccup, not a bad moment', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    t.frames(10, 16);
    t.frame(90);
    t.frames(20, 16);
    t.frame(90);
    t.frames(60, 16);
    t.frame(90); // over a second after the first
    t.frames(100, 16);
    expect(t.of('stretch')).toEqual([]);
    watch.dispose();
  });

  it('reports nothing while the tab is hidden, and drops the first frame after it is visible again', () => {
    const t = tab({ hidden: true });
    const watch = watchFrames(t.host);
    expect(t.scheduled, 'a hidden tab runs no loop').toBe(false);
    t.setVisibility('visible');
    t.frames(30, 16);
    t.setVisibility('hidden');
    expect(t.scheduled).toBe(false);
    t.setVisibility('visible');
    t.frame(5_000); // the first frame back: the whole hidden time, not a freeze
    t.frames(100, 16);
    expect(t.of('stretch')).toEqual([]);
    watch.dispose();
    expect(t.of('summary')[0]).toMatchObject({ frames: 29 + 100, worstMs: 16 });
  });

  it('closes a stretch the tab hides in, as hidden', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    t.frames(10, 16);
    t.frames(5, 120);
    t.setVisibility('hidden');
    expect(t.of('stretch')).toHaveLength(1);
    expect(t.of('stretch')[0]).toMatchObject({ why: 'hidden', frames: 5, over100: 5 });
    watch.dispose();
  });

  it('sends at most one stretch report per interval, and counts the ones it held back in the next', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    const stutter = (): void => {
      t.frames(4, 70);
      t.frames(Math.ceil(RECOVER_MS / 16) + 1, 16);
    };
    t.frames(5, 16);
    stutter();
    stutter(); // ~1.3 s after the first: held back
    stutter();
    expect(t.of('stretch')).toHaveLength(1);
    t.frames(Math.ceil(REPORT_EVERY_MS / 16), 16);
    stutter();
    expect(t.of('stretch')).toHaveLength(2);
    expect(t.of('stretch')[1]).toMatchObject({ n: 4, suppressed: 2 });
    expect(t.of('board').map((b) => b.n)).toEqual([1, 4]);
    watch.dispose();
    expect(t.of('summary')[0]).toMatchObject({ why: 'end', stretches: 4, reports: 2, suppressed: 2 });
  });

  it('stops reporting at the per-match cap', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    t.frames(5, 16);
    for (let i = 0; i < MAX_REPORTS + 5; i += 1) {
      t.frame(300);
      t.frames(Math.ceil(REPORT_EVERY_MS / 16) + 1, 16);
    }
    expect(t.of('stretch')).toHaveLength(MAX_REPORTS);
    watch.dispose();
    expect(t.of('summary')[0]).toMatchObject({ stretches: MAX_REPORTS + 5, reports: MAX_REPORTS, suppressed: 5 });
  });

  it('attaches the stretch’s longest animation frames, largest first, where Chrome offers them', () => {
    const t = tab({ types: ['long-animation-frame', 'longtask'] });
    const watch = watchFrames(t.host);
    expect(t.observers.map((o) => o.type)).toEqual(['long-animation-frame']);
    t.frames(10, 16);
    const from = t.clock;
    t.frames(6, 90);
    const entry = (startTime: number, duration: number, script: number): LongFrame => ({
      startTime,
      duration,
      renderStart: startTime + script,
      styleAndLayoutStart: startTime + script + 5,
      blockingDuration: duration - 50,
      scripts: [
        { invoker: 'TimerHandler:setTimeout', sourceFunctionName: 'tick', sourceURL: 'https://hadoku.me/cardtable/assets/index-abc123.js?v=1', sourceCharPosition: 4321, duration: script - 10, forcedStyleAndLayoutDuration: 12 },
        { invoker: 'https://hadoku.me/cardtable/assets/index-abc123.js', sourceFunctionName: '', sourceURL: '', sourceCharPosition: -1, duration: 10, forcedStyleAndLayoutDuration: 0 },
      ],
    });
    // One from before the stretch, four inside it.
    t.observers[0]!.callback({ getEntries: () => [entry(from - 500, 70, 30), entry(from, 90, 60), entry(from + 90, 88, 40), entry(from + 180, 120, 70), entry(from + 270, 60, 20)] });
    t.frames(Math.ceil(RECOVER_MS / 16) + 1, 16);
    expect(t.of('stretch')[0]).toMatchObject({ attribution: 'loaf', longs: 4, longMaxMs: 120 });
    const loafs = t.of('loaf');
    expect(loafs.map((l) => [l.rank, l.ms])).toEqual([
      [1, 120],
      [2, 90],
      [3, 88],
    ]);
    expect(loafs[0]).toEqual({
      what: 'loaf',
      n: 1,
      rank: 1,
      atMs: 180,
      ms: 120,
      blockMs: 70,
      workMs: 70,
      renderMs: 5,
      layoutMs: 45,
      scripts: 2,
      forcedMs: 12,
      s1: 'TimerHandler:setTimeout|tick|index-abc123.js:4321|60|f12',
      s2: 'index-abc123.js|||10|f0',
    });
    watch.dispose();
    expect(t.observers[0]!.disconnected).toBe(true);
  });

  it('counts long tasks where only those are offered, and attaches no frames', () => {
    const t = tab({ types: ['longtask'] });
    const watch = watchFrames(t.host);
    expect(t.observers.map((o) => o.type)).toEqual(['longtask']);
    t.frames(10, 16);
    const from = t.clock;
    t.frame(250);
    t.observers[0]!.callback({ getEntries: () => [{ startTime: from + 10, duration: 230 }] });
    t.frames(Math.ceil(RECOVER_MS / 16) + 1, 16);
    expect(t.of('stretch')[0]).toMatchObject({ attribution: 'longtask', longs: 1, longMaxMs: 230 });
    expect(t.of('loaf')).toEqual([]);
    watch.dispose();
  });

  it('summarises every frame every few turns and at the end', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    watch.noteTurn(1);
    t.frames(1, 16);
    t.frames(98, 16);
    t.frame(40);
    watch.noteTurn(2);
    expect(t.of('summary')).toEqual([]);
    watch.noteTurn(1 + SUMMARY_EVERY_TURNS);
    expect(t.of('summary')).toHaveLength(1);
    expect(t.of('summary')[0]).toMatchObject({ why: 'turns', fromTurn: 1, turn: 1 + SUMMARY_EVERY_TURNS, frames: 99, p50: 17, p95: 17, p99: 41, worstMs: 40, stretches: 0 });
    t.frames(10, 33);
    watch.dispose();
    expect(t.of('summary')[1]).toMatchObject({ why: 'end', fromTurn: 1 + SUMMARY_EVERY_TURNS, frames: 10, p50: 34, worstMs: 33 });
    expect(t.scheduled, 'disposed: the loop stops').toBe(false);
  });

  it('summarises as the game ends, and sends what it saw as the tab closes', () => {
    const t = tab();
    const watch = watchFrames(t.host);
    t.frames(51, 16);
    watch.noteGameOver();
    expect(t.of('summary')).toEqual([expect.objectContaining({ why: 'over', frames: 50 })]);
    t.frames(5, 16);
    t.frame(300); // a freeze, still open as the tab goes
    t.hidePage();
    expect(t.of('stretch')).toEqual([expect.objectContaining({ why: 'end', worstMs: 300 })]);
    expect(t.of('summary')[1]).toMatchObject({ why: 'end', frames: 6 });
    watch.dispose();
    expect(t.pageHideListeners).toBe(0);
  });
});

describe('the attribution fields', () => {
  it('fit the telemetry’s text limit however long the names', () => {
    const long = 'x'.repeat(300);
    const field = scriptField({ invoker: long, sourceFunctionName: long, sourceURL: `https://a/${long}.js`, sourceCharPosition: 123456, duration: 1, forcedStyleAndLayoutDuration: 0 });
    expect(field.length).toBeLessThanOrEqual(80);
  });

  it('read a frame with no render phase as all script', () => {
    expect(loafFields({ startTime: 100, duration: 80, renderStart: 0, styleAndLayoutStart: 0, blockingDuration: 30, scripts: [] }, 90)).toEqual({ atMs: 10, ms: 80, blockMs: 30, workMs: 80, renderMs: 0, layoutMs: 0, scripts: 0, forcedMs: 0 });
  });

  it('count the board by side, and say whose turn it is', () => {
    const player = (id: number, isViewer: boolean, battlefield: number, handCount: number) => ({ id, isViewer, battlefield: Array.from({ length: battlefield }), handCount });
    const view = { turn: 7, phase: 'COMBAT_DAMAGE', activePlayerId: 2, stack: [{}], players: [player(1, true, 8, 4), player(2, false, 9, 6)] } as unknown as BoardView;
    expect(boardFacts(view)).toEqual({ phase: 'COMBAT_DAMAGE', turn: 7, whose: 'theirs', mine: 8, theirs: 9, hand: 4, stack: 1 });
    expect(boardFacts(null)).toEqual({ turn: -1 });
  });

  it('name the running animations by what they move, most first', () => {
    const el = (cls: string) => ({ classList: [cls] });
    const anims = [
      ...Array.from({ length: 3 }, () => ({ playState: 'running', effect: { target: el('board-ram') } })),
      { playState: 'running', transitionProperty: 'left', effect: null },
      { playState: 'running', animationName: 'pulse', effect: null },
      { playState: 'finished', effect: { target: el('effect-hit') } },
    ] as unknown as Animation[];
    expect(animationTop(anims)).toBe('board-ram×3,t:left×1,pulse×1');
  });
});
