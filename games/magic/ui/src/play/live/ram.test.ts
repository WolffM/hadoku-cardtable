// @vitest-environment jsdom
/*
 * A creature's ram (`ram.ts`): where it strikes, how long each ending lasts, and a copy that starts
 * exactly on its card — so its card, shown again when the copy is home, never jumps.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { damagePower, powerEase } from '../motion.ts';
import { entryWeight } from './entries.ts';
import { ALIGN_MS, alignOf, bendOf, BLAST_MS, boxIn, chargeControl, contactMs, fanOf, punchAt, ram, RAMMING_ATTR, ramMs, RETURN_MS, strikeOffset, windUpOf } from './ram.ts';

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

describe('fanOf on a phone held upright', () => {
  /*
   * As phone-core measured it (`cp-lethal-blow`, 390×844): the other seat's avatar in the top band's right
   * corner, and a pack of sixteen standing in a lane that scrolls sideways, most of it past the table's right
   * edge. Their own way from the avatar never reaches the table, and every one of them formed up at one
   * point off it (451, 137).
   */
  const table = { x: 187, y: 422, w: 374, h: 844 };
  const to = { x: 326.8, y: 28, w: 40, h: 40 };
  const froms = Array.from({ length: 16 }, (_, i) => ({ x: 66 + i * 114, y: 470, w: 104, h: 145 }));
  it('sixteen chargers whose own way misses the table still form up on it, on the board’s side of the avatar', () => {
    const at = fanOf(froms, to, 'k', table);
    const spots = froms.map((b, i) => ({ x: b.x + at[i]!.x, y: b.y + at[i]!.y }));
    spots.forEach((p, i) => {
      expect(p.x, `${i} not off the table's left`).toBeGreaterThanOrEqual(table.x - table.w / 2);
      expect(p.x, `${i} not off its right`).toBeLessThanOrEqual(table.x + table.w / 2);
      expect(p.y, `${i} below the avatar, on the board`).toBeGreaterThan(to.y);
      expect(p.y, `${i} not off its bottom`).toBeLessThanOrEqual(table.y + table.h / 2);
    });
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
  it('then punches faster and harder the heavier: a point, four, ten and twenty each past the first cut, a tenth under the second', () => {
    const peaks = [1, 4, 10, 20].map((a) => charge(a).peak);
    console.log(`[w87a] charge peak px/ms at 1, 4, 10, 20 damage: ${peaks.map((p) => p.toFixed(2)).join(', ')}; on its latest-bending curve ${[1, 4, 10, 20].map((a) => charge(a, 0.99).peak.toFixed(2)).join(', ')}`);
    // The operator on the second cut (2026-10-31): "we can actually shave off 10% of the top speed for all levels". It peaked at 7.50, 12.59, 17.58, 20.92.
    const second = [7.5, 12.59, 17.58, 20.92];
    peaks.forEach((p, i) => expect(Math.abs(p / second[i]! - 0.9), `${[1, 4, 10, 20][i]} damage: within 2% of a tenth off`).toBeLessThan(0.02));
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]!).toBeGreaterThan(peaks[i - 1]! * 1.15);
  });
  it('a pack bends outward, each its own arc: those on the left of it arc out left, those on the right out right, so no two cross', () => {
    // The operator, 2026-10-31: "i would prefer a bit of randomness to the arc, everyone attacking in the same arc is weird. and the arc shouldn't always bend in the same direction."
    const root = document.createElement('div');
    root.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
    document.body.append(root);
    const flights: Keyframe[][] = [];
    HTMLElement.prototype.animate = vi.fn((frames: Keyframe[], options: KeyframeAnimationOptions) => {
      if (Number(options.delay) + Number(options.duration) === contactMs('charge')) flights.push(frames);
      return { finished: new Promise(() => undefined), cancel: () => undefined } as unknown as Animation;
    }) as unknown as typeof HTMLElement.prototype.animate;
    // Every coin the same way: the side must come from the pack, not the coin.
    vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const player = { x: 500, y: 100, w: 56, h: 56 };
    const froms = [0, 1, 2, 3, 4].map((i) => ({ x: 260 + i * 120, y: 700, w: 60, h: 84 }));
    const spots = fanOf(froms, player, 'k', { x: 500, y: 500, w: 1000, h: 1000 });
    const sides = bendOf(froms.map((b, i) => ({ x: b.x + spots[i]!.x, y: b.y + spots[i]!.y })), player, () => 0.2);
    froms.forEach((from, i) => {
      const card = document.createElement('li');
      document.body.append(card);
      ram(root, card, from, player, 'charge', 'charge', `k${i}`, 0, damagePower(4), 0, { start: 0, at: spots[i]!, weight: entryWeight(4).power, side: sides[i] });
    });
    // Which way each bows off the straight line from where it winds up to the avatar: + its right, − its left.
    const bows = flights.map((frames) => {
      const pts = frames.map((f) => String(f.translate).split(' ').map((v) => Number(v.replace('px', ''))) as [number, number]);
      const [a, b] = [pts[0]!, pts[pts.length - 1]!];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const right = { x: -(b[1] - a[1]) / len, y: (b[0] - a[0]) / len };
      return pts.reduce((m, p) => {
        const d = (p[0] - a[0]) * right.x + (p[1] - a[1]) * right.y;
        return Math.abs(d) > Math.abs(m) ? d : m;
      }, 0);
    });
    expect(bows).toHaveLength(5);
    expect(Math.sign(bows[0]!), `the leftmost arcs out left: ${bows.map((x) => x.toFixed(0)).join(', ')}`).toBe(-1);
    expect(Math.sign(bows[1]!)).toBe(-1);
    expect(Math.sign(bows[3]!), 'the right ones out right').toBe(1);
    expect(Math.sign(bows[4]!)).toBe(1);
    expect(sides[2], 'the middle one: the coin').toBe(-1);
    expect(bendOf([{ x: 500, y: 700 }], player, () => 0.8), 'one charger alone: the coin').toEqual([1]);
  });
  it('and each its own bend: five chargers on a fair random draw five different arcs', () => {
    const arcs = [0, 1, 2, 3, 4].map((i) => {
      let n = i * 3;
      const draws = [0.9, 0.13, 0.71, 0.42, 0.88, 0.05, 0.37, 0.64, 0.21, 0.96, 0.58, 0.3, 0.77, 0.49, 0.11];
      const c = chargeControl({ x: 0, y: 0 }, { x: 0, y: -400 }, () => draws[n++ % draws.length]!, 1);
      return `${c.x.toFixed(0)},${c.y.toFixed(0)}`;
    });
    expect(new Set(arcs).size, arcs.join(' ')).toBe(5);
  });
  it('however its curve bends: the punch is a distance along the flight, so no curve slows the blow', () => {
    for (const a of [1, 10, 20]) expect(charge(a, 0.99).peak / charge(a, 0).peak, `${a} damage`).toBeGreaterThan(0.9);
  });
  it('and every blow still lands when it did: the impact frame does not move', () => {
    for (const a of [1, 4, 10, 20]) expect(charge(a).lands).toBe(contactMs('charge'));
    expect(contactMs('charge')).toBe(ALIGN_MS + 640);
  });
});

describe('a charge’s way home', () => {
  /**
   * The operator, 2026-10-31, on the third cut: "enhance the 'weight' of the stronger cards a bit more. 1 damage card
   * should be quickest to retreat back after landing. stronger cards should linger a bit more and accelerate more
   * slowly to their starting position." Before: every charge held the blow 180 ms and went home in 620 ms, its ease
   * set off a little slower the heavier (`homeEase`).
   */
  const home = (amount: number): { hold: number; ms: number; ease: string; ends: number } => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
    const card = document.createElement('li');
    document.body.append(root, card);
    const calls: KeyframeAnimationOptions[] = [];
    HTMLElement.prototype.animate = vi.fn((_: Keyframe[], options: KeyframeAnimationOptions) => {
      calls.push(options);
      return { finished: new Promise(() => undefined), cancel: () => undefined } as unknown as Animation;
    }) as unknown as typeof HTMLElement.prototype.animate;
    const weight = entryWeight(amount).power;
    ram(root, card, { x: 500, y: 900, w: 60, h: 84 }, { x: 500, y: 480, w: 40, h: 40 }, 'charge', 'charge', 'k', 0, damagePower(amount), 0, { start: 0, at: { x: 0, y: 0 }, weight });
    const back = calls[calls.length - 1]!;
    return { hold: Number(back.delay) - contactMs('charge'), ms: Number(back.duration), ease: String(back.easing), ends: ramMs('charge', 'charge', weight) };
  };
  /** How far home a `cubic-bezier` ease is a share `x` of the way through its time. */
  const progress = (ease: string, x: number): number => {
    const [x1, y1, x2, y2] = /cubic-bezier\(([^)]+)\)/.exec(ease)![1]!.split(',').map(Number) as [number, number, number, number];
    const b = (t: number, a: number, c: number): number => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * c + t ** 3;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (b(m, x1, x2) < x) lo = m;
      else hi = m;
    }
    return b(lo, y1, y2);
  };
  it('a point is home first; the heavier lingers on the blow longer and sets off home more slowly', () => {
    const tiers = [1, 4, 10, 15].map(home);
    console.log(`[w87a] home at 1, 4, 10, 15: hold ${tiers.map((h) => h.hold).join(', ')} ms; way home ${tiers.map((h) => h.ms).join(', ')} ms; a fifth of the way home after 120 ms: ${tiers.map((h) => progress(h.ease, 120 / h.ms).toFixed(2)).join(', ')}`);
    expect(tiers[0]!.hold, 'a point barely holds').toBeLessThan(140);
    expect(tiers[0]!.hold + tiers[0]!.ms, 'and is home sooner than any charge was').toBeLessThan(180 + 620);
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]!.hold, `${[1, 4, 10, 15][i]} lingers longer`).toBeGreaterThan(tiers[i - 1]!.hold);
      expect(tiers[i]!.hold + tiers[i]!.ms, `${[1, 4, 10, 15][i]} is home later`).toBeGreaterThan(tiers[i - 1]!.hold + tiers[i - 1]!.ms);
      expect(progress(tiers[i]!.ease, 120 / tiers[i]!.ms), `${[1, 4, 10, 15][i]} sets off home more slowly`).toBeLessThan(progress(tiers[i - 1]!.ease, 120 / tiers[i - 1]!.ms));
    }
    expect(tiers[3]!.hold, 'fifteen lingers a third of a second').toBeGreaterThan(300);
    expect(progress(tiers[0]!.ease, 120 / tiers[0]!.ms), 'a point is off at once').toBeGreaterThan(0.25);
    expect(progress(tiers[3]!.ease, 120 / tiers[3]!.ms), 'fifteen barely stirs at first').toBeLessThan(0.05);
    tiers.forEach((h, i) => expect(h.ends, `${[1, 4, 10, 15][i]}: its part ends when it is home`).toBe(contactMs('charge') + h.hold + h.ms));
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

