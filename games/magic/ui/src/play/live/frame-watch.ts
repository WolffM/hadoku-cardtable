/**
 * The frame rate, in the match's log (the operator, 2026-10-21: *"ship some performance telemetry and
 * capture moments when performance gets bad … ui performance telemetry that fire whenever the framerate
 * gets too low"*). One `requestAnimationFrame` loop times the gap between frames while a match is on
 * screen, its tab is visible and the page is drawing, and sends `perf` client events (`@hadoku/shared`'s
 * `telemetry.ts`):
 *
 * - `what: 'stretch'` — a bad stretch: a second with {@link SLOW_IN_WINDOW} slow gaps, or one gap over
 *   {@link FREEZE_MS}, until the frames recover. One report per stretch, however long it lasts.
 * - `what: 'board'` — what the board was doing at the stretch's worst frame: its beats, the pace queue,
 *   the running animations by what they move, the turn and the counts.
 * - `what: 'loaf'` — one per long frame the browser attributed (Chrome's `long-animation-frame`): how its
 *   time split between script, the render phase's callbacks and style and layout, and the scripts that ran.
 * - `what: 'work'` — where a reported stretch's time went, in any browser (`./work-meter.ts`): our own
 *   hot paths by label, and what was left, the browser's style, layout, paint and compositing.
 * - `what: 'summary'` — every frame since the last summary, every {@link SUMMARY_EVERY_TURNS} turns, as
 *   the game ends and as the board or the tab closes: a baseline even when nothing went bad.
 * - `what: 'phases'` — the same frames by the phase they were drawn in, beside each summary: combat
 *   against a main phase, whether or not anything went bad in either.
 *
 * A frame costs two clock reads, a few counter writes and one histogram bump: no allocation, no DOM read,
 * no layout. Everything else is computed only when a stretch opens or a report goes out.
 *
 * It never asks for a frame the page would not draw. A `requestAnimationFrame` loop makes the browser
 * draw every frame, and each frame the main thread draws samples every running animation, the ones the
 * compositor runs included: a table of flyers, each looping on the compositor, cost the main thread a
 * restyle of every part of every flyer sixty times a second, for as long as a match was open — a cost
 * that grew with each Thopter a combo made. So once nothing has been drawn for {@link QUIET_MS} (no DOM
 * change, no input, no animation or transition starting: `pageActivity`), and no stretch is open, the
 * loop stops. The next change starts it again. While it is stopped, a timer every {@link HEARTBEAT_MS}
 * stands in for the frames: one that runs over {@link FREEZE_MS} late was a freeze, timed as a frame from
 * when it was due. The frames a summary counts are the frames the page drew.
 */
import type { ClientEvent } from '@hadoku/shared';

import type { BoardView } from '../adapter.ts';
import { workSpent } from './work-meter.ts';

type Data = ClientEvent['data'];

/**
 * A gap over this is a slow frame, the kind a stretch is made of: a 60 Hz frame missed, motion at 30 fps.
 * It was {@link SLOW_MS} until the operator, 2026-10-22, saw combat drop to ~38 fps ("when cards start
 * moving out to attack, i notice framerate drops") in matches whose telemetry reported nothing: a 33 ms
 * gap never reached 50.
 */
export const DROP_MS = 30;
/** The tier a stretch counts as `over50`: under 20 fps, two 60 Hz frames missed in a row. */
export const SLOW_MS = 50;
/** The second tier a stretch counts: under 10 fps, motion that visibly steps. */
export const VERY_SLOW_MS = 100;
/** One gap over this is a bad moment on its own: a fifth of a second with nothing drawn is seen by anyone. */
export const FREEZE_MS = 200;
/** Slow gaps inside one {@link WINDOW_MS} that make a bad moment: one or two are a decode or a GC pause, three in a second is motion that stutters. */
export const SLOW_IN_WINDOW = 3;
/** The window {@link SLOW_IN_WINDOW} is counted over. */
export const WINDOW_MS = 1_000;
/** A stretch is over once this long passes with no slow gap: any shorter, and one long stall reads as several. */
export const RECOVER_MS = 1_000;
/** A stretch that never recovers is reported at this length and goes on as a new one, so lag that never ends still reaches the log. */
export const MAX_STRETCH_MS = 15_000;
/** At most one stretch report this often: a laggy game must not turn its own telemetry into more lag. */
export const REPORT_EVERY_MS = 10_000;
/** At most this many stretch reports in one match; the rest are counted in the summaries. */
export const MAX_REPORTS = 30;
/**
 * The page's own facts (`pageFacts`: every running animation, the DOM's size) are read at most this
 * often inside a stretch: one read cost 59 ms in a six-creature attack (`e2e/combat-perf.spec.ts`), and
 * a stretch that keeps getting worse read them at every new worst frame — the monitor adding the lag
 * it reports.
 */
export const PAGE_EVERY_MS = 1_000;
/** How many of a stretch's longest frames are attributed, each in its own `loaf` event (the server takes 20 events a second). */
export const TOP_LONG_FRAMES = 3;
/** How many of a long frame's scripts are named. */
export const TOP_SCRIPTS = 3;
/** With nothing drawn for this long, the loop stops asking for frames (`pageActivity` starts it again). */
export const QUIET_MS = 1_000;
/** While the loop is stopped, a timer this often times the main thread: a late one was a freeze. */
export const HEARTBEAT_MS = 100;
/** A summary every this many turns, beside the one as the match closes. */
export const SUMMARY_EVERY_TURNS = 4;

/** The last gaps, for what came before a stretch was recognised: a second at up to 512 fps. */
const RING = 512;
/** Long frames (or long tasks) kept for attribution: more than a {@link MAX_STRETCH_MS} stretch of them is old news. */
const LONG_KEEP = 48;
/** Gap histogram: 1 ms buckets below 128 ms, 16 ms buckets above, the last one open-ended. */
export const BUCKETS = 256;
/** The telemetry's text limit (`ScalarSchema`). */
const TEXT_MAX = 80;

/** Chrome's `PerformanceScriptTiming`, the fields read here (TypeScript's DOM lib has none of it yet). */
interface ScriptTiming {
  readonly invoker: string;
  readonly sourceFunctionName: string;
  readonly sourceURL: string;
  readonly sourceCharPosition: number;
  readonly duration: number;
  readonly forcedStyleAndLayoutDuration: number;
}

/** Chrome's `PerformanceLongAnimationFrameTiming`, or a `longtask` entry (which carries only the first two). */
export interface LongFrame {
  readonly startTime: number;
  readonly duration: number;
  readonly renderStart?: number;
  readonly styleAndLayoutStart?: number;
  readonly blockingDuration?: number;
  readonly scripts?: readonly ScriptTiming[];
}

/** The part of `PerformanceObserver` used here, so a test can stand one in. */
export interface ObserverClass {
  readonly supportedEntryTypes?: readonly string[];
  new (callback: (list: { getEntries(): readonly unknown[] }) => void): { observe(options: { type: string; buffered?: boolean }): void; disconnect(): void; takeRecords?(): readonly unknown[] };
}

export interface FrameWatchHost {
  /** Where a `perf` event's data goes. */
  report: (data: Data) => void;
  /** What the board is doing, read as a stretch opens and again at each new worst frame in it. */
  board: () => Data;
  /** The page's own facts (DOM size, running animations), read with {@link FrameWatchHost.board}. Defaults to {@link pageFacts}. */
  page?: () => Data;
  /** Test seams: the real `requestAnimationFrame`, `cancelAnimationFrame`, `performance.now`, `document` and `PerformanceObserver` by default. */
  raf?: (callback: (t: number) => void) => number;
  caf?: (handle: number) => void;
  now?: () => number;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  /** Where a closing tab says so (`pagehide`): the real `window` by default. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'innerWidth' | 'innerHeight'>;
  observer?: ObserverClass | null;
  /** What our own hot paths have spent, by label (`./work-meter.ts`'s `workSpent`, the default). */
  work?: () => ReadonlyMap<string, number>;
  /** Calls `wake` whenever the page draws something new; returns the uninstall. {@link pageActivity} by default. */
  wakeOn?: (wake: () => void) => () => void;
  /** The heartbeat's timer: `setTimeout`/`clearTimeout` by default. */
  timer?: { set: (callback: () => void, ms: number) => number; clear: (handle: number) => void };
}

export interface FrameWatch {
  /** The turn moved on: every {@link SUMMARY_EVERY_TURNS} turns, a summary. */
  noteTurn(turn: number): void;
  /** The phase the board is drawn in now: the frames after this count toward it in the `phases` report. */
  notePhase(phase: string): void;
  /** The game is over: a summary of it. */
  noteGameOver(): void;
  /** Stop: a stretch still open is reported, then a summary. */
  dispose(): void;
}

/** The bucket a gap falls in. */
export function bucketOf(gap: number): number {
  return gap < 128 ? Math.floor(gap) : Math.min(BUCKETS - 1, 128 + Math.floor((gap - 128) / 16));
}

/** A bucket's upper edge, in ms: what a percentile reports. */
function bucketTop(i: number): number {
  return i < 128 ? i + 1 : 128 + (i - 127) * 16;
}

/** The gap at or under which `share` of the counted frames fell. */
export function percentile(histogram: Uint32Array, total: number, share: number): number {
  const want = Math.max(1, Math.ceil(total * share));
  let seen = 0;
  for (let i = 0; i < BUCKETS; i += 1) {
    seen += histogram[i]!;
    if (seen >= want) return bucketTop(i);
  }
  return bucketTop(BUCKETS - 1);
}

/** A URL's file name, without its query. */
function fileOf(url: string): string {
  if (url === '') return '';
  return url.split('?')[0]!.split('#')[0]!.split('/').pop() ?? '';
}

/** One script of a long frame, in one field: `invoker|function|file:char|ms|f<forced style and layout ms>`. */
export function scriptField(s: ScriptTiming): string {
  const invoker = /^https?:/.test(s.invoker) ? fileOf(s.invoker) : s.invoker;
  const where = s.sourceURL === '' ? '' : `${fileOf(s.sourceURL).slice(0, 28)}:${s.sourceCharPosition}`;
  return `${invoker.slice(0, 32)}|${s.sourceFunctionName.slice(0, 24)}|${where}|${Math.round(s.duration)}|f${Math.round(s.forcedStyleAndLayoutDuration)}`.slice(0, TEXT_MAX);
}

/** A long frame, as one `loaf` event's fields: when in the stretch, how long, and where its time went. */
export function loafFields(entry: LongFrame, stretchStart: number): Data {
  const end = entry.startTime + entry.duration;
  const render = entry.renderStart !== undefined && entry.renderStart > 0 ? entry.renderStart : end;
  const layout = entry.styleAndLayoutStart !== undefined && entry.styleAndLayoutStart > 0 ? entry.styleAndLayoutStart : end;
  const scripts = [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration);
  const fields: Data = {
    atMs: Math.round(entry.startTime - stretchStart),
    ms: Math.round(entry.duration),
    blockMs: Math.round(entry.blockingDuration ?? 0),
    // Before the render phase: tasks, input, timers — the frame's script.
    workMs: Math.round(render - entry.startTime),
    // The render phase's own callbacks (rAF, ResizeObserver) before style and layout.
    renderMs: Math.round(layout - render),
    // Style, layout and paint.
    layoutMs: Math.round(end - layout),
    scripts: scripts.length,
    forcedMs: Math.round(scripts.reduce((sum, s) => sum + s.forcedStyleAndLayoutDuration, 0)),
  };
  scripts.slice(0, TOP_SCRIPTS).forEach((s, i) => {
    fields[`s${i + 1}`] = scriptField(s);
  });
  return fields;
}

/** The running animations, by what they move: a CSS animation's name, a transition's property, a script's element class. Top four. */
export function animationTop(animations: readonly Animation[]): string {
  const counts = new Map<string, number>();
  for (const a of animations) {
    if (a.playState !== 'running') continue;
    const named = a as Animation & { animationName?: string; transitionProperty?: string };
    const target = (a.effect as KeyframeEffect | null)?.target ?? null;
    const label = named.animationName ?? (named.transitionProperty !== undefined ? `t:${named.transitionProperty}` : (target?.classList[0] ?? 'js'));
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, n]) => `${label}×${n}`)
    .join(',')
    .slice(0, TEXT_MAX);
}

/** What the board is doing, for a stretch's `board` event: whose turn and where in it, and how much is on the table. */
export function boardFacts(view: BoardView | null): Data {
  if (view === null) return { turn: -1 };
  const viewer = view.players.find((p) => p.isViewer);
  const active = view.players.find((p) => p.id === view.activePlayerId);
  return {
    phase: view.phase ?? 'none',
    turn: view.turn,
    whose: active === undefined ? 'nobody' : active.isViewer ? 'yours' : 'theirs',
    mine: viewer?.battlefield.length ?? 0,
    theirs: view.players.reduce((sum, p) => (p.isViewer ? sum : sum + p.battlefield.length), 0),
    hand: viewer?.handCount ?? 0,
    stack: view.stack.length,
  };
}

/** The page's own facts, read with the board's: the DOM's size and the animations running. */
export function pageFacts(): Data {
  const animations = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
  return {
    anims: animations.filter((a) => a.playState === 'running').length,
    animTop: animationTop(animations),
    dom: document.getElementsByTagName('*').length,
  };
}

/** What makes the page draw: input, DOM changes, and animations and transitions starting. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'scroll', 'resize', 'animationstart', 'transitionrun'] as const;

/** Calls `wake` on everything that makes the page draw a frame (`ACTIVITY_EVENTS`, any DOM change). Returns the uninstall. */
export function pageActivity(wake: () => void): () => void {
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(wake) : null;
  observer?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const options = { capture: true, passive: true } as const;
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, wake, options);
  return () => {
    observer?.disconnect();
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, wake, options);
  };
}

/** The attribution the browser offers: Chrome 123+'s long animation frames, else long tasks, else none (Firefox, Safari). */
export function attributionOf(observer: ObserverClass | null | undefined): 'loaf' | 'longtask' | 'none' {
  const types = observer?.supportedEntryTypes ?? [];
  if (types.includes('long-animation-frame')) return 'loaf';
  if (types.includes('longtask')) return 'longtask';
  return 'none';
}

const IDLE: FrameWatch = { noteTurn: () => undefined, notePhase: () => undefined, noteGameOver: () => undefined, dispose: () => undefined };

/** One phase's frames since the last summary. */
interface PhaseFrames {
  frames: number;
  ms: number;
  drops: number;
  slow: number;
  worst: number;
}

/** A phase's frames in one field: `f<frames> <fps>fps d<over DROP_MS> s<over SLOW_MS> w<worst ms>`. */
export function phaseField(p: PhaseFrames): string {
  return `f${p.frames} ${Math.round((p.frames * 1000) / Math.max(1, p.ms))}fps d${p.drops} s${p.slow} w${Math.round(p.worst)}`;
}

/** The phases a `phases` event can carry beside its `what` (the telemetry's 16 fields). */
const PHASE_FIELDS = 15;

export function watchFrames(host: FrameWatchHost): FrameWatch {
  // A document that draws no frames (a test's, a server render) has none to time.
  if (host.raf === undefined && typeof requestAnimationFrame !== 'function') return IDLE;
  const raf = host.raf ?? ((cb: (t: number) => void) => requestAnimationFrame(cb));
  const caf = host.caf ?? ((h: number) => cancelAnimationFrame(h));
  const now = host.now ?? (() => performance.now());
  const doc = host.doc ?? document;
  const win = host.win ?? window;
  const page = host.page ?? pageFacts;
  const Observer = host.observer === undefined ? (typeof PerformanceObserver === 'function' ? (PerformanceObserver as unknown as ObserverClass) : null) : host.observer;
  const attribution = attributionOf(Observer);
  const work = host.work ?? workSpent;
  const wakeOn = host.wakeOn ?? pageActivity;
  const timer = host.timer ?? { set: (cb: () => void, ms: number) => window.setTimeout(cb, ms), clear: (h: number) => window.clearTimeout(h) };
  /** What our hot paths had spent as the open stretch began. */
  let workAtOpen = new Map<string, number>();
  let phase = 'none';
  let phaseNow: PhaseFrames | null = null;
  const phases = new Map<string, PhaseFrames>();

  // The last gaps and when each ended, oldest overwritten.
  const gaps = new Float64Array(RING);
  const ends = new Float64Array(RING);
  let at = 0;
  // When each of the last SLOW_IN_WINDOW slow gaps ended, and how long it was.
  const slowEnds = new Float64Array(SLOW_IN_WINDOW);
  const slowGaps = new Float64Array(SLOW_IN_WINDOW);
  let slowAt = 0;

  // Since the last summary.
  const histogram = new Uint32Array(BUCKETS);
  let frames = 0;
  let watchedMs = 0;
  let worst = 0;
  let selfMs = 0;
  let selfFrames = 0;
  let stretches = 0;
  let suppressedTotal = 0;
  let summaryTurn = -1;
  let lastTurn = -1;

  // The open stretch: everything up to its last slow gap, and the frames since it (dropped if it recovers).
  let open = false;
  let start = 0;
  let lastSlow = 0;
  let sFrames = 0;
  let sWorst = 0;
  let sOver50 = 0;
  let sOver100 = 0;
  let sFreeze = false;
  let tailFrames = 0;
  // What the board was doing at the stretch's worst frame so far, and the page's facts as last read.
  let board: Data = {};
  let pageRead: Data = {};
  let pageReadAt = -Infinity;

  // Reports.
  let n = 0;
  let reports = 0;
  let lastReportAt = -Infinity;
  let suppressed = 0;

  let last = -1;
  let handle: number | null = null;
  let disposed = false;
  // When the page last drew something new; while the loop is stopped, the heartbeat and when it is due.
  let lastWake = now();
  let asleep = false;
  let beat: number | null = null;
  let beatDue = 0;

  const long: LongFrame[] = [];
  let observer: InstanceType<ObserverClass> | null = null;
  const keep = (entries: readonly unknown[]): void => {
    for (const e of entries) {
      long.push(e as LongFrame);
      if (long.length > LONG_KEEP) long.shift();
    }
  };
  if (Observer != null && attribution !== 'none') {
    observer = new Observer((list) => keep(list.getEntries()));
    observer.observe({ type: attribution === 'loaf' ? 'long-animation-frame' : 'longtask' });
  }

  function openStretch(t: number, gap: number): void {
    open = true;
    // From the start of the oldest slow gap in the window — or this gap alone, for a freeze.
    const oldest = slowAt >= SLOW_IN_WINDOW ? slowAt % SLOW_IN_WINDOW : -1;
    const windowStart = oldest >= 0 && t - slowEnds[oldest]! <= WINDOW_MS ? slowEnds[oldest]! - slowGaps[oldest]! : t - gap;
    start = Math.min(windowStart, t - gap);
    sFreeze = false;
    sFrames = 0;
    sWorst = 0;
    sOver50 = 0;
    sOver100 = 0;
    tailFrames = 0;
    // The frames already inside the stretch, this one included, newest first.
    for (let k = 0; k < RING; k += 1) {
      const i = (at - 1 - k + RING) % RING;
      if (ends[i]! <= start || ends[i] === 0) break;
      count(gaps[i]!);
    }
    lastSlow = t;
    workAtOpen = new Map(work());
    snapshot(t);
  }

  /** The board as it is now, `t` into the stretch, only at a new worst; the page's facts at most every {@link PAGE_EVERY_MS}. */
  function snapshot(t: number): void {
    if (t - pageReadAt >= PAGE_EVERY_MS) {
      pageRead = page();
      pageReadAt = t;
    }
    board = { atMs: Math.round(t - start), ...host.board(), ...pageRead };
  }

  function count(gap: number): void {
    sFrames += 1;
    if (gap > sWorst) sWorst = gap;
    if (gap > SLOW_MS) sOver50 += 1;
    if (gap > VERY_SLOW_MS) sOver100 += 1;
    if (gap > FREEZE_MS) sFreeze = true;
  }

  function closeStretch(why: 'recovered' | 'hidden' | 'max' | 'end'): void {
    open = false;
    stretches += 1;
    n += 1;
    const end = lastSlow;
    if (reports >= MAX_REPORTS || end - lastReportAt < REPORT_EVERY_MS) {
      suppressed += 1;
      suppressedTotal += 1;
      return;
    }
    reports += 1;
    lastReportAt = end;
    const ms = Math.max(1, end - start);
    if (observer?.takeRecords !== undefined) keep(observer.takeRecords());
    const inside = long.filter((e) => e.startTime < end && e.startTime + e.duration > start);
    host.report({
      what: 'stretch',
      n,
      ms: Math.round(ms),
      frames: sFrames,
      worstMs: Math.round(sWorst),
      over50: sOver50,
      over100: sOver100,
      fps: Math.round((sFrames * 10_000) / ms) / 10,
      freeze: sFreeze,
      suppressed,
      attribution,
      longs: inside.length,
      longMaxMs: Math.round(inside.reduce((m, e) => Math.max(m, e.duration), 0)),
      why,
      window: `${win.innerWidth}x${win.innerHeight}`,
    });
    suppressed = 0;
    host.report({ what: 'board', n, ...board });
    // Our own work inside the stretch, by label; the rest of its frames' time was the browser's.
    const spentIn: Data = {};
    let ours = 0;
    for (const [label, total] of work()) {
      const inStretch = total - (workAtOpen.get(label) ?? 0);
      if (inStretch <= 0) continue;
      spentIn[label] = Math.round(inStretch);
      ours += inStretch;
    }
    host.report({ what: 'work', n, ms: Math.round(ms), ours: Math.round(ours), oursPct: Math.round((ours * 100) / ms), ...spentIn });
    if (attribution !== 'loaf') return;
    [...inside]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, TOP_LONG_FRAMES)
      .forEach((e, i) => host.report({ what: 'loaf', n, rank: i + 1, ...loafFields(e, start) }));
  }

  function tick(t: number): void {
    const began = now();
    handle = null;
    // The first frame after a start has no gap of its own; one after a wake is timed from it.
    if (last >= 0) time(t, began);
    last = t;
    if (!open && t - lastWake >= QUIET_MS) sleep();
    else handle = raf(tick);
  }

  function time(t: number, began: number): void {
    const gap = t - last;
    gaps[at] = gap;
    ends[at] = t;
    at = (at + 1) % RING;
    frames += 1;
    watchedMs += gap;
    if (gap > worst) worst = gap;
    histogram[bucketOf(gap)]! += 1;
    if (phaseNow === null) {
      phaseNow = { frames: 0, ms: 0, drops: 0, slow: 0, worst: 0 };
      phases.set(phase, phaseNow);
    }
    phaseNow.frames += 1;
    phaseNow.ms += gap;
    if (gap > DROP_MS) phaseNow.drops += 1;
    if (gap > SLOW_MS) phaseNow.slow += 1;
    if (gap > phaseNow.worst) phaseNow.worst = gap;
    // The monitor's own cost is timed on frames outside a stretch: a stretch's reads and reports are its cost, not a frame's.
    const plain = !open;
    if (gap > DROP_MS) {
      slowEnds[slowAt % SLOW_IN_WINDOW] = t;
      slowGaps[slowAt % SLOW_IN_WINDOW] = gap;
      slowAt += 1;
      if (open) {
        sFrames += tailFrames;
        tailFrames = 0;
        if (gap > sWorst) snapshot(t);
        count(gap);
        lastSlow = t;
      } else if (gap > FREEZE_MS || (slowAt >= SLOW_IN_WINDOW && t - slowEnds[slowAt % SLOW_IN_WINDOW]! <= WINDOW_MS)) {
        openStretch(t, gap);
      }
      if (open && t - start >= MAX_STRETCH_MS) closeStretch('max');
    } else if (open) {
      tailFrames += 1;
      if (t - lastSlow >= RECOVER_MS) closeStretch('recovered');
    }
    if (plain && !open) {
      selfMs += now() - began;
      selfFrames += 1;
    }
  }

  function startLoop(): void {
    if (disposed || handle !== null || doc.visibilityState === 'hidden') return;
    stopBeat();
    lastWake = now();
    last = -1;
    handle = raf(tick);
  }

  function stopLoop(): void {
    if (handle !== null) caf(handle);
    handle = null;
    last = -1;
    stopBeat();
  }

  /** Nothing drawn for a while: no more frames asked for, the heartbeat instead. */
  function sleep(): void {
    asleep = true;
    armBeat();
  }

  function armBeat(): void {
    beatDue = now() + HEARTBEAT_MS;
    beat = timer.set(onBeat, HEARTBEAT_MS);
  }

  function stopBeat(): void {
    if (beat !== null) timer.clear(beat);
    beat = null;
    asleep = false;
  }

  /** A heartbeat that ran over a freeze late: the main thread was held, timed as a frame from when it was due. */
  function onBeat(): void {
    beat = null;
    if (now() - beatDue > FREEZE_MS) wakeFrom(beatDue);
    else armBeat();
  }

  /** The page drew something new: the loop runs again, its first frame timed from `from`. */
  function wakeFrom(from: number): void {
    if (disposed || doc.visibilityState === 'hidden') return;
    stopBeat();
    lastWake = now();
    last = from;
    if (handle === null) handle = raf(tick);
  }

  function onActivity(): void {
    lastWake = now();
    // A change made while the main thread was held past the heartbeat's due time is timed from that time.
    if (asleep) wakeFrom(Math.min(lastWake, beatDue));
  }

  function onVisibility(): void {
    if (doc.visibilityState === 'hidden') {
      stopLoop();
      if (open) closeStretch('hidden');
    } else startLoop();
  }

  function summary(why: 'turns' | 'over' | 'end'): void {
    if (frames === 0) return;
    host.report({
      what: 'summary',
      why,
      fromTurn: summaryTurn,
      turn: lastTurn,
      frames,
      watchedMs: Math.round(watchedMs),
      fps: Math.round((frames * 10_000) / Math.max(1, watchedMs)) / 10,
      p50: percentile(histogram, frames, 0.5),
      p95: percentile(histogram, frames, 0.95),
      p99: percentile(histogram, frames, 0.99),
      worstMs: Math.round(worst),
      stretches,
      reports,
      suppressed: suppressedTotal,
      // The monitor's own cost per frame, in µs: what it adds to every frame it times.
      selfUs: Math.round((selfMs * 100_000) / Math.max(1, selfFrames)) / 100,
      attribution,
    });
    const byPhase: Data = {};
    for (const [name, p] of [...phases].sort((a, b) => b[1].frames - a[1].frames).slice(0, PHASE_FIELDS)) byPhase[name.slice(0, 32)] = phaseField(p);
    host.report({ what: 'phases', ...byPhase });
    phases.clear();
    phaseNow = null;
    histogram.fill(0);
    frames = 0;
    watchedMs = 0;
    worst = 0;
    selfMs = 0;
    selfFrames = 0;
    stretches = 0;
    suppressedTotal = 0;
    summaryTurn = lastTurn;
  }

  /** A tab closing runs no effect cleanup: what it saw is sent as it goes. */
  function onPageHide(): void {
    if (open) closeStretch('end');
    summary('end');
  }

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  const unwake = wakeOn(onActivity);
  startLoop();

  return {
    noteTurn(turn: number): void {
      if (turn === lastTurn) return;
      lastTurn = turn;
      if (summaryTurn < 0) summaryTurn = turn;
      else if (turn - summaryTurn >= SUMMARY_EVERY_TURNS) summary('turns');
    },
    notePhase(next: string): void {
      if (next === phase) return;
      phase = next;
      phaseNow = phases.get(next) ?? null;
    },
    noteGameOver(): void {
      summary('over');
    },
    dispose(): void {
      if (disposed) return;
      stopLoop();
      disposed = true;
      unwake();
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pagehide', onPageHide);
      observer?.disconnect();
      if (open) closeStretch('end');
      summary('end');
    },
  };
}
