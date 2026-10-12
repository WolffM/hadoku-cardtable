/**
 * A page's own frame clock, for specs that gate on WHEN something is drawn.
 *
 * A gate in milliseconds on a shared claw measures the claw: the same frame that takes 16 ms idle
 * takes 50 under three e2e shards, and an absolute bound reds on load while a real hold slips under
 * it on a quick runner. Counted in the page's own animation frames, "drawn on the next frame" and
 * "held for a 150 ms pacer beat" stay apart on any runner: a slow claw's frames are slow for both.
 *
 * `installFrameClock` (before the page opens the match) starts a counter that every animation
 * frame advances — first, so a recorder's own rAF tick in the same frame reads the frame it draws —
 * and stamps every `forge:s2c` message the page's socket receives with the frame it arrived in.
 * Milliseconds are kept beside every count, for the evidence lines.
 */
import type { Page } from '@playwright/test';

/** One `forge:s2c` message as the page's own socket received it. */
export interface WireStamp {
  /** `performance.timeOrigin + performance.now()`: the same clock a recorder's samples use. */
  at: number;
  /** The frame clock's count when it arrived: drawn no sooner than frame `frame + 1`. */
  frame: number;
  text: string;
}

declare global {
  interface Window {
    __frameNo: number;
    __frameAt: number[];
    __wire: WireStamp[];
  }
}

export async function installFrameClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__frameNo = 0;
    window.__frameAt = [];
    window.__wire = [];
    const now = (): number => performance.timeOrigin + performance.now();
    const tick = (): void => {
      window.__frameNo += 1;
      window.__frameAt.push(now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (e: MessageEvent) => {
          if (typeof e.data === 'string' && e.data.includes('forge:s2c')) window.__wire.push({ at: now(), frame: window.__frameNo, text: e.data });
        });
      }
    };
  });
}

/** Every stamped `forge:s2c` message so far. */
export const wireStamps = (page: Page): Promise<WireStamp[]> => page.evaluate(() => window.__wire);

/** The page's frame intervals (ms) over the last `frames` frames: what a frame costs on this runner right now. */
export async function frameIntervals(page: Page, frames = 60): Promise<{ p50: number; p95: number; n: number }> {
  const at = await page.evaluate((n) => window.__frameAt.slice(-n - 1), frames);
  const gaps = at
    .slice(1)
    .map((t, i) => t - at[i]!)
    .sort((a, b) => a - b);
  const pick = (p: number): number => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] ?? 0);
  return { p50: pick(0.5), p95: pick(0.95), n: gaps.length };
}
