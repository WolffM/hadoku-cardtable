/*
 * The events arm, against real decoded GameEvents.
 *
 * Every positive case here is a captured instance — `fixtures/<Class>.json`,
 * written by `capture/EventCapture.java` from WrappedEvent bytes taken off a
 * real client socket — not a hand-built example. Every negative is generated
 * from those instances by breaking them one node at a time, and must fail with
 * an issue whose path names the broken node (or an ancestor of it). That is
 * what makes loosening any one schema show up as a named, counted failure.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EVENTS_NEEDING_JAVA_HELP,
  GameEventListSchema,
  GameEventSchema,
  MODELLED_EVENTS,
  MODELLED_EVENT_NAMES,
  REFUSED_EVENT_NAMES,
  eventRefusal,
} from './index.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

interface CensusClass {
  count: number;
  rules: string[];
  javaSideHelp: boolean;
  samples: number;
  fixturesCoverRun: boolean;
}
interface Census {
  games: number;
  events: number;
  classes: Record<string, CensusClass>;
}

const census = JSON.parse(readFileSync(join(FIXTURES, 'census.json'), 'utf8')) as Census;

const fixtureFiles = readdirSync(FIXTURES)
  .filter((f) => f.startsWith('GameEvent') && f.endsWith('.json'))
  .sort();

const fixtures: Record<string, unknown[]> = Object.fromEntries(
  fixtureFiles.map((f) => [
    f.replace(/\.json$/, ''),
    JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as unknown[],
  ]),
);

/* ── The mutation battery ─────────────────────────────────────────────── */

type Path = Array<string | number>;

interface Mutation {
  label: string;
  /** The issue must be reported at this path or an ancestor of it. */
  at: Path;
  input: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Same rule as `../malformed.ts`: a value of a PLAINLY different type. */
function wrongTypeFor(value: unknown): unknown {
  if (typeof value === 'string') return 42;
  if (typeof value === 'number') return 'not-a-number';
  if (typeof value === 'boolean') return 'not-a-boolean';
  if (Array.isArray(value)) return { notAnArray: true };
  return 42; // objects and null: no field here is nullable over a number
}

function replaceAt(root: unknown, path: Path, fn: (parent: Record<string | number, unknown>, key: string | number) => void): unknown {
  const copy = structuredClone(root) as Record<string | number, unknown>;
  let node: Record<string | number, unknown> = copy;
  for (const step of path.slice(0, -1)) node = node[step] as Record<string | number, unknown>;
  fn(node, path[path.length - 1]);
  return copy;
}

/**
 * Every single-node break of one valid instance:
 *
 *   wrongType:<path>  a node replaced by a plainly wrong type
 *   missing:<path>    an object key deleted (not under `props`, whose keys are
 *                     optional by construction — an unset TrackableProperty is
 *                     absent from the bag)
 *   extra:<path>      an unrecognised key added to an object — the one that
 *                     dies first if a `strictObject` is loosened
 */
function mutationsOf(valid: unknown): Mutation[] {
  const out: Mutation[] = [];
  const walk = (node: unknown, path: Path): void => {
    if (path.length > 0 && !(path.length === 1 && path[0] === 'event')) {
      out.push({
        label: `wrongType:${path.join('.')}`,
        at: path,
        input: replaceAt(valid, path, (p, k) => (p[k] = wrongTypeFor(node))),
      });
    }
    if (isRecord(node)) {
      out.push({
        label: `extra:${[...path, '__extra'].join('.')}`,
        at: path,
        input: path.length === 0
          ? { ...node, __extra: 'surplus' }
          : replaceAt(valid, path, (p, k) => (p[k] = { ...node, __extra: 'surplus' })),
      });
      for (const [key, child] of Object.entries(node)) {
        const childPath = [...path, key];
        const optional = path[path.length - 1] === 'props';
        if (!optional) {
          out.push({
            label: `missing:${childPath.join('.')}`,
            at: childPath,
            input: replaceAt(valid, childPath, (p, k) => delete p[k]),
          });
        }
        walk(child, childPath);
      }
    } else if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...path, i]));
    }
  };
  walk(valid, []);
  return out;
}

function isPrefix(prefix: readonly PropertyKey[], of: Path): boolean {
  return prefix.length <= of.length && prefix.every((step, i) => step === of[i]);
}

/** Labels of the mutations that did NOT fail where they should. Empty is a pass. */
function unbitten(instances: unknown[]): { checked: number; escaped: string[] } {
  let checked = 0;
  const escaped: string[] = [];
  instances.forEach((valid, n) => {
    for (const m of mutationsOf(valid)) {
      checked++;
      const r = GameEventSchema.safeParse(m.input);
      if (r.success) {
        escaped.push(`#${n} ${m.label}: PARSED`);
      } else if (!r.error.issues.some((i) => isPrefix(i.path, m.at))) {
        escaped.push(
          `#${n} ${m.label}: failed, but at ${r.error.issues.map((i) => i.path.join('.')).join(' | ')}`,
        );
      }
    }
  });
  return { checked, escaped };
}

/* ── Tests ───────────────────────────────────────────────────────────── */

describe('events arm — inventory', () => {
  it('models 41 classes and refuses 17: the 58 Forge declares, no overlap', () => {
    expect(MODELLED_EVENT_NAMES).toHaveLength(41);
    expect(REFUSED_EVENT_NAMES).toHaveLength(17);
    const all = new Set([...MODELLED_EVENT_NAMES, ...REFUSED_EVENT_NAMES]);
    expect(all.size).toBe(58);
    for (const name of all) expect(name).toMatch(/^GameEvent[A-Z][A-Za-z]+$/);
  });

  it('the committed capture fired exactly the 41 modelled classes — nothing unmodelled, nothing modelled unseen', () => {
    expect(Object.keys(census.classes).sort()).toEqual([...MODELLED_EVENT_NAMES].sort());
    for (const c of Object.values(census.classes)) expect(c.count).toBeGreaterThan(0);
  });

  it('every modelled class has a committed fixture file, and there are no others', () => {
    expect(Object.keys(fixtures)).toEqual([...MODELLED_EVENT_NAMES].sort());
    for (const instances of Object.values(fixtures)) expect(instances.length).toBeGreaterThan(0);
  });

  it('the fixtures are the census samples, and cover every (path, kind) pair the capture produced', () => {
    for (const [name, c] of Object.entries(census.classes)) {
      expect(fixtures[name], name).toHaveLength(c.samples);
      expect(c.fixturesCoverRun, name).toBe(true);
    }
  });

  it('the Java-side-help list is what the capture computed, not what someone typed', () => {
    const computed = Object.entries(census.classes)
      .filter(([, c]) => c.javaSideHelp)
      .map(([name]) => name)
      .sort();
    expect([...Object.keys(EVENTS_NEEDING_JAVA_HELP)].sort()).toEqual(computed);
  });
});

describe('events arm — captured instances parse', () => {
  it.each(MODELLED_EVENT_NAMES)('%s: every captured instance parses, as itself and as a GameEvent', (name) => {
    const own = MODELLED_EVENTS[name];
    for (const instance of fixtures[name]) {
      const r = own.safeParse(instance);
      expect(r.success ? null : r.error.issues).toBeNull();
      expect(GameEventSchema.safeParse(instance).success).toBe(true);
    }
  });

  it('a mixed list of every fixture parses as DeltaPacket.events', () => {
    const all = Object.values(fixtures).flat();
    expect(GameEventListSchema.safeParse(all).success).toBe(true);
  });
});

const breaks = MODELLED_EVENT_NAMES.map(
  (name) => [name, fixtures[name].reduce((n: number, v) => n + mutationsOf(v).length, 0)] as const,
);

describe('events arm — every single-node break of a captured instance fails, at that node', () => {
  it.each(breaks)('%s — %i breaks', (name, count) => {
    const { checked, escaped } = unbitten(fixtures[name]);
    expect(escaped).toEqual([]);
    expect(checked).toBe(count);
    // A class with no components still has `extra:` and `missing:event`.
    expect(checked).toBeGreaterThan(0);
  });

  it('names the path: a captured GameEventCardTapped with `tapped` as a string fails at ["tapped"]', () => {
    const tapped = structuredClone(fixtures.GameEventCardTapped[0]) as Record<string, unknown>;
    tapped.tapped = 'yes';
    const r = GameEventSchema.safeParse(tapped);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path)).toEqual([['tapped']]);
  });

  it('names the path: a captured GameEventTurnBegan without `turnNumber` fails at ["turnNumber"]', () => {
    const began = structuredClone(fixtures.GameEventTurnBegan[0]) as Record<string, unknown>;
    delete began.turnNumber;
    const r = GameEventSchema.safeParse(began);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path)).toEqual([['turnNumber']]);
  });
});

describe('events arm — the 17 unseen classes refuse, by name', () => {
  it.each(REFUSED_EVENT_NAMES)('%s refuses with its own sentence', (name) => {
    // A plausible instance — the frame a future session would hand-build.
    const r = GameEventSchema.safeParse({ event: name, player: { kind: 'player', id: 0 } });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toHaveLength(1);
    expect(r.error?.issues[0].message).toBe(eventRefusal(name));
  });

  it('every refusal names its event, where Forge fires it, and the capture that would settle it', () => {
    for (const name of REFUSED_EVENT_NAMES) {
      const msg = eventRefusal(name);
      expect(msg).toContain(name);
      expect(msg).toContain('Fired by: ');
      expect(msg).toContain('Settle it with: ');
      expect(msg).toContain('events/capture/run.sh');
    }
  });

  it('a refused arm cannot be satisfied by supplying the `refused` key', () => {
    for (const value of [null, true, 'ok', {}, []]) {
      expect(GameEventSchema.safeParse({ event: 'GameEventSurveil', refused: value }).success).toBe(false);
    }
  });

  it('an event name outside the 58 is rejected at the discriminator', () => {
    const r = GameEventSchema.safeParse({ event: 'GameEventInvented' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(['event']);
  });
});
