/*
 * The browser-fps harness: the REAL `LiveBoard`, in the shell `MatchScreen` mounts it in, fed by an
 * in-page transport that answers the join with a scenario's packets and then streams loop packets on a
 * timer — the same envelopes, cursors and parse path a socket delivers. Never shipped: built only by
 * `scripts/fps/vite.config.ts`, driven by `scripts/fps/measure.mjs`.
 *
 * Query: ?size=early|mid|crowded|huge&flyers=0|1&hand=N&art=0|1
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../../apps/ui/src/styles.css';
import { LiveBoard } from '../../apps/ui/src/play/live/LiveBoard.tsx';
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

let loopTimer: ReturnType<typeof setInterval> | null = null;
const api = {
  counts: scenario.counts,
  loops: Object.keys(scenario.loops),
  sent: () => sent,
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
