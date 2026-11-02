/**
 * How much slower this machine's browser runs a fixed piece of script than the reference host's: a frame
 * budget measured on a fast desktop is scaled by it on a slow CI runner, so a spec's long-frame limit
 * means the same work everywhere. The workload is deterministic (a seeded sort, object allocation and
 * string building, the kinds of work a React render does); the median of five runs is compared with
 * `REFERENCE_MS`, measured on hokon at load under 5 (2026-11-02). Never below 1: a faster machine keeps
 * the limit as written.
 */
import type { Page } from '@playwright/test';

/** The workload's median on the reference host, in milliseconds (19.3, 19.8, 17.6 over three runs; 59 at 3× CPU throttle). */
export const REFERENCE_MS = 19;

/** The workload's median on this page, in milliseconds. */
export async function cpuWorkloadMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const run = (): number => {
      const t = performance.now();
      let seed = 12345;
      const random = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const numbers = new Float64Array(200_000).map(random);
      numbers.sort();
      const rows = Array.from({ length: 40_000 }, (_, i) => ({ id: i, name: `card ${i}`, power: numbers[i]! * 10 }));
      rows.sort((a, b) => a.power - b.power);
      let text = '';
      for (const r of rows) text += r.name.length > 6 ? r.name[5] : '';
      return performance.now() - t + (text.length === 0 ? 1 : 0);
    };
    const times = Array.from({ length: 5 }, run).sort((a, b) => a - b);
    return times[2]!;
  });
}

/** This machine's slowness against the reference host: the workload's median over the reference's, at least 1. */
export async function cpuFactor(page: Page): Promise<{ factor: number; workloadMs: number }> {
  const workloadMs = await cpuWorkloadMs(page);
  return { factor: Math.max(1, workloadMs / REFERENCE_MS), workloadMs };
}
