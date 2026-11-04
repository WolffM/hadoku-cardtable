/**
 * A pointer that moves like a hand (the operator, 2026-10-30: "add a bit of randomness to simulate human
 * mouse movement"; cut 4: "a bit more randomness … it looks too robotic"). Every promo move goes through
 * {@link humanMove}: a curved path (a cubic Bézier, bowed or S-shaped), ease-in-out speed that varies from
 * move to move and step to step, an occasional hesitation partway along, an overshoot of varying size on most
 * long moves, and jitter. {@link humanRest} varies the pause between moves, with a small idle drift.
 *
 * Seeded per clip ({@link seedMouse}, called by `rig.ts`'s `startFilm`), so a re-shoot of a clip takes the
 * same paths. Playwright does not report where its pointer is, so each page's last position is kept here.
 */
import type { Page } from '@playwright/test';

export interface Point {
  x: number;
  y: number;
}

/** mulberry32: small, fast, and the same sequence for the same seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

let rand = mulberry32(hash('promo'));
const at = new WeakMap<Page, Point>();

/** Start this clip's sequence of paths and rests. */
export function seedMouse(clip: string): void {
  rand = mulberry32(hash(clip));
}

const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A point on a cubic Bézier: two control points make the S-curves a hand draws on longer moves. */
function cubic(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

async function stroke(page: Page, from: Point, to: Point, ms: number, jitter: number, hesitate: boolean): Promise<void> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / dist;
  const ny = dx / dist;
  // One bow, or (a third of the time on longer moves) an S: the two control points bowed opposite ways.
  const bow = dist * between(0.04, 0.3) * (rand() < 0.5 ? -1 : 1);
  const s = dist > 200 && rand() < 0.33 ? -between(0.3, 0.9) : between(0.6, 1.2);
  const c1 = { x: from.x + dx * between(0.2, 0.4) + nx * bow, y: from.y + dy * between(0.2, 0.4) + ny * bow };
  const c2 = { x: from.x + dx * between(0.6, 0.8) + nx * bow * s, y: from.y + dy * between(0.6, 0.8) + ny * bow * s };
  const steps = Math.max(6, Math.min(80, Math.round(ms / 12)));
  // A hesitation: somewhere past the middle the hand slows and pauses, as if reading the target.
  const pauseAt = hesitate ? Math.round(steps * between(0.55, 0.8)) : -1;
  for (let i = 1; i <= steps; i++) {
    const p = cubic(from, c1, c2, to, easeInOut(i / steps));
    const j = i === steps ? 0 : jitter;
    await page.mouse.move(p.x + between(-j, j), p.y + between(-j, j));
    await sleep((ms / steps) * (i === pauseAt ? 1 : between(0.7, 1.3)));
    if (i === pauseAt) await sleep(between(90, 260));
  }
}

/**
 * Move `page`'s pointer to `to` the way a hand would, from wherever it last was. `pace` scales its duration:
 * ticking down a row of tiles is a quicker, smaller motion than reaching across the table.
 */
export async function humanMove(page: Page, to: Point, pace = 1): Promise<void> {
  const from = at.get(page) ?? { x: 960 + between(-200, 200), y: 600 + between(-120, 120) };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 3) {
    await page.mouse.move(to.x, to.y);
    at.set(page, to);
    return;
  }
  // Fitts-ish: longer moves take longer, but not proportionally; and no two moves at the same pace.
  const ms = (170 + 95 * Math.log2(1 + dist / 12)) * between(0.7, 1.45) * pace;
  const hesitate = dist > 150 && rand() < 0.22;
  if (dist > 220 && rand() < 0.65) {
    // Past the target along the way in, by a different amount each time, then a short settle back onto it.
    const over = between(4, 22);
    const end = { x: to.x + ((to.x - from.x) / dist) * over + between(-6, 6), y: to.y + ((to.y - from.y) / dist) * over + between(-6, 6) };
    await stroke(page, from, end, ms, between(0.4, 1.4), hesitate);
    await sleep(between(25, 110));
    await stroke(page, end, to, between(80, 190), 0.3, false);
  } else {
    await stroke(page, from, to, ms, between(0.4, 1.2), hesitate);
  }
  at.set(page, to);
}

/** A rest of about `ms` (±25%), and the hand is never quite still: it drifts a few pixels while it waits. */
export async function humanRest(page: Page, ms: number): Promise<void> {
  const total = Math.round(ms * between(0.75, 1.25));
  const here = at.get(page);
  if (here === undefined || total < 200) {
    await page.waitForTimeout(total);
    return;
  }
  const end = Date.now() + total;
  let p = here;
  while (Date.now() < end) {
    await page.waitForTimeout(Math.min(end - Date.now(), between(120, 320)));
    if (Date.now() >= end) break;
    // A small random walk around where it rests, pulled back towards the spot so it never wanders off.
    p = { x: p.x + between(-2.5, 2.5) + (here.x - p.x) * 0.3, y: p.y + between(-2, 2) + (here.y - p.y) * 0.3 };
    await page.mouse.move(p.x, p.y);
  }
  // Back on the spot, so a click that follows lands where it was aimed.
  await page.mouse.move(here.x, here.y);
}
