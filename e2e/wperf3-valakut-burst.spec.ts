/**
 * Valakut's ten-trigger burst, measured: ten triggers resolve one after another, thirty damage, at normal
 * pace (Fast Mode off). Filmed on main (trailer clip "valakut", the 'targeted' phase) it skipped about 4 s
 * even on a quiet host.
 *
 * `wperf3-valakut.state`: alice's Splendid Reclamation returns ten Mountains, Valakut triggers ten times;
 * one "same target for all" pick sends them all at bob (40, so all ten resolve). From that pick until bob
 * reads 10, on alice's screen: every long animation frame (over 50 ms, with its own rendering and its
 * scripts), the socket messages by kind, every list of the board's animations (each brings the page's
 * style up to date), and a CPU profile — busy and script time a message, the hot functions with their
 * callers, and what runs inside the long tasks — mapped through the bundle's source map. `[wperf3]` lines
 * are the evidence.
 *
 * Red when the board's animations are listed more than once a message. Every view waits on its beats
 * twice, and each wait used to list them on its own, round after round, each in its own task: 1,633 and
 * 1,883 lists for 136 messages on main (hokon), 95 and 106 since one look a frame serves every wait
 * (`../games/magic/ui/src/play/motion.ts`). The long frames that remain are each one resolution's own render
 * and effects (~55–70 ms on hokon), logged, not judged here.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { cpuSpeedAround, describeCpu } from './cpu-speed.ts';
import { clickHandCard, makeTitled, offeredNamed, pressPaymentAuto, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { turnFastModeOff } from './play/prefs.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const TRIGGERS = 10;
const START = 40;
const TARGET = /^Valakut, the Molten Pinnacle\b/;
const DEAL = /^Do you want to deal 3 damage/;
const asksTarget = (text: string): boolean => /Valakut, the Molten Pinnacle/.test(text) && !DEAL.test(text) && !/^Priority/.test(text);

declare global {
  interface Window {
    wperf3: {
      recording: boolean;
      messages: number;
      kinds: Record<string, number>;
      lists: number;
      listMs: number;
      handlerMs: number;
      worstHandlerMs: number;
      frames: { ms: number; render: number; scripts: { invoker: string; ms: number; forced: number }[] }[];
    };
  }
}

/** Times every WebSocket message handler on the page, and records long animation frames, while `recording`. */
function instrument(): void {
  window.wperf3 = { recording: false, messages: 0, kinds: {}, lists: 0, listMs: 0, handlerMs: 0, worstHandlerMs: 0, frames: [] };
  // Every list of an element's animations (each brings the page's style up to date first), counted and timed.
  const list = Element.prototype.getAnimations;
  Element.prototype.getAnimations = function (this: Element, options?: GetAnimationsOptions) {
    if (!window.wperf3.recording) return list.call(this, options);
    const t = performance.now();
    try {
      return list.call(this, options);
    } finally {
      window.wperf3.lists += 1;
      window.wperf3.listMs += performance.now() - t;
    }
  };
  const timed = (fn: (this: WebSocket, ev: MessageEvent) => unknown) =>
    function (this: WebSocket, ev: MessageEvent) {
      if (!window.wperf3.recording) return fn.call(this, ev);
      const data = typeof ev.data === 'string' ? ev.data : '';
      const kind = `${/^\d+(?:\["([^"]+)")?/.exec(data)?.[1] ?? data.slice(0, 2)} ${/"method":"(\w+)"/.exec(data.slice(0, 400))?.[1] ?? ''}`.trim();
      window.wperf3.kinds[kind] = (window.wperf3.kinds[kind] ?? 0) + 1;
      const t = performance.now();
      try {
        return fn.call(this, ev);
      } finally {
        const ms = performance.now() - t;
        window.wperf3.messages += 1;
        window.wperf3.handlerMs += ms;
        window.wperf3.worstHandlerMs = Math.max(window.wperf3.worstHandlerMs, ms);
      }
    };
  const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!;
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true,
    get: desc.get,
    set(fn) {
      desc.set!.call(this, typeof fn === 'function' ? timed(fn) : fn);
    },
  });
  const add = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (this: WebSocket, type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
    const listener = type === 'message' && typeof fn === 'function' ? (timed(fn as (this: WebSocket, ev: MessageEvent) => unknown) as EventListener) : fn;
    return listener === null ? undefined : add.call(this, type, listener, opts);
  } as typeof add;
  new PerformanceObserver((list) => {
    if (!window.wperf3.recording) return;
    for (const e of list.getEntries() as (PerformanceEntry & { renderStart: number; scripts: (PerformanceEntry & { invoker: string; forcedStyleAndLayoutDuration: number })[] })[]) {
      window.wperf3.frames.push({
        ms: Math.round(e.duration),
        // The frame's own rendering: rAF callbacks, style, layout and paint, from its render start to its end.
        render: e.renderStart > 0 ? Math.round(e.startTime + e.duration - e.renderStart) : 0,
        scripts: e.scripts.map((s) => ({ invoker: s.invoker, ms: Math.round(s.duration), forced: Math.round(s.forcedStyleAndLayoutDuration) })),
      });
    }
  }).observe({ type: 'long-animation-frame', buffered: false });
}

interface ProfileNode {
  id: number;
  children?: number[];
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
}

/** A sampled frame's key: where it is and its name. */
const keyOf = (f: ProfileNode['callFrame']): string => `${f.url}|${f.lineNumber}|${f.columnNumber}|${f.functionName}`;

/**
 * The profile's top functions by self time, each mapped to its source file and line when the bundle has a
 * map; then, for each browser built-in among them (a style or layout read), the app functions that call it
 * — the nearest app frame up its stack — by the time spent under them; and the busy total.
 */
async function topFunctions(page: Page, profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }, count: number, messages: number): Promise<string[]> {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map<string, number>();
  const callers = new Map<string, Map<string, number>>();
  /** Time under each app function (anywhere up the stack, once a sample). */
  const under = new Map<string, number>();
  /** The same, inside long tasks only: a run of busy samples over `LONG_TASK_MS`, idle-bounded. */
  const inLong = new Map<string, number>();
  const LONG_TASK_MS = 40;
  let task: { ms: number; keys: Map<string, number> } = { ms: 0, keys: new Map() };
  let longTasks = 0;
  const endTask = (): void => {
    if (task.ms > LONG_TASK_MS) {
      longTasks += 1;
      for (const [k, ms] of task.keys) inLong.set(k, (inLong.get(k) ?? 0) + ms);
    }
    task = { ms: 0, keys: new Map() };
  };
  let idle = 0;
  let total = 0;
  /** The browser's own work (style, layout, paint: `(program)`) and its garbage collection. */
  let native = 0;
  profile.samples.forEach((id, i) => {
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    const f = byId.get(id)!.callFrame;
    total += ms;
    if (f.functionName === '(idle)') idle += ms;
    if (f.functionName === '(program)' || f.functionName === '(garbage collector)') native += ms;
    const key = keyOf(f);
    self.set(key, (self.get(key) ?? 0) + ms);
    if (f.functionName === '(idle)') endTask();
    else task.ms += ms;
    const seen = new Set<string>();
    for (let up: number | undefined = id; up !== undefined; up = parent.get(up)) {
      const frame = byId.get(up)!.callFrame;
      if (frame.url === '' || !frame.url.includes('/assets/')) continue;
      const k = keyOf(frame);
      if (seen.has(k)) continue;
      seen.add(k);
      under.set(k, (under.get(k) ?? 0) + ms);
      task.keys.set(k, (task.keys.get(k) ?? 0) + ms);
    }
    if (f.url === '' && !f.functionName.startsWith('(')) {
      let up = parent.get(id);
      while (up !== undefined && byId.get(up)!.callFrame.url === '') up = parent.get(up);
      if (up !== undefined) {
        const by = callers.get(key) ?? new Map<string, number>();
        const ck = keyOf(byId.get(up)!.callFrame);
        by.set(ck, (by.get(ck) ?? 0) + ms);
        callers.set(key, by);
      }
    }
  });
  const ui = resolve(import.meta.dirname, '../apps/ui');
  const viteEntry = createRequire(resolve(ui, 'package.json')).resolve('vite');
  const { SourceMapConsumer } = createRequire(createRequire(viteEntry).resolve('postcss'))('source-map-js') as {
    SourceMapConsumer: new (map: unknown) => { originalPositionFor(p: { line: number; column: number }): { source: string | null; line: number | null } };
  };
  const maps = new Map<string, InstanceType<typeof SourceMapConsumer> | null>();
  const name = async (key: string): Promise<string> => {
    const [url, line, col, fn] = key.split('|') as [string, string, string, string];
    let where = url === '' ? '' : url.split('/').pop()!;
    if (url.endsWith('.js')) {
      if (!maps.has(url)) maps.set(url, await page.request.get(`${url}.map`).then(async (r) => (r.ok() ? new SourceMapConsumer(await r.json()) : null)).catch(() => null));
      const pos = maps.get(url)?.originalPositionFor({ line: Number(line) + 1, column: Number(col) });
      if (pos?.source) where = `${pos.source.split('/').slice(-2).join('/')}:${pos.line}`;
    }
    return `${fn || '(anonymous)'} ${where}`;
  };
  const busy = total - idle;
  const script = busy - native;
  const per = (ms: number): string => (ms / Math.max(1, messages)).toFixed(1);
  const out: string[] = [
    `busy ${busy.toFixed(0)} ms of ${total.toFixed(0)} ms profiled (script ${script.toFixed(0)} ms); a message: ${per(busy)} ms busy, ${per(script)} ms script`,
  ];
  endTask();
  for (const [key, ms] of [...under].sort((a, b) => b[1] - a[1]).slice(0, count)) out.push(`under ${ms.toFixed(1)} ms ${await name(key)}`);
  out.push(`long tasks (over ${LONG_TASK_MS} ms busy): ${longTasks}`);
  for (const [key, ms] of [...inLong].sort((a, b) => b[1] - a[1]).slice(0, 2 * count)) out.push(`in long ${ms.toFixed(1)} ms ${await name(key)}`);
  for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, count)) {
    out.push(`self ${ms.toFixed(1)} ms ${await name(key)}`);
    const by = callers.get(key);
    if (by !== undefined) for (const [ck, cms] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 4)) out.push(`  called by ${cms.toFixed(1)} ms ${await name(ck)}`);
  }
  return out;
}

test(titled('Valakut’s ten triggers resolve at normal pace: the caster’s screen lists the board’s animations at most once a message, and its frames are measured'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'wperf3-valakut', { beforeAlice: async (page) => void (await page.addInitScript(instrument)) });
    await turnFastModeOff(alice.page, stack, 0);
    await turnFastModeOff(bob.page, stack, 1);
    const bobFace = alice.page.locator('[data-player-face]:not([data-viewer])');
    const bobLife = alice.page.locator('.seat:not([data-viewer]) [data-testid="life"]');
    await expect(bobLife).toHaveText(String(START), { timeout: 60_000 });

    let reclamation: number | undefined;
    await expect.poll(async () => (reclamation = await offeredNamed(alice.page, 'Splendid Reclamation')), { timeout: 60_000, message: 'alice is offered Splendid Reclamation' }).not.toBeUndefined();
    const fromCast = serverLog(stack).length;
    const wiredTargets = () =>
      serverLog(stack)
        .slice(fromCast)
        .filter((r) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'showPromptMessage' && TARGET.test(String(r.message ?? '')) && !DEAL.test(String(r.message ?? '')));
    await clickHandCard(alice.page, reclamation!);
    await expect
      .poll(
        async () => {
          await pressPaymentAuto(alice.page);
          await answerPrompt(alice.page);
          const ok = bob.page.locator('[data-testid="live-decision-ok"]:enabled');
          if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
          return wiredTargets().length > 0 && asksTarget(await says(alice.page));
        },
        { timeout: 90_000, message: "alice's first Valakut target question is up" },
      )
      .toBe(true);
    await alice.page.waitForTimeout(1_000);
    const speed = await cpuSpeedAround(alice.page);

    // The burst: from the one pick until bob reads 10.
    const cdp = await alice.page.context().newCDPSession(alice.page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
    await alice.page.evaluate(() => (window.wperf3.recording = true));
    const started = Date.now();
    const same = alice.page.getByTestId('live-same-target');
    if ((await same.count()) > 0) await same.check();
    await bobFace.click();
    await expect
      .poll(
        async () => {
          const text = await says(alice.page);
          const yes = alice.page.getByTestId('prompt-confirm-yes');
          if (DEAL.test(text) && (await yes.count()) > 0) await yes.click({ timeout: 1_000 }).catch(() => undefined);
          else if (asksTarget(text)) await bobFace.click({ timeout: 1_000 }).catch(() => undefined);
          return bobLife.textContent();
        },
        { timeout: 120_000, intervals: [250], message: 'every Valakut trigger dealt bob 3' },
      )
      .toBe(String(START - 3 * TRIGGERS));
    // The last number's frame is reported once it ends.
    await alice.page.waitForTimeout(1_500);
    const took = Date.now() - started;
    const rec = await alice.page.evaluate(() => {
      window.wperf3.recording = false;
      return window.wperf3;
    });
    const { profile } = (await cdp.send('Profiler.stop')) as { profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] } };
    const cpu = await speed.after();

    const longest = Math.max(0, ...rec.frames.map((f) => f.ms));
    const over = (ms: number) => rec.frames.filter((f) => f.ms > ms).length;
    const scriptBy = new Map<string, number>();
    for (const f of rec.frames) for (const s of f.scripts) scriptBy.set(s.invoker, (scriptBy.get(s.invoker) ?? 0) + s.ms);
    console.log(`[wperf3] ${describeCpu(cpu)}`);
    console.log(`[wperf3] valakut burst: ${took} ms from the pick to bob at ${START - 3 * TRIGGERS} (+1.5 s); load ${(await import('node:os')).loadavg().map((l) => l.toFixed(1)).join(' ')}`);
    console.log(`[wperf3] animation lists ${rec.lists}, ${rec.listMs.toFixed(1)} ms; message kinds ${JSON.stringify(rec.kinds)}`);
    console.log(`[wperf3] messages ${rec.messages}, handler time ${rec.handlerMs.toFixed(1)} ms, ${(rec.handlerMs / Math.max(1, rec.messages)).toFixed(2)} ms a message, worst ${rec.worstHandlerMs.toFixed(1)} ms`);
    console.log(`[wperf3] long frames: ${rec.frames.length} (over 100 ms: ${over(100)}), longest ${longest} ms, total ${rec.frames.reduce((a, f) => a + f.ms, 0)} ms; script in them by invoker ${JSON.stringify(Object.fromEntries(scriptBy))}`);
    console.log(`[wperf3] frames ${JSON.stringify(rec.frames.map((f) => [f.ms, `render:${f.render}`, ...f.scripts.map((s) => `${s.invoker}:${s.ms}/${s.forced}`)]))}`);
    for (const line of await topFunctions(alice.page, profile, 30, rec.messages)) console.log(`[wperf3] ${line}`);
    expect(rec.lists, `the board's animations listed at most once a message (${rec.messages} messages)`).toBeLessThanOrEqual(rec.messages);
  } finally {
    await stack.stop();
  }
});
