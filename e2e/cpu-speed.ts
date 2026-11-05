/**
 * How much slower this machine's browser runs a fixed piece of script than the reference host's: a frame
 * budget measured on a fast desktop is scaled by it on a slow CI runner, so a spec's long-frame limit
 * means the same work everywhere. The workload is deterministic (a seeded sort, object allocation and
 * string building, the kinds of work a React render does); the median of five runs is compared with
 * `REFERENCE_MS`, measured on hokon at load under 5 (2026-11-02). Never below 1: a faster machine keeps
 * the limit as written.
 *
 * Both sides are timed on the renderer's main-thread CPU clock (Chromium's `ThreadTime` metric), not
 * the wall: a CI runner shares its cores with other jobs, and a task the scheduler set aside for 200 ms
 * did not get 200 ms slower. Read on the wall, the workload sampled a quiet moment and the frame a
 * busy one (or the other way round), and the two moved apart: claw-9 drew a 343 ms frame at a factor
 * of 2.5 while claw-4 drew 348 ms at 6.5. `mainThreadTasks` times a spec's own tasks on the same clock.
 * (CDP's CPU throttle is no stand-in for that load: the time it takes is counted as the thread's.)
 */
import type { CDPSession, Page } from '@playwright/test';

/** The workload's median on the reference host: 19.3, 19.8, 17.6 ms on the wall at load under 5; 19.4–21.4 ms of thread CPU at load 7. */
export const REFERENCE_MS = 19;

async function session(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  return cdp;
}

/** The renderer main thread's CPU time so far, in milliseconds. */
async function threadMs(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const time = metrics.find((m) => m.name === 'ThreadTime');
  if (time === undefined) throw new Error('Chromium reported no ThreadTime metric');
  return time.value * 1000;
}

/** The workload's median on this page, in thread-CPU milliseconds. */
export async function cpuWorkloadMs(page: Page): Promise<number> {
  const cdp = await session(page);
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const before = await threadMs(cdp);
    await page.evaluate(() => {
      let seed = 12345;
      const random = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const numbers = new Float64Array(200_000).map(random);
      numbers.sort();
      const rows = Array.from({ length: 40_000 }, (_, i) => ({ id: i, name: `card ${i}`, power: numbers[i]! * 10 }));
      rows.sort((a, b) => a.power - b.power);
      let text = '';
      for (const r of rows) text += r.name.length > 6 ? r.name[5] : '';
      return text.length;
    });
    times.push((await threadMs(cdp)) - before);
  }
  await cdp.detach();
  return times.sort((a, b) => a - b)[2]!;
}

/** This machine's slowness against the reference host: the workload's median over the reference's, at least 1. */
export async function cpuFactor(page: Page): Promise<{ factor: number; workloadMs: number }> {
  const workloadMs = await cpuWorkloadMs(page);
  return { factor: Math.max(1, workloadMs / REFERENCE_MS), workloadMs };
}

/** One task the page's renderer main thread ran: how long it took on the wall, and on the thread's CPU. */
export interface MainThreadTask {
  wallMs: number;
  cpuMs: number;
}

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  dur?: number;
  tdur?: number;
  args?: { name?: string; data?: { frames?: { processId?: number; url?: string; parent?: string }[] } };
}

/**
 * Records every task of `page`'s renderer main thread from now until the returned `stop` is called
 * (a Chromium trace, `toplevel` only), with its thread-CPU time beside its wall time. Tasks under 1 ms
 * are left out.
 */
export async function mainThreadTasks(page: Page): Promise<() => Promise<MainThreadTask[]>> {
  const cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', ({ value }) => events.push(...(value as unknown as TraceEvent[])));
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: ['toplevel', 'disabled-by-default-devtools.timeline', '__metadata'] },
    transferMode: 'ReportEvents',
  });
  return async () => {
    const complete = new Promise<void>((done) => cdp.once('Tracing.tracingComplete', () => done()));
    await cdp.send('Tracing.end');
    await complete;
    await cdp.detach();
    const started = events.find((e) => e.name === 'TracingStartedInBrowser');
    const pid = started?.args?.data?.frames?.find((f) => f.parent === undefined && f.url === page.url())?.processId;
    if (pid === undefined) throw new Error(`the trace does not name the page's renderer: ${JSON.stringify(started?.args)}`);
    const main = events.find((e) => e.name === 'thread_name' && e.pid === pid && e.args?.name === 'CrRendererMain');
    if (main === undefined) throw new Error("the trace has no main thread for the page's renderer");
    return events
      .filter((e) => e.ph === 'X' && e.pid === pid && e.tid === main.tid && e.name === 'ThreadControllerImpl::RunTask' && (e.dur ?? 0) >= 1000)
      .map((e) => ({ wallMs: (e.dur ?? 0) / 1000, cpuMs: (e.tdur ?? e.dur ?? 0) / 1000 }));
  };
}
