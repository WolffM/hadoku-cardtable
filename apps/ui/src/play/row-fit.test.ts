// @vitest-environment jsdom
/**
 * The row count a crowded zone settles on, swept across the sizes a table is drawn at, and checked
 * against the room it leaves each card. `board.css` makes the decision (`--rows`), so this reads the
 * decision out of `board.css` and evaluates it the way the browser does — custom properties
 * substituted where they are declared, then the math functions — and lays the zone out from it: the
 * lanes dividing the width by their columns, each lane's grid at its `minmax()` columns.
 *
 * The layout it checks against was measured: `e2e/row-squish.spec.ts` prints every lane's scroll
 * and client width, and at 1280×800 (an 818px battlefield, 698px inside its gutter) twelve columns
 * in two lanes put the lands lane at 380px against the 384px its cards need, which is what this
 * model computes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeZoneBox } from './zone-box.ts';

const CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play', 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const REM = 16;

interface Block {
  readonly selectors: readonly string[];
  readonly decls: ReadonlyMap<string, string>;
}

/** Split at top-level `sep`: never inside parentheses or brackets. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** Every innermost rule in the sheet, its selector list and its declarations. */
function blocks(css: string): Block[] {
  const out: Block[] = [];
  const stack: { prelude: string; body: string; nested: boolean }[] = [];
  let text = '';
  for (const c of css) {
    if (c === '{') {
      if (stack.length > 0) stack[stack.length - 1]!.nested = true;
      stack.push({ prelude: text.slice(Math.max(text.lastIndexOf('}'), text.lastIndexOf(';')) + 1).trim(), body: '', nested: false });
      text = '';
    } else if (c === '}') {
      const top = stack.pop()!;
      top.body += text;
      if (!top.nested && !top.prelude.startsWith('@')) {
        const decls = new Map<string, string>();
        for (const decl of splitTop(top.body, ';')) {
          const colon = decl.indexOf(':');
          if (colon > 0) decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim().replace(/\s+/g, ' '));
        }
        out.push({ selectors: splitTop(top.prelude.replace(/\s+/g, ' '), ','), decls });
      }
      text = '';
    } else {
      text += c;
      if (stack.length > 0 && c === ';') {
        stack[stack.length - 1]!.body += text;
        text = '';
      }
    }
  }
  return out;
}

const RULES = blocks(CSS);

/** Every declaration of the rules one of whose selectors `match` accepts, in source order. */
function declared(match: (selector: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of RULES) if (block.selectors.some(match)) for (const [k, v] of block.decls) out.set(k, v);
  return out;
}

const exactly =
  (...selectors: string[]) =>
  (s: string): boolean =>
    selectors.includes(s);

/** One element's custom properties, each substituted where it is declared, over its parent's. */
type Env = ReadonlyMap<string, string>;

function substitute(value: string, lookup: (name: string) => string | undefined): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    let depth = 0;
    let end = at + 3;
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')' && --depth === 0) break;
    }
    const [name, ...fallback] = splitTop(value.slice(at + 4, end), ',');
    const got = lookup(name!) ?? (fallback.length > 0 ? substitute(fallback.join(','), lookup) : undefined);
    if (got === undefined) throw new Error(`${name} is not defined here`);
    out += got;
    i = end + 1;
  }
  return out;
}

/** An element: its parent's custom properties, then its own, each resolved on this element. */
function element(parent: Env, own: ReadonlyMap<string, string>): Env {
  const resolved = new Map(parent);
  const done = new Set<string>();
  const doing = new Set<string>();
  const get = (name: string): string | undefined => {
    if (!own.has(name)) return parent.get(name);
    if (!done.has(name)) {
      if (doing.has(name)) throw new Error(`${name} refers to itself`);
      doing.add(name);
      resolved.set(name, substitute(own.get(name)!, get));
      done.add(name);
    }
    return resolved.get(name);
  };
  for (const name of own.keys()) if (name.startsWith('--')) get(name);
  return resolved;
}

const customs = (decls: ReadonlyMap<string, string>): Map<string, string> => new Map([...decls].filter(([k]) => k.startsWith('--')));
const px = (n: number): string => `${n}px`;

type Value = { n: number; unit: 'num' | 'len' | 'ang' };

/** The CSS math the decision is written in: calc, min, max, clamp, round, tan, atan2, px and rem. */
function evaluate(text: string): Value {
  const tokens = text.match(/\d*\.?\d+(?:e-?\d+)?(?:px|rem)?|[a-z][a-z0-9-]*\(|[()+\-*/,]|[a-z]+/g) ?? [];
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const next = (): string => tokens[i++]!;
  const args = (): Value[] => {
    const out = [sum()];
    while (peek() === ',') {
      next();
      out.push(sum());
    }
    if (next() !== ')') throw new Error(`unclosed ( in ${text}`);
    return out;
  };
  const atom = (): Value => {
    const t = next();
    if (t === '(' || t === 'calc(') {
      const [v] = args();
      return v!;
    }
    if (t === 'min(' || t === 'max(') {
      const vs = args();
      return { n: (t === 'min(' ? Math.min : Math.max)(...vs.map((v) => v.n)), unit: vs[0]!.unit };
    }
    if (t === 'clamp(') {
      const [lo, v, hi] = args();
      return { n: Math.max(lo!.n, Math.min(v!.n, hi!.n)), unit: v!.unit };
    }
    if (t === 'round(') {
      const keyword = peek() === 'up' || peek() === 'down' || peek() === 'nearest';
      const mode = keyword ? next() : 'nearest';
      if (keyword) next();
      const [v, step] = args();
      const f = mode === 'up' ? Math.ceil : mode === 'down' ? Math.floor : Math.round;
      return { n: f(v!.n / step!.n) * step!.n, unit: v!.unit };
    }
    if (t === 'atan2(') {
      const [y, x] = args();
      return { n: Math.atan2(y!.n, x!.n), unit: 'ang' };
    }
    if (t === 'tan(') {
      const [a] = args();
      return { n: Math.tan(a!.n), unit: 'num' };
    }
    if (t === '-') {
      const v = atom();
      return { n: -v.n, unit: v.unit };
    }
    const m = /^(\d*\.?\d+(?:e-?\d+)?)(px|rem)?$/.exec(t);
    if (m === null) throw new Error(`cannot read ${t} in ${text}`);
    return { n: Number(m[1]) * (m[2] === 'rem' ? REM : 1), unit: m[2] === undefined ? 'num' : 'len' };
  };
  const product = (): Value => {
    let v = atom();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const w = atom();
      v = op === '*' ? { n: v.n * w.n, unit: v.unit === 'num' ? w.unit : v.unit } : { n: v.n / w.n, unit: v.unit };
    }
    return v;
  };
  const sum = (): Value => {
    let v = product();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const w = product();
      v = { n: op === '+' ? v.n + w.n : v.n - w.n, unit: v.unit === 'num' ? w.unit : v.unit };
    }
    return v;
  };
  const v = sum();
  if (i !== tokens.length) throw new Error(`left over in ${text}: ${tokens.slice(i).join(' ')}`);
  return v;
}

/** A property of an element, its `var()`s substituted from that element's own custom properties. */
function value(env: Env, decls: ReadonlyMap<string, string>, prop: string): string {
  const raw = decls.get(prop) ?? env.get(prop);
  if (raw === undefined) throw new Error(`nothing declares ${prop}`);
  return substitute(raw, (name) => env.get(name));
}

const num = (env: Env, decls: ReadonlyMap<string, string>, prop: string): number => evaluate(value(env, decls, prop)).n;

/** `padding`'s inline size per side, the second of two lengths or the only one. */
function padX(env: Env, decls: ReadonlyMap<string, string>): number {
  const parts = value(env, decls, 'padding').split(/\s+(?![^(]*\))/);
  return evaluate(parts[1] ?? parts[0]!).n;
}

/** `grid-auto-columns: minmax(floor, cap)`, both evaluated. */
function columnBounds(env: Env, decls: ReadonlyMap<string, string>): [number, number] {
  const v = value(env, decls, 'grid-auto-columns');
  const inner = /^minmax\((.*)\)$/.exec(v)?.[1];
  if (inner === undefined) throw new Error(`grid-auto-columns is ${v}`);
  const [lo, hi] = splitTop(inner, ',');
  return [evaluate(lo!).n, evaluate(hi!).n];
}

const BOARD = customs(declared(exactly('.board')));
const BATTLEFIELD = declared(exactly('.seat > .zone--battlefield'));
const CARD_MIN = evaluate(BOARD.get('--card-min')!).n;
const GAP = evaluate(BOARD.get('--cards-gap')!).n;
const TALL = evaluate(BOARD.get('--card-tall')!).n;
const GUTTER = evaluate(BOARD.get('--right-gutter')!).n;

/** The aspect band `zone-box.ts` writes for a box, which the shape's row thresholds step on. */
function band(width: number, height: number): string | null {
  const el = document.createElement('section');
  writeZoneBox(el, width, height);
  return el.getAttribute('data-zone-aspect');
}

const bandRule = (aspect: string | null) => (s: string): boolean =>
  aspect !== null && s.startsWith(':is(.seat > .zone--battlefield, .zone--hand)') && s.includes(`[data-zone-aspect='${aspect}'] >`);

interface Laid {
  rows: number;
  /** Per lane: the room its content box has, what its columns need, and the width each column draws. */
  lanes: { cards: number; room: number; need: number; col: number; tall: number; height: number }[];
}

/** One list's grid laid out in its box: `k` columns of `minmax(floor, cap)` from the left, `rows` tall. */
function grid(env: Env, decls: ReadonlyMap<string, string>, width: number, height: number, k: number, rows: number, cards: number): Laid['lanes'][number] {
  const [floor, cap] = columnBounds(env, decls);
  const pad = padX(env, decls);
  const share = (width - 2 * pad - (k - 1) * GAP) / k;
  const col = Math.max(floor, Math.min(cap, share));
  const slack = num(env, decls, '--card-slack');
  return { cards, room: width, need: k * col + (k - 1) * GAP + 2 * pad, col, tall: rows * col * TALL + (rows - 1) * GAP, height: height - slack };
}

/** The viewer's four lanes on a battlefield whose content box is `width`×`height`, `lanes` piles in each. */
function layLanes(width: number, height: number, lanes: readonly number[]): Laid {
  const zone = element(element(BOARD, customs(BATTLEFIELD)), new Map([['--zone-w', px(width)], ['--zone-h', px(height)]]));
  const aspect = band(width, height);
  const rowsDecls = declared(
    (s) => s === '.zone__rows' || s === '.seat > .zone--battlefield > .zone__rows' || bandRule(aspect)(s) && s.endsWith(':is(.zone__rows, .zone__cards, .card-backs)'),
  );
  const empty = lanes.filter((n) => n === 0).length;
  const total = lanes.reduce((a, b) => a + b, 0);
  // `:has()` counts the empty lanes; the model writes the count it would.
  const rowsEnv = element(zone, new Map([...customs(rowsDecls), ['--cols', String(total)], ...(rowsDecls.has('--lanes-empty') ? [['--lanes-empty', String(empty)] as const] : [])]));
  const rows = evaluate(rowsEnv.get('--rows')!).n;

  const laneDecls = declared(exactly('.zone__row'));
  const emptyDecls = declared(exactly('.zone__row[data-empty]'));
  const listDecls = declared((s) => s === '.seat > .zone--battlefield .zone__row > .zone__cards');
  const groupGap = evaluate(zone.get('--group-gap')!).n;
  const basis = (n: number): number => evaluate(substitute(n === 0 ? emptyDecls.get('flex')!.split(' ')[2]! : laneDecls.get('flex')!.split(' ')[2]!, (k) => rowsEnv.get(k))).n;
  const grow = lanes.map((n) => (n === 0 ? 0 : num(element(rowsEnv, new Map([['--cols', String(n)]])), laneDecls, 'flex-grow')));
  const free = width - 3 * groupGap - lanes.reduce((a, n) => a + basis(n), 0);
  const growTotal = grow.reduce((a, b) => a + b, 0);
  const rule = evaluate(substitute(laneDecls.get('border-left')!.split(' ')[0]!, (k) => rowsEnv.get(k))).n;
  return {
    rows,
    lanes: lanes.flatMap((n, i) => {
      if (n === 0) return [];
      const outer = basis(n) + (growTotal > 0 ? (free * grow[i]!) / growTotal : 0);
      const inner = outer - (i === 0 ? 0 : rule);
      const lane = element(element(rowsEnv, customs(laneDecls)), new Map([['--zone-w', px(inner)], ['--zone-h', px(height)], ['--cols', String(n)]]));
      const list = element(lane, customs(listDecls));
      return [grid(list, listDecls, inner, height, Math.ceil(n / rows), rows, n)];
    }),
  };
}

/** The opponent's two tiers: lands behind, the rest in front, each list `--cols` of the busier one. */
function layTiers(width: number, height: number, lands: number, rest: number): Laid {
  const zone = element(element(BOARD, customs(BATTLEFIELD)), new Map([['--zone-w', px(width)], ['--zone-h', px(height)]]));
  const tiers = element(zone, customs(declared(exactly('.zone__tiers'))));
  const listDecls = declared(exactly('.seat > .zone--battlefield .zone__tiers > .zone__cards'));
  const cols = Math.max(lands, rest);
  const list = element(tiers, new Map([...customs(listDecls), ['--cols', String(cols)]]));
  // Each tier is one row of the two the zone's height is shared by.
  const tier = (height - GAP) / 2;
  return {
    rows: 2,
    lanes: [lands, rest].filter((n) => n > 0).map((n) => {
      const laid = grid(list, listDecls, width, height, cols, 1, n);
      return { ...laid, height: tier };
    }),
  };
}

/** Your own hand: one list, its own row decision from its own box. */
function layHand(width: number, height: number, cards: number): Laid {
  const zone = element(BOARD, new Map([['--zone-w', px(width)], ['--zone-h', px(height)]]));
  const aspect = band(width, height);
  const listDecls = declared(
    (s) =>
      s === '.zone--hand > :is(.zone__cards, .card-backs)' ||
      s === '.seat[data-viewer] > .zone--hand > .zone__cards' ||
      (bandRule(aspect)(s) && s.endsWith(':is(.zone__rows, .zone__cards, .card-backs)')),
  );
  const list = element(zone, new Map([...customs(listDecls), ['--cols', String(cards)]]));
  const rows = evaluate(list.get('--rows')!).n;
  return { rows, lanes: [grid(list, listDecls, width, height, Math.ceil(cards / rows), rows, cards)] };
}

/** The probe's split (`e2e/table-fit.spec.ts`'s `share`), and the shapes a real game also makes. */
function splits(n: number): number[][] {
  const lands = Math.max(1, Math.round(n * 0.45));
  const creatures = Math.max(1, Math.round(n * 0.4));
  const artifacts = Math.max(1, Math.min(2, n - lands - creatures));
  const probe = [lands, artifacts, creatures, Math.max(0, n - lands - creatures - artifacts)];
  const landsAndCreatures = [Math.ceil(n * 0.6), 0, Math.floor(n * 0.4), 0];
  const even = [0, 1, 2, 3].map((i) => Math.floor((n + 3 - i) / 4));
  return [probe, landsAndCreatures, even, [n, 0, 0, 0]];
}

/** What is wrong with a layout: a lane whose columns overflow it, a card under `--card-min`, rows taller than the box. */
function faults(laid: Laid): string[] {
  return laid.lanes.flatMap((l) => [
    ...(l.need > l.room + 0.5 ? [`${l.cards} cards need ${l.need.toFixed(1)}px in ${l.room.toFixed(1)}px`] : []),
    ...(l.col < CARD_MIN - 0.5 ? [`${l.cards} cards draw ${l.col.toFixed(1)}px, under --card-min`] : []),
    ...(l.tall > l.height + 0.5 ? [`${laid.rows} rows of ${l.col.toFixed(1)}px cards are ${l.tall.toFixed(1)}px in ${l.height.toFixed(1)}px`] : []),
  ]);
}

describe('a crowded zone takes another row before its cards stop fitting (table-fit, bob at 1366×768)', () => {
  it('the measured red: 16 permanents on the 904×191 battlefield at 1366 do not draw one row of lanes too narrow for their cards', () => {
    const laid = layLanes(904 - GUTTER, 191, [7, 2, 6, 1]);
    expect(faults(laid), `${laid.rows} rows`).toEqual([]);
  });

  it('keeps the two rows of 63px cards 16 permanents draw at 1280 (818×200)', () => {
    const laid = layLanes(818 - GUTTER, 200, [7, 2, 6, 1]);
    expect(laid.rows).toBe(2);
    expect(Math.min(...laid.lanes.map((l) => l.col))).toBeCloseTo(62.9, 0);
  });

  it('keeps one row wherever one row holds its columns at --card-min: twelve at 1366, eleven at 1280', () => {
    expect(layLanes(904 - GUTTER, 191, [8, 0, 4, 0]).rows).toBe(1);
    expect(layLanes(818 - GUTTER, 200, [5, 2, 4, 0]).rows).toBe(1);
  });

  it('never lays out a battlefield or a hand that does not fit, at every width from 800 to 1000 and 8 to 20 permanents', () => {
    const bad: string[] = [];
    for (let box = 800; box <= 1000; box += 2) {
      for (const height of [180, 191, 200, 210]) {
        const width = box - GUTTER;
        for (let n = 8; n <= 20; n++) {
          for (const lanes of splits(n)) {
            const f = faults(layLanes(width, height, lanes));
            if (f.length > 0) bad.push(`your ${box}x${height} [${lanes.join(',')}]: ${f.join('; ')}`);
          }
          const lands = Math.round(n * 0.45);
          const f = faults(layTiers(width, height, lands, n - lands));
          if (f.length > 0) bad.push(`their ${box}x${height} ${lands}+${n - lands}: ${f.join('; ')}`);
        }
      }
      for (const height of [96, 110, 130]) {
        for (let n = 1; n <= 14; n++) {
          const f = faults(layHand(box - GUTTER, height, n));
          if (f.length > 0) bad.push(`hand ${box}x${height} of ${n}: ${f.join('; ')}`);
        }
      }
    }
    expect(bad.slice(0, 12), `${bad.length} layouts do not fit`).toEqual([]);
  });
});
