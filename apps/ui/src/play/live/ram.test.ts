// @vitest-environment jsdom
/*
 * A creature's ram (`ram.ts`): where it strikes, how long each ending lasts, and a copy that starts
 * exactly on its card — so its card, shown again when the copy is home, never jumps.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { powerEase } from '../motion.ts';
import { alignOf, BLAST_MS, chargeControl, fanOf, contactMs, punchAt, ram, RAMMING_ATTR, ramMs, RETURN_MS, strikeOffset } from './ram.ts';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  // jsdom has no Web Animations API: the one test that needs it stubs it on the prototype.
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

describe('strikeOffset', () => {
  const a = { x: 0, y: 0, w: 60, h: 84 };
  const b = { x: 0, y: 200, w: 60, h: 84 };
  it('two that meet stop short of halfway; a strike stops a quarter into its target; a charge lands on the avatar', () => {
    expect(strikeOffset(a, b, 'meet').y).toBeLessThan(100);
    expect(strikeOffset(a, b, 'strike').y).toBeCloseTo(200 - 84 * 0.75);
    expect(strikeOffset(a, { x: 0, y: 200, w: 40, h: 40 }, 'charge').y).toBeCloseTo(200 - 42 * 0.4);
  });
});

describe('ramMs', () => {
  it('a creature that goes home holds, then takes the slow way back; one that dies ends at its blast', () => {
    expect(ramMs('meet', 'bounce')).toBeGreaterThan(contactMs('meet') + RETURN_MS);
    expect(ramMs('meet', 'crumple')).toBe(contactMs('meet') + BLAST_MS);
  });
});

describe('ram', () => {
  it('its copy starts on the card’s own box, a turned card’s centring margins dropped without moving it, and the card is shown again once it is home', async () => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    const card = document.createElement('li');
    card.className = 'board-card';
    // A turned card: its own box is the turned card, centred in its upright place by margins.
    card.style.marginTop = card.style.marginBottom = '26px';
    card.getBoundingClientRect = () => rect(99, 306, 78, 56);
    document.body.append(root, card);
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((done) => (finish = done));
    const animate = vi.fn(() => ({ finished, cancel: () => undefined }) as unknown as Animation);
    HTMLElement.prototype.animate = animate;
    vi.useFakeTimers();
    ram(root, card, { x: 138, y: 100, w: 78, h: 108 }, 'meet', 'bounce', 'k', 0, 0, 0);
    const copy = root.querySelector<HTMLElement>('.board-ram')!;
    expect([copy.style.left, copy.style.top], 'on the card, not a margin lower').toEqual(['99px', '306px']);
    expect(copy.querySelector<HTMLElement>('.board-card')!.style.marginBlock).toBe('0px');
    vi.advanceTimersByTime(0);
    expect(card.hasAttribute(RAMMING_ATTR), 'the card is hidden while its copy is away').toBe(true);
    vi.useRealTimers();
    finish();
    await finished;
    await Promise.resolve();
    expect(card.hasAttribute(RAMMING_ATTR)).toBe(false);
    expect(root.querySelector('.board-ram'), 'the copy is gone once home').toBeNull();
  });
});

describe('powerEase', () => {
  it('a punch: the same length whatever the blow; a weak one near even, a strong one creeping out and fastest at the blow', () => {
    const curve = (e: string): number[] => /cubic-bezier\(([^)]+)\)/.exec(e)![1]!.split(',').map(Number);
    const startSlope = ([x1, y1]: number[]): number => y1! / x1!;
    const endSlope = ([, , x2, y2]: number[]): number => (1 - y2!) / (1 - x2!);
    const weak = curve(powerEase(0));
    const strong = curve(powerEase(1));
    expect(startSlope(strong), 'the strong one sets off slower').toBeLessThan(startSlope(weak));
    expect(endSlope(strong), 'and ends far faster').toBeGreaterThan(endSlope(weak) * 4);
    expect(endSlope(weak), 'the weak one still speeds up a little').toBeGreaterThan(1);
  });
});

describe('alignOf', () => {
  it('a charger turns its top to face the player: an upright card by its up, a turned card by its right', () => {
    const upright = { x: 0, y: 200, w: 60, h: 84 };
    const turnedCard = { x: 0, y: 200, w: 84, h: 60 };
    const player = { x: 0, y: 0, w: 40, h: 40 };
    expect(alignOf(upright, player, { x: 0, y: 18 }).rot, 'already facing up at them').toBeCloseTo(0);
    expect(alignOf(turnedCard, player, { x: 0, y: 18 }).rot, 'its right turned up to them').toBeCloseTo(-90);
  });
});

describe('fanOf', () => {
  const player = { x: 100, y: 0, w: 40, h: 40 };
  const row = [0, 1, 2, 3].map((i) => ({ x: 60 + i * 82, y: 400, w: 84, h: 60 }));
  it('one charger draws straight back from the player', () => {
    const [at] = fanOf([row[0]!], player, 'k');
    const away = { x: row[0]!.x - player.x, y: row[0]!.y - player.y };
    expect(at!.x * away.y - at!.y * away.x, 'along its own line').toBeCloseTo(0);
    expect(at!.x * away.x + at!.y * away.y, 'away from them').toBeGreaterThan(0);
  });
  it('a pack draws back from the player in the order it stands, spread just enough that no two are closer than a card’s longest side', () => {
    const at = fanOf(row, player, 'k');
    const spots = row.map((b, i) => ({ x: b.x + at[i]!.x, y: b.y + at[i]!.y }));
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y), `${i} and ${j} apart`).toBeGreaterThan(84);
    const angle = (p: { x: number; y: number }): number => Math.atan2(p.y - player.y, p.x - player.x);
    const order = (ps: { x: number; y: number }[]): number[] => ps.map((p, i) => [angle(p), i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    expect(order(spots), 'no paths cross: the order they stood in').toEqual(order(row));
    row.forEach((b, i) => expect(Math.hypot(spots[i]!.x - player.x, spots[i]!.y - player.y), `${i} drawn back from the player`).toBeGreaterThan(Math.hypot(b.x - player.x, b.y - player.y)));
  });
});

describe('punchAt', () => {
  const speed = (t: number, power: number): number => (punchAt(Math.min(1, t + 0.001), power) - punchAt(Math.max(0, t - 0.001), power)) / (Math.min(1, t + 0.001) - Math.max(0, t - 0.001));
  it('runs from rest at the start to the blow at the end', () => {
    expect(punchAt(0, 0)).toBe(0);
    expect(punchAt(1, 0)).toBeCloseTo(1);
    expect(punchAt(1, 1)).toBeCloseTo(1);
    expect(speed(0, 0)).toBeLessThan(0.05);
  });
  it('creeps, then bursts — the heavier, the slower off the mark and the faster at the blow', () => {
    expect(punchAt(0.5, 0)).toBeLessThan(0.15);
    expect(punchAt(0.5, 1)).toBeLessThan(punchAt(0.5, 0.5));
    expect(punchAt(0.5, 0.5)).toBeLessThan(punchAt(0.5, 0));
    expect(speed(1, 0)).toBeGreaterThan(4.5);
    expect(speed(1, 0.5)).toBeGreaterThan(speed(1, 0) * 1.8);
    expect(speed(1, 1)).toBeGreaterThan(14);
  });
  it('only ever speeds up', () => {
    for (const power of [0, 0.5, 1]) for (let t = 0.05; t <= 1; t += 0.05) expect(speed(t, power)).toBeGreaterThan(speed(t - 0.05, power));
  });
});

describe('chargeControl', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 0, y: -200 };
  const draws = (...xs: number[]) => {
    let i = 0;
    return () => xs[i++ % xs.length]!;
  };
  it('bends to either side, from barely to a lot, and peaks early or late along the way', () => {
    const left = chargeControl(start, end, draws(0.2, 0, 0.5));
    const right = chargeControl(start, end, draws(0.8, 1, 0.5));
    expect(Math.sign(left.x)).toBe(-Math.sign(right.x));
    expect(Math.abs(left.x)).toBeLessThan(15);
    expect(Math.abs(right.x)).toBeGreaterThan(80);
    expect(chargeControl(start, end, draws(0.2, 0.5, 0)).y).toBeCloseTo(-60);
    expect(chargeControl(start, end, draws(0.2, 0.5, 1)).y).toBeCloseTo(-140);
  });
});

