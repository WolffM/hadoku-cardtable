// @vitest-environment jsdom
/*
 * A creature's ram (`ram.ts`): where it strikes, how long each ending lasts, and a copy that starts
 * exactly on its card — so its card, shown again when the copy is home, never jumps.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { damagePower, powerEase } from '../motion.ts';
import { entryWeight } from './entries.ts';
import { ALIGN_MS, alignOf, BLAST_MS, boxIn, chargeControl, contactMs, fanOf, punchAt, ram, RAMMING_ATTR, ramMs, RETURN_MS, strikeOffset, windUpOf } from './ram.ts';

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
  it('its copy starts on the card’s own box, a turned card’s centring margins dropped without moving it, reading no box of its own, and the card is shown again once it is home', async () => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    const card = document.createElement('li');
    card.className = 'board-card';
    // A turned card: its own box is the turned card, centred in its upright place by margins.
    card.style.marginTop = card.style.marginBottom = '26px';
    card.getBoundingClientRect = () => rect(99, 306, 78, 56);
    document.body.append(root, card);
    // Measured by the caller, with every other ram's boxes, before any copy is drawn.
    const from = boxIn(card, root);
    const reads = vi.spyOn(card, 'getBoundingClientRect');
    const rootReads = vi.spyOn(root, 'getBoundingClientRect');
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((done) => (finish = done));
    const animate = vi.fn(() => ({ finished, cancel: () => undefined }) as unknown as Animation);
    HTMLElement.prototype.animate = animate;
    vi.useFakeTimers();
    ram(root, card, from, { x: 138, y: 100, w: 78, h: 108 }, 'meet', 'bounce', 'k', 0, 0, 0);
    expect(reads, 'no box read while the attack is drawn: each lays the page out again').not.toHaveBeenCalled();
    expect(rootReads).not.toHaveBeenCalled();
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
  const table = { x: 640, y: 380, w: 1280, h: 760 };
  const big = table;
  it('one charger draws straight back from the player', () => {
    const [at] = fanOf([row[0]!], player, 'k', table);
    const away = { x: row[0]!.x - player.x, y: row[0]!.y - player.y };
    expect(at!.x * away.y - at!.y * away.x, 'along its own line').toBeCloseTo(0);
    expect(at!.x * away.x + at!.y * away.y, 'away from them').toBeGreaterThan(0);
  });
  it('a pack draws back from the player in the order it stands, spread just enough that no two are closer than a card’s longest side', () => {
    const at = fanOf(row, player, 'k', table);
    const spots = row.map((b, i) => ({ x: b.x + at[i]!.x, y: b.y + at[i]!.y }));
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y), `${i} and ${j} apart`).toBeGreaterThan(84);
    const angle = (p: { x: number; y: number }): number => Math.atan2(p.y - player.y, p.x - player.x);
    const order = (ps: { x: number; y: number }[]): number[] => ps.map((p, i) => [angle(p), i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    expect(order(spots), 'no paths cross: the order they stood in').toEqual(order(row));
    row.forEach((b, i) => expect(Math.hypot(spots[i]!.x - player.x, spots[i]!.y - player.y), `${i} drawn back from the player`).toBeGreaterThan(Math.hypot(b.x - player.x, b.y - player.y)));
  });
  /*
   * The operator, 2026-10-20: "with a very large number of creatures (15+) they fan out in a circle around
   * the opponent, but they should fan out in a cone around the opponent, towards the visible part of the
   * board." Then: "cone is maybe the wrong word. just keep the creatures on the board." Up to thirty
   * attackers in two rows, at the other seat's avatar (the top of the left bar), at ours (its bottom), at
   * an avatar in the middle of the top edge, and at a planeswalker at the left of the other seat's row.
   */
  const card = { w: 84, h: 60 };
  const rows = (n: number, ys: readonly number[], size = card, per = 13): { x: number; y: number; w: number; h: number }[] =>
    Array.from({ length: n }, (_, i) => ({ x: 130 + (i % per) * (size.w + 4), y: ys[Math.floor(i / per) % ys.length]!, ...size }));
  const cases = [
    { name: 'the other seat’s avatar', to: { x: 34, y: 40, w: 56, h: 56 }, ys: [520, 620] },
    { name: 'our avatar', to: { x: 34, y: 720, w: 56, h: 56 }, ys: [240, 140] },
    { name: 'an avatar mid-edge', to: { x: 640, y: 36, w: 56, h: 56 }, ys: [520, 620] },
    { name: 'a planeswalker at the left of the other seat’s row', to: { x: 130, y: 200, w: 60, h: 84 }, ys: [520, 620] },
    // As a claw measured it (`cp-pack-ram`): a 896×633 table, each avatar at the inner end of its bar.
    { name: 'the other seat’s avatar on a small table', to: { x: 51, y: 253, w: 56, h: 56 }, ys: [420, 480, 540], table: { x: 448, y: 316.5, w: 896, h: 633 }, size: { w: 56, h: 40 }, per: 12 },
    { name: 'our avatar on a small table', to: { x: 51, y: 364, w: 56, h: 56 }, ys: [200, 140, 80], table: { x: 448, y: 316.5, w: 896, h: 633 }, size: { w: 56, h: 40 }, per: 12 },
  ];
  for (const c of cases)
    for (const n of [15, 20, 26, 30])
      it(`${n} chargers at ${c.name} form up on the board’s side of it, all on the table, none on top of another`, () => {
        const table = c.table ?? big;
        const froms = rows(n, c.ys, c.size, c.per);
        const at = fanOf(froms, c.to, 'k', table);
        const spots = froms.map((b, i) => ({ x: b.x + at[i]!.x, y: b.y + at[i]!.y }));
        // Measured from straight toward the board: down from a target above the table's middle, up from one below it.
        const board = c.to.y < table.y ? Math.PI / 2 : -Math.PI / 2;
        const off = spots.map((p) => (((Math.atan2(p.y - c.to.y, p.x - c.to.x) - board + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * (180 / Math.PI));
        off.forEach((deg, i) => expect(Math.abs(deg), `${i} on the board's side of the target`).toBeLessThanOrEqual(90));
        const longest = Math.max(froms[0]!.w, froms[0]!.h);
        spots.forEach((p, i) => {
          expect(p.x - longest / 2, `${i} not off the table's left`).toBeGreaterThanOrEqual(table.x - table.w / 2);
          expect(p.x + longest / 2, `${i} not off its right`).toBeLessThanOrEqual(table.x + table.w / 2);
          expect(p.y - longest / 2, `${i} not off its top`).toBeGreaterThanOrEqual(table.y - table.h / 2);
          expect(p.y + longest / 2, `${i} not off its bottom`).toBeLessThanOrEqual(table.y + table.h / 2);
        });
        for (let i = 0; i < spots.length; i++)
          for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y), `${i} and ${j} apart`).toBeGreaterThan(longest);
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
  it('snaps: the heavier, the harder the burst at the blow', () => {
    expect(punchAt(0.5, 0)).toBeLessThan(0.15);
    expect(speed(1, 0.5)).toBeGreaterThan(speed(1, 0));
    expect(speed(1, 1)).toBeGreaterThan(speed(1, 0.5));
    expect(speed(1, 0)).toBeGreaterThan(9);
  });
  it('only ever speeds up', () => {
    for (const power of [0, 0.5, 1]) for (let t = 0.05; t <= 1; t += 0.05) expect(speed(t, power)).toBeGreaterThan(speed(t - 0.05, power));
  });
});

describe('a charge’s wind-up and punch', () => {
  /**
   * The charge a creature dealing `amount` damage hands the browser, over a 400px straight line: where
   * its card is at each ms from its turn to face the player to the blow, read off its keyframes (run
   * linear). The operator, 2026-10-31, on the first harder punch: "it can still be improved if the arc
   * was instead first slowly backward, then rapidly forward … kind of like the slam is being wound up.
   * this 'back up' should be further exaggerated with higher power creatures. they have a slower start
   * and longer wind up, but then an even faster and harder punch."
   * The punch before it (on w87a's first cut): 6.30, 9.36, 11.44, 13.54 px/ms at 1, 4, 10, 20 damage.
   */
  const charge = (amount: number, draw = 0): { peak: number; lands: number; back: number; windMs: number; windPeak: number } => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
    const card = document.createElement('li');
    document.body.append(root, card);
    const calls: { frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
    HTMLElement.prototype.animate = vi.fn((frames: Keyframe[], options: KeyframeAnimationOptions) => {
      calls.push({ frames, options });
      return { finished: new Promise(() => undefined), cancel: () => undefined } as unknown as Animation;
    }) as unknown as typeof HTMLElement.prototype.animate;
    // Formed up exactly where it stands, 400px below where it strikes the avatar (less 0.4 of its own reach), on the curve `draw` picks.
    vi.spyOn(Math, 'random').mockReturnValue(draw);
    ram(root, card, { x: 500, y: 900, w: 60, h: 84 }, { x: 500, y: 900 - 400 - 84 * 0.2, w: 40, h: 40 }, 'charge', 'charge', 'k', 0, damagePower(amount), 0, { start: 0, at: { x: 0, y: 0 }, weight: entryWeight(amount).power });
    const launch = ALIGN_MS;
    const lands = contactMs('charge');
    // Every part between its turn to face the player and the blow, as a position at a given ms.
    const parts = calls
      .map((c) => ({ from: Number(c.options.delay), ms: Number(c.options.duration), keys: c.frames.map((f, i) => {
        const [x, y] = String(f.translate).split(' ').map((v) => Number(v.replace('px', '')));
        return { t: f.offset === undefined || f.offset === null ? i / (c.frames.length - 1) : Number(f.offset), x: x!, y: y! };
      }) }))
      .filter((p) => p.from >= launch && p.from + p.ms <= lands);
    const at = (ms: number): { x: number; y: number } => {
      const part = parts.find((p) => ms >= p.from && ms <= p.from + p.ms)!;
      const t = (ms - part.from) / part.ms;
      const i = Math.max(1, part.keys.findIndex((k) => k.t >= t));
      const a = part.keys[i - 1]!;
      const b = part.keys[i]!;
      const f = (t - a.t) / (b.t - a.t || 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    };
    const frame = 1000 / 60;
    const strikeFrom = parts.length > 1 ? parts[parts.length - 1]!.from : launch;
    let peak = 0;
    let windPeak = 0;
    let back = 0;
    // Every frame's window, wherever the frame falls: the punch's fastest is the one that ends on the blow.
    for (let ms = launch; ms + frame <= lands; ms += 1) {
      const a = at(ms);
      const b = at(ms + frame);
      const v = Math.hypot(b.x - a.x, b.y - a.y) / frame;
      if (ms + frame <= strikeFrom) windPeak = Math.max(windPeak, v);
      else peak = Math.max(peak, v);
      // Down the screen is away from the avatar.
      back = Math.max(back, a.y);
    }
    return { peak, lands: launch + parts.reduce((n, p) => Math.max(n, p.from + p.ms - launch), 0), back, windMs: strikeFrom - launch, windPeak };
  };
  it('first draws slowly back, away from the player: further and longer the heavier, a point small and quick, fifteen and up the deepest', () => {
    const tiers = [1, 4, 10, 15, 20].map((a) => charge(a));
    console.log(`[w87a] wind-up px at 1, 4, 10, 15, 20 damage: ${tiers.map((c) => c.back.toFixed(1)).join(', ')}; ms ${tiers.map((c) => c.windMs.toFixed(0)).join(', ')}; its fastest px/ms ${tiers.map((c) => c.windPeak.toFixed(2)).join(', ')}`);
    expect(tiers[0]!.back, 'a point still winds up').toBeGreaterThan(4);
    expect(tiers[0]!.windMs).toBeLessThan(150);
    for (let i = 1; i < 4; i++) {
      expect(tiers[i]!.back, `${[1, 4, 10, 15][i]} draws back further`).toBeGreaterThan(tiers[i - 1]!.back * 1.2);
      expect(tiers[i]!.windMs, `${[1, 4, 10, 15][i]} winds up longer`).toBeGreaterThan(tiers[i - 1]!.windMs);
    }
    expect(tiers[3]!.back, 'fifteen draws back most of a card').toBeGreaterThan(55);
    expect(tiers[3]!.windMs).toBeGreaterThan(300);
    expect(tiers[4]!.back, 'nothing grows past fifteen, as a landing').toBeCloseTo(tiers[3]!.back);
    tiers.forEach((c, i) => expect(c.windPeak, `${[1, 4, 10, 15, 20][i]}: slowly back`).toBeLessThan(c.peak / 5));
    expect(windUpOf(0)).toEqual(windUpOf(-1));
  });
  it('then punches faster and harder the heavier: a point, four, ten and twenty each well past the first cut', () => {
    const peaks = [1, 4, 10, 20].map((a) => charge(a).peak);
    console.log(`[w87a] charge peak px/ms at 1, 4, 10, 20 damage: ${peaks.map((p) => p.toFixed(2)).join(', ')}; on its latest-bending curve ${[1, 4, 10, 20].map((a) => charge(a, 0.99).peak.toFixed(2)).join(', ')}`);
    const floors = [7, 11, 15, 18];
    peaks.forEach((p, i) => expect(p, `${[1, 4, 10, 20][i]} damage: ${p.toFixed(2)} px/ms`).toBeGreaterThan(floors[i]!));
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]!).toBeGreaterThan(peaks[i - 1]! * 1.15);
  });
  it('however its curve bends: the punch is a distance along the flight, so no curve slows the blow', () => {
    for (const a of [1, 10, 20]) expect(charge(a, 0.99).peak / charge(a, 0).peak, `${a} damage`).toBeGreaterThan(0.9);
  });
  it('and every blow still lands when it did: the impact frame does not move', () => {
    for (const a of [1, 4, 10, 20]) expect(charge(a).lands).toBe(contactMs('charge'));
    expect(contactMs('charge')).toBe(ALIGN_MS + 640);
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

