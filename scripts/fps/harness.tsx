/*
 * The browser-fps harness: the REAL `LiveBoard`, in the shell `MatchScreen` mounts it in, fed by an
 * in-page transport that answers the join with a scenario's packets and then streams loop packets on a
 * timer — the same envelopes, cursors and parse path a socket delivers. Never shipped: built only by
 * `scripts/fps/vite.config.ts`, driven by `scripts/fps/measure.mjs`.
 *
 * Query: ?size=early|mid|crowded|huge&flyers=0|1&hand=N&art=0|1&noanim=0|1
 *
 * `noanim=1` turns every CSS animation and transition in the app off: the A/B for what the board's
 * motion costs altogether.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../../apps/ui/src/styles.css';
import { LiveBoard } from '../../apps/ui/src/play/live/LiveBoard.tsx';
import { clearArrow, drawArrow } from '../../apps/ui/src/play/live/gestures/arrow.ts';
import { startMatch, type MatchTransport } from '../../apps/ui/src/play/live/match.ts';
import { MATCH_EVENTS } from '../../apps/ui/src/play/live/transport.ts';

import { buildScenario, type BoardSize, type Packet } from './scenarios.ts';

const params = new URLSearchParams(window.location.search);
const scenario = buildScenario({
  size: (params.get('size') ?? 'mid') as BoardSize,
  flyers: params.get('flyers') !== '0',
  hand: Number(params.get('hand') ?? '10'),
  art: params.get('art') !== '0',
});

const MATCH = 'fps-match';
const EPOCH = 'fps-epoch';
const handlers = new Map<string, Set<(payload: unknown) => void>>();
const history: unknown[] = [];
let cursor = 0;
let sent = 0;
const frameOf = (packet: Packet): unknown => ({ kind: 'notify', method: 'applyDelta', payload: { packet } });
for (const p of scenario.packets) history.push(frameOf(p));

const fire = (event: string, payload: unknown): void => {
  for (const h of handlers.get(event) ?? []) h(payload);
};

const transport: MatchTransport = {
  on(event, handler) {
    let set = handlers.get(event);
    if (set === undefined) handlers.set(event, (set = new Set()));
    set.add(handler);
  },
  emit() {
    sent += 1;
  },
  request(_event, _payload, onAck) {
    setTimeout(() => {
      cursor = history.length;
      onAck(null, { matchId: MATCH, seat: 0, playerId: 0, cursor: { epoch: EPOCH, seq: cursor }, frames: history });
      fire(MATCH_EVENTS.role, { matchId: MATCH, role: 'player' });
      fire('connect', undefined);
    }, 0);
  },
  disconnect() {},
};

function deliver(packet: Packet): void {
  cursor += 1;
  fire(MATCH_EVENTS.serverToClient, { matchId: MATCH, cursor: { epoch: EPOCH, seq: cursor }, frame: frameOf(packet) });
}

/* ── the recorder ── */
interface Recording {
  frames: number[];
  longtasks: number[];
  loaf: { duration: number; script: number; styleLayout: number; render: number; blocking: number }[];
  events: { name: string; duration: number; processing: number }[];
  inputs: number[];
}
let rec: Recording | null = null;
let lastFrame = 0;
const onFrame = (t: number): void => {
  if (rec !== null && lastFrame > 0) rec.frames.push(t - lastFrame);
  lastFrame = t;
  requestAnimationFrame(onFrame);
};
requestAnimationFrame(onFrame);

const observe = (type: string, fn: (e: PerformanceEntry) => void, extra: Record<string, unknown> = {}): void => {
  if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
  new PerformanceObserver((list) => {
    if (rec !== null) for (const e of list.getEntries()) fn(e);
  }).observe({ type, buffered: false, ...extra } as PerformanceObserverInit);
};
observe('longtask', (e) => rec!.longtasks.push(e.duration));
observe('long-animation-frame', (e) => {
  const f = e as PerformanceEntry & { renderStart: number; styleAndLayoutStart: number; blockingDuration: number; scripts: { duration: number }[] };
  const end = e.startTime + e.duration;
  rec!.loaf.push({
    duration: e.duration,
    script: f.scripts.reduce((s, x) => s + x.duration, 0),
    styleLayout: f.styleAndLayoutStart > 0 ? end - f.styleAndLayoutStart : 0,
    render: f.renderStart > 0 ? end - f.renderStart : 0,
    blocking: f.blockingDuration,
  });
});
observe(
  'event',
  (e) => {
    const t = e as PerformanceEventTiming;
    if (/pointer|mouse|click|touch/.test(t.name)) rec!.events.push({ name: t.name, duration: t.duration, processing: t.processingEnd - t.processingStart });
  },
  { durationThreshold: 16 },
);
// Input → next paint, measured the same way in every browser: the event's own timestamp to the
// frame after the one its handlers ran before (two rAFs: the second fires once the first has painted).
for (const type of ['pointerdown', 'pointerover']) {
  window.addEventListener(
    type,
    (e) => {
      if (rec === null) return;
      const at = e.timeStamp;
      const r = rec;
      requestAnimationFrame(() => requestAnimationFrame((t) => r.inputs.push(t - at)));
    },
    { capture: true },
  );
}

if (params.get('noanim') === '1') {
  const off = document.createElement('style');
  off.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.append(off);
}

/*
 * The targeter, drawn by the real `drawArrow` from this seat's first hand card to the other seat's
 * first battlefield card. `still`: snapped to it and left there, so all that moves is the arrow's
 * own CSS. `sweep`: the tip circles the target unsnapped, re-shaped every frame as a pointer would.
 */
let aimTimer = 0;
const centre = (el: Element): { x: number; y: number } => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
function aim(how: 'still' | 'sweep' | 'off'): void {
  cancelAnimationFrame(aimTimer);
  const overlay = document.querySelector<HTMLElement>('[data-board-overlay]');
  if (how === 'off' || overlay === null) {
    clearArrow(overlay);
    return;
  }
  const tail = document.querySelector('[data-zone="hand"][data-owner="you"] [data-board-card]');
  const snap = document.querySelector('[data-zone="battlefield"][data-owner="them"] [data-board-card]');
  if (tail === null || snap === null) throw new Error('aim: no hand card or no opposing battlefield card');
  const draw = (t: number): void => {
    const at = centre(snap);
    const to = how === 'still' ? at : { x: at.x + Math.cos(t / 400) * 140, y: at.y + Math.sin(t / 400) * 60 };
    drawArrow(overlay, { from: centre(tail), to, source: null, target: how === 'still' ? { kind: 'card', id: 0 } : null, snap: how === 'still' ? snap : null, tail: null, mode: 'click' });
    // Every frame either way: the gesture layer's own paints clear a targeter nobody is driving, and
    // a still one redrawn unchanged writes nothing (`positionArrow` skips an unchanged shape).
    aimTimer = requestAnimationFrame(draw);
  };
  draw(performance.now());
}

let loopTimer: ReturnType<typeof setInterval> | null = null;
const api = {
  counts: scenario.counts,
  loops: Object.keys(scenario.loops),
  sent: () => sent,
  aim,
  /** Start one loop, one packet every `periodMs`. */
  loop(name: string, periodMs: number): void {
    api.stop();
    const step = scenario.loops[name];
    if (step === undefined) throw new Error(`no loop ${name}; have ${Object.keys(scenario.loops).join(', ')}`);
    loopTimer = setInterval(() => deliver(step()), periodMs);
  },
  stop(): void {
    if (loopTimer !== null) clearInterval(loopTimer);
    loopTimer = null;
  },
  start(): void {
    rec = { frames: [], longtasks: [], loaf: [], events: [], inputs: [] };
  },
  take(): Recording | null {
    const r = rec;
    rec = null;
    return r;
  },
};
(window as unknown as { fps: typeof api }).fps = api;

const root = document.getElementById('root');
if (!root) throw new Error('harness.html is missing #root');
const match = startMatch({ matchId: MATCH, transport });
createRoot(root).render(
  <StrictMode>
    <div className="shell shell--match" data-testid="match" style={{ position: 'relative' }}>
      <LiveBoard match={match} />
    </div>
  </StrictMode>,
);
