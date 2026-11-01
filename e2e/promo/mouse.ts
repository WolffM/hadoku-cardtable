/**
 * A pointer that moves like a hand (the operator, 2026-10-30: "add a bit of randomness to simulate human
 * mouse movement"). Every promo move goes through {@link humanMove}: a curved path (a quadratic Bézier
 * bowed by a random perpendicular offset), ease-in-out speed, a small overshoot and settle on a long move,
 * and a pixel of jitter per step. {@link humanRest} varies the pause between moves.
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

function bezier(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

async function stroke(page: Page, from: Point, to: Point, ms: number, bow: number, jitter: number): Promise<void> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const c = { x: from.x + dx / 2 + (-dy / dist) * bow, y: from.y + dy / 2 + (dx / dist) * bow };
  const steps = Math.max(6, Math.min(70, Math.round(ms / 12)));
  for (let i = 1; i <= steps; i++) {
    const p = bezier(from, c, to, easeInOut(i / steps));
    const j = i === steps ? 0 : jitter;
    await page.mouse.move(p.x + between(-j, j), p.y + between(-j, j));
    await sleep(ms / steps);
  }
}

/** Move `page`'s pointer to `to` the way a hand would, from wherever it last was. */
export async function humanMove(page: Page, to: Point): Promise<void> {
  const from = at.get(page) ?? { x: 960 + between(-200, 200), y: 600 + between(-120, 120) };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 3) {
    await page.mouse.move(to.x, to.y);
    at.set(page, to);
    return;
  }
  // Fitts-ish: longer moves take longer, but not proportionally.
  const ms = (180 + 95 * Math.log2(1 + dist / 12)) * between(0.85, 1.2);
  const bow = dist * between(0.06, 0.2) * (rand() < 0.5 ? -1 : 1);
  if (dist > 280) {
    // Past the target by a few pixels along the way in, then a short settle back onto it.
    const over = between(6, 16);
    const end = { x: to.x + ((to.x - from.x) / dist) * over + between(-4, 4), y: to.y + ((to.y - from.y) / dist) * over + between(-4, 4) };
    await stroke(page, from, end, ms, bow, 0.9);
    await sleep(between(30, 70));
    await stroke(page, end, to, between(90, 150), 0, 0.3);
  } else {
    await stroke(page, from, to, ms, bow, 0.7);
  }
  at.set(page, to);
}

/** A rest of about `ms`, never the same twice: ±25%. */
export async function humanRest(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(Math.round(ms * between(0.75, 1.25)));
}
