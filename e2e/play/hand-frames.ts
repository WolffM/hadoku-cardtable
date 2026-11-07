/**
 * The phone hand, frame by frame: what a finger on it moved, and what the hand did under it.
 *
 * A recorder installed in the page samples every animation frame while it runs: the finger (the last
 * `pointermove`, read in the capture phase so nothing the gesture layer does hides it), the watched
 * card's box, the hand lane's `scrollLeft`, and each hand card's place in the lane's own content
 * (`left + scrollLeft`, which a scroll leaves alone and a re-layout does not). The specs judge those
 * frames: a card that jumps against the finger, a lane whose cards move while nothing moved them.
 */
import type { Page } from '@playwright/test';

import { touchDrag } from './phone.ts';

export interface HandFrame {
  t: number;
  finger: { x: number; y: number } | null;
  /** The watched card's centre and width, or null when it is not drawn. */
  card: { x: number; y: number; w: number } | null;
  lifted: string | null;
  scrollLeft: number;
  /** Every hand card's left edge in the lane's own content, by id, the watched card left out while it is lifted. */
  content: Record<string, number>;
  /** Every hand card's top, by id, the watched card left out while it is lifted. */
  tops: Record<string, number>;
}

/** Start sampling, watching `cardId` (or no card). Replaces a recorder already running. */
export async function startHandFrames(page: Page, cardId: number | null): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as { __handFrames?: { frames: unknown[]; stop: () => void } };
    w.__handFrames?.stop();
    const frames: unknown[] = [];
    let finger: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent): void => {
      finger = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointerdown', onMove, true);
    window.addEventListener('pointermove', onMove, true);
    let raf = 0;
    const tick = (t: number): void => {
      const lane = document.querySelector<HTMLElement>('[data-testid="lane-my-hand"]');
      const el = id === null ? null : document.querySelector<HTMLElement>(`[data-board-card="${id}"]`);
      const box = el?.getBoundingClientRect() ?? null;
      const laneLeft = lane?.getBoundingClientRect().left ?? 0;
      const scrollLeft = lane?.scrollLeft ?? 0;
      const content: Record<string, number> = {};
      const tops: Record<string, number> = {};
      for (const li of lane?.querySelectorAll<HTMLElement>(':scope > li.board-card') ?? []) {
        const key = li.getAttribute('data-board-card') ?? '';
        if (li.hasAttribute('data-cast-lift')) continue;
        const b = li.getBoundingClientRect();
        tops[key] = Math.round(b.top * 10) / 10;
        content[key] = Math.round((b.left - laneLeft + scrollLeft) * 10) / 10;
      }
      frames.push({
        t: Math.round(t),
        finger,
        card: box === null || box.width === 0 ? null : { x: box.left + box.width / 2, y: box.top + box.height / 2, w: box.width },
        lifted: el?.getAttribute('data-cast-lift') ?? null,
        scrollLeft,
        content,
        tops,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    w.__handFrames = {
      frames,
      stop: () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('pointerdown', onMove, true);
        window.removeEventListener('pointermove', onMove, true);
      },
    };
  }, cardId);
}

/** Stop sampling and hand back every frame. */
export async function stopHandFrames(page: Page): Promise<HandFrame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __handFrames?: { frames: unknown[]; stop: () => void } };
    w.__handFrames?.stop();
    const frames = w.__handFrames?.frames ?? [];
    delete w.__handFrames;
    return frames as HandFrame[];
  });
}

/**
 * The most a card jumped against the finger in one frame, while lifted: the change, frame to frame, of
 * where the card's centre sits relative to the finger. A card that follows the finger keeps that the
 * same; a snap, a resize or a lane scrolling under it shows here.
 */
export function worstJump(frames: readonly HandFrame[]): { px: number; at: number } {
  let worst = { px: 0, at: -1 };
  let prev: { x: number; y: number } | null = null;
  frames.forEach((f, i) => {
    if (f.lifted !== 'lifted' || f.card === null || f.finger === null) {
      prev = null;
      return;
    }
    const off = { x: f.card.x - f.finger.x, y: f.card.y - f.finger.y };
    if (prev !== null) {
      const px = Math.hypot(off.x - prev.x, off.y - prev.y);
      if (px > worst.px) worst = { px: Math.round(px * 10) / 10, at: i };
    }
    prev = off;
  });
  return worst;
}

/** The most any card that stayed in the hand moved within the lane's content between two frames: a re-layout, never a scroll. */
export function worstShift(frames: readonly HandFrame[]): { px: number; at: number; id: string } {
  let worst = { px: 0, at: -1, id: '' };
  for (let i = 1; i < frames.length; i += 1) {
    const [a, b] = [frames[i - 1]!, frames[i]!];
    for (const [id, x] of Object.entries(b.content)) {
      const was = a.content[id];
      if (was === undefined) continue;
      const px = Math.abs(x - was);
      if (px > worst.px) worst = { px: Math.round(px * 10) / 10, at: i, id };
    }
  }
  return worst;
}

/** How many distinct rows the hand's cards sit in (their tops, to the pixel). */
export function rowsOf(frame: HandFrame): number {
  return new Set(Object.values(frame.tops).map((t) => Math.round(t))).size;
}

/** One line per frame, for the run's log: the evidence a red is read from. */
export function describeFrames(frames: readonly HandFrame[], id: number | null): string {
  return frames
    .map((f, i) => {
      const finger = f.finger === null ? '-' : `${f.finger.x.toFixed(0)},${f.finger.y.toFixed(0)}`;
      const card = f.card === null ? '-' : `${f.card.x.toFixed(1)},${f.card.y.toFixed(1)} w${f.card.w.toFixed(1)}`;
      const rows = rowsOf(f);
      const own = id === null ? '' : ` own@${f.content[String(id)] ?? '-'}`;
      return `#${i} t${f.t} finger ${finger} card ${card} ${f.lifted ?? 'rest'} scroll ${f.scrollLeft.toFixed(1)} rows ${rows}${own}`;
    })
    .join('\n');
}

/** A straight line of `n` points from `a` to `b`, `a` left out. */
export const line = (a: { x: number; y: number }, b: { x: number; y: number }, n: number): { x: number; y: number }[] =>
  Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n }));

/** A finger sweeping the raised hand sideways, right to left, `n` moves a frame apart. */
export async function swipeHand(page: Page, n = 16): Promise<void> {
  const box = (await page.getByTestId('lane-my-hand').boundingBox())!;
  const y = box.y + box.height / 2;
  const from = { x: box.x + box.width - 40, y };
  await touchDrag(page, from, line(from, { x: box.x + 60, y }, n));
}

/**
 * A finger reordering card `id`: pressed at its centre, lifted straight up `up` px, then carried
 * sideways `dx` px along the hand in `n` moves, held there `holdMs`, and let go.
 */
export async function reorderByFinger(page: Page, id: number, dx: number, opts: { up?: number; n?: number; holdMs?: number } = {}): Promise<void> {
  const box = (await page.locator(`[data-board-card="${id}"]`).boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const top = { x: from.x, y: from.y - (opts.up ?? 28) };
  await touchDrag(page, from, [...line(from, top, 4), ...line(top, { x: top.x + dx, y: top.y }, opts.n ?? 24)], { holdMs: opts.holdMs });
}

/** The ids of the viewer's hand, in the order drawn. */
export function handIds(page: Page): Promise<number[]> {
  return page
    .getByTestId('lane-my-hand')
    .locator(':scope > li.board-card')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
}
