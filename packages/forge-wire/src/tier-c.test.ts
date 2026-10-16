/*
 * Tier C — the state channel, checked against what a real match put on it.
 *
 * Every positive case below parses a packet Wave 7 lane A captured from a live
 * Forge match (`scripts/spike/tierc/out/`), not a hand-built one. Every
 * negative case is one of those packets with ONE thing changed, and asserts
 * the exact path the failure is reported at — a schema that rejects a mutation
 * for the wrong reason is not checking what the test says it is.
 *
 * The census and coverage tables are held against `tier-c.ts` in both
 * directions: every property the spike saw, at the tag it saw, is accepted, and
 * the 214-property table is the spike's table, constant for constant.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ApplyDeltaSchema,
  CantBlockSchema,
  ConditionMetSchema,
  PrintedTypesSchema,
  LifePayingSchema,
  DamageSchema,
  DeathsSchema,
  DECLARED_TYPE_SCHEMAS,
  DELTA_OBJECT_TYPES,
  DeltaPacketSchema,
  GameStateSchema,
  OpenViewSchema,
  STATE_PROPERTIES,
  STATE_PROPERTY_COUNT,
  SetGameViewSchema,
  StackTargetSpellsSchema,
  TIER_C_METHODS,
  TIER_C_REPLIES,
  TIER_C_SPIKE,
  TaggedValueSchema,
  TrackedObjectSchema,
  UNOBSERVED_DECLARED_TYPES,
  deltaKeyId,
  deltaKeyOf,
  deltaKeyType,
  type StateProperty,
} from './tier-c.ts';
import {
  BLOCKING_METHODS,
  REPLY_SCHEMAS,
  REQUIRED_METHODS,
  isTierC,
  safeParseServerFrame,
} from './envelope.ts';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const CAPTURES = join(SRC_DIR, '..', '..', '..', 'scripts', 'spike', 'tierc', 'out');

/* ── Loading the captures ────────────────────────────────────────────── */

type Json = Record<string, unknown>;

interface Capture {
  /** Java's `DeltaPacket.toString()`, e.g. `DeltaPacket[seq=8, newObjects=0, deltas=4, …]`. */
  readonly header: string;
  readonly packet: Json;
  /** Objects the harness dropped from each map to keep the committed sample small. */
  readonly omitted: { readonly newObjects: number; readonly objectDeltas: number };
}

/**
 * Read a committed sample and remove the harness's own annotations, which are
 * not wire: the `// DeltaPacket[…]` first line, `_truncatedTo`, and each map's
 * `_omitted` count (`JsonDelta.packetToJson(p, limit)`, `JsonDelta.java:877-924`).
 * Each is asserted present before it is removed, so a change to the harness's
 * format fails here instead of silently feeding the schema something new.
 */
function loadCapture(name: string): Capture {
  const text = readFileSync(join(CAPTURES, name), 'utf8');
  const newline = text.indexOf('\n');
  const header = text.slice(0, newline);
  expect(header).toMatch(/^\/\/ DeltaPacket\[/);
  const packet = JSON.parse(text.slice(newline + 1)) as Json;
  expect(packet).toHaveProperty('_truncatedTo');
  delete packet._truncatedTo;
  const omitted = { newObjects: 0, objectDeltas: 0 };
  for (const map of ['newObjects', 'objectDeltas'] as const) {
    const table = packet[map] as Json;
    if ('_omitted' in table) {
      omitted[map] = table._omitted as number;
      delete table._omitted;
    }
  }
  return { header: header.slice(3), packet, omitted };
}

function readTsv(name: string): Record<string, string>[] {
  const [head, ...rows] = readFileSync(join(CAPTURES, name), 'utf8').trimEnd().split('\n');
  const columns = head!.split('\t');
  return rows.map((row) => {
    const cells = row.split('\t');
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
  });
}

const clone = <T>(value: T): T => structuredClone(value);

/** The committed mid-game delta: seq 8, four objects changed, none created. */
const DELTA = loadCapture('sample-delta.json');
/** The committed opening full sync: seq 1, 243 new objects (3 kept, 240 omitted). */
const FULL_SYNC = loadCapture('sample-newobjects.json');

const CENSUS = readTsv('census.tsv');
const COVERAGE = readTsv('coverage.tsv');

// Delta keys the committed samples use: player 0, player 1, the GameView, card 3.
const PLAYER_0 = String(deltaKeyOf(1, 0));
const GAME = String(deltaKeyOf(3, 1));
const CARD_3 = String(deltaKeyOf(0, 3));

function issuesOf(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  return result.error!.issues;
}

/** The single issue a one-change mutation must produce, and its path. */
function onlyIssue(schema: z.ZodType, value: unknown) {
  const issues = issuesOf(schema, value);
  expect(issues).toHaveLength(1);
  return issues[0]!;
}

/* ── The methods ─────────────────────────────────────────────────────── */

describe('Tier C — three methods, all server→client, none blocking', () => {
  it('is exactly three methods, all of them in the required 38', () => {
    expect(TIER_C_METHODS).toEqual(['setGameView', 'openView', 'applyDelta']);
    for (const method of TIER_C_METHODS) {
      expect(REQUIRED_METHODS).toContain(method);
      expect(isTierC(method)).toBe(true);
    }
    expect(TIER_C_SPIKE).toBe('docs/spikes/tier-c.md');
  });

  it('has no reply schemas, because none of the three blocks', () => {
    expect(Object.keys(TIER_C_REPLIES)).toEqual([]);
    for (const method of TIER_C_METHODS) {
      expect(BLOCKING_METHODS).not.toContain(method);
      expect(Object.keys(REPLY_SCHEMAS)).not.toContain(method);
    }
  });
});

/* ── Positive: the captured packets validate ─────────────────────────── */

describe('Tier C — the captured packets validate', () => {
  it('the samples are the packets their Java headers describe', () => {
    // `DeltaPacket.toString()` counts the WHOLE packet; the sample kept a few.
    const count = (c: Capture, map: 'newObjects' | 'objectDeltas') =>
      Object.keys(c.packet[map] as Json).length + c.omitted[map];
    for (const c of [DELTA, FULL_SYNC]) {
      const [, seq, created, changed] = /seq=(-?\d+), newObjects=(\d+), deltas=(\d+)/.exec(
        c.header,
      )!;
      expect(c.packet.seq).toBe(Number(seq));
      expect(count(c, 'newObjects')).toBe(Number(created));
      expect(count(c, 'objectDeltas')).toBe(Number(changed));
    }
    expect(FULL_SYNC.omitted.newObjects).toBe(240);
  });

  it('applyDelta: the mid-game delta parses as a DeltaPacket', () => {
    const result = DeltaPacketSchema.safeParse(DELTA.packet);
    expect(result.error?.issues).toBeUndefined();
    // Integer-like keys enumerate in numeric order in JS, not in the packet's order.
    expect(Object.keys(result.data!.objectDeltas).sort()).toEqual(
      [PLAYER_0, GAME, String(deltaKeyOf(1, 1)), CARD_3].sort(),
    );
  });

  it('applyDelta: the opening full sync parses as a DeltaPacket', () => {
    const result = DeltaPacketSchema.safeParse(FULL_SYNC.packet);
    expect(result.error?.issues).toBeUndefined();
  });

  it('applyDelta: both travel the envelope as notify frames', () => {
    for (const c of [DELTA, FULL_SYNC]) {
      const frame = { kind: 'notify', method: 'applyDelta', payload: { packet: c.packet } };
      expect(ApplyDeltaSchema.safeParse(frame).success).toBe(true);
      const outcome = safeParseServerFrame(frame);
      expect(outcome.ok ? [] : outcome.errors).toEqual([]);
    }
  });

  it('setGameView: the full sync’s object table is a whole game state', () => {
    const gameView = FULL_SYNC.packet.newObjects;
    expect(GameStateSchema.safeParse(gameView).error?.issues).toBeUndefined();
    const frame = {
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView, sequenceNumber: FULL_SYNC.packet.seq },
    };
    expect(SetGameViewSchema.safeParse(frame).success).toBe(true);
    expect(safeParseServerFrame(frame).ok).toBe(true);
  });

  it('openView: the captured GameView’s players are a valid seat list', () => {
    const game = (FULL_SYNC.packet.newObjects as Record<string, Json>)[GAME]!;
    const players = (game.Players as { v: { v: number }[] }).v.map((p) => p.v);
    expect(players).toEqual([0, 1]);
    const frame = { kind: 'notify', method: 'openView', payload: { myPlayers: players } };
    expect(OpenViewSchema.safeParse(frame).success).toBe(true);
    expect(safeParseServerFrame(frame).ok).toBe(true);
  });

  it('null is a value, not an absent key — the captured clears parse', () => {
    const objects = DELTA.packet.objectDeltas as Record<string, Json>;
    expect(objects[CARD_3]).toEqual({ _type: 0, _id: 3, Sickness: null });
    expect(objects[GAME]!.CombatView).toBeNull();
    expect(TrackedObjectSchema.safeParse(objects[CARD_3]).success).toBe(true);
  });

  it('delta keys decode the way DeltaPacket.java packs them', () => {
    expect(deltaKeyOf(1, 0)).toBe(268435456);
    expect(deltaKeyOf(3, 1)).toBe(805306369);
    expect([deltaKeyType(805306369), deltaKeyId(805306369)]).toEqual([3, 1]);
    // A CardStateView id is cardId * 16 + state ordinal.
    expect(deltaKeyId(deltaKeyOf(4, 7 * 16 + 1))).toBe(113);
    expect(DELTA_OBJECT_TYPES[deltaKeyType(Number(GAME))]).toBe('game');
  });
});

/* ── The tables: the spike's census and coverage, both directions ───── */

/** The `t` literal a property's schema accepts, or `'*'` for the generic fallback. */
function tagOf(property: StateProperty): string {
  const optional = TrackedObjectSchema.shape[property] as z.ZodOptional<z.ZodNullable<z.ZodType>>;
  const inner = optional.unwrap().unwrap();
  if (inner === TaggedValueSchema) return '*';
  return ((inner as z.ZodObject).shape.t as z.ZodLiteral<string>).value;
}

describe('Tier C — the property table is the spike’s table', () => {
  it('is the 214 TrackableProperty constants, in coverage.tsv’s declaration order', () => {
    expect(STATE_PROPERTY_COUNT).toBe(214);
    expect(COVERAGE).toHaveLength(214);
    expect(Object.keys(STATE_PROPERTIES)).toEqual(COVERAGE.map((r) => r.property));
  });

  it('gives every property the declared type coverage.tsv records', () => {
    const declared = Object.fromEntries(COVERAGE.map((r) => [r.property, r.declaredType]));
    expect(STATE_PROPERTIES).toEqual(declared);
    for (const type of Object.values(STATE_PROPERTIES)) {
      expect(Object.keys(DECLARED_TYPE_SCHEMAS)).toContain(type);
    }
  });

  it('falls back to the generic value ONLY for the declared types no run observed', () => {
    const observed = new Set(
      COVERAGE.filter((r) => r.observed === 'yes').map((r) => r.declaredType),
    );
    const never = [...new Set(COVERAGE.map((r) => r.declaredType))].filter((t) => !observed.has(t));
    expect(never.sort()).toEqual([...UNOBSERVED_DECLARED_TYPES].sort());
    for (const [property, type] of Object.entries(STATE_PROPERTIES)) {
      const generic = (UNOBSERVED_DECLARED_TYPES as readonly string[]).includes(type);
      expect([property, tagOf(property as StateProperty) === '*']).toEqual([property, generic]);
    }
  });

  it('the census is clean: 133 pairs, every one round-tripped, none a reference', () => {
    expect(CENSUS).toHaveLength(133);
    for (const row of CENSUS) {
      expect([row.property, row.outcome, row.failEncode, row.failDecode, row.failCompare]).toEqual([
        row.property,
        'OK',
        '0',
        '0',
        '0',
      ]);
      expect(['ref', 'refs', 'record', 'bytes']).not.toContain(row.jsonTag);
    }
  });

  it('accepts every (property, tag) pair the census saw, at exactly that tag', () => {
    for (const row of CENSUS) {
      const property = row.property as StateProperty;
      expect(STATE_PROPERTIES).toHaveProperty(property);
      const schema = TrackedObjectSchema.shape[property] as z.ZodType;
      if (row.jsonTag === 'null') {
        expect([property, schema.safeParse(null).success]).toEqual([property, true]);
      } else {
        expect([property, tagOf(property)]).toEqual([property, row.jsonTag]);
      }
    }
  });
});

/* ── Negative: one change to a captured packet, and the path it fails at ─ */

describe('Tier C — a mutated capture fails, naming the path', () => {
  it('a GameView Turn retagged as a Java long fails at …Turn.t', () => {
    const packet = clone(DELTA.packet);
    ((packet.objectDeltas as Record<string, Json>)[GAME]!.Turn as Json).t = 'long';
    const issue = onlyIssue(DeltaPacketSchema, packet);
    expect(issue.path).toEqual(['objectDeltas', GAME, 'Turn', 't']);
  });

  it('an object REFERENCE in a zone list fails at the element — ids only cross this wire', () => {
    const packet = clone(DELTA.packet);
    const library = (packet.objectDeltas as Record<string, Json>)[PLAYER_0]!.Library as {
      v: unknown[];
    };
    library.v[0] = { t: 'ref', k: 0, id: 18 };
    // JsonDelta's ref shape differs from an int in three places — tag, the
    // missing `v`, the extra `k`/`id` — and each is reported, all at element 0.
    const element = ['objectDeltas', PLAYER_0, 'Library', 'v', 0];
    const paths = issuesOf(DeltaPacketSchema, packet).map((i) => i.path);
    expect(paths).toEqual([
      [...element, 't'],
      [...element, 'v'],
      element,
    ]);
  });

  it('a phase that does not exist fails at …Phase.v', () => {
    const packet = clone(DELTA.packet);
    ((packet.objectDeltas as Record<string, Json>)[GAME]!.Phase as Json).v = 'MAIN3';
    const issue = onlyIssue(DeltaPacketSchema, packet);
    expect(issue.path).toEqual(['objectDeltas', GAME, 'Phase', 'v']);
  });

  it('a property outside the 214 fails on its object, and names itself', () => {
    const packet = clone(DELTA.packet);
    (packet.objectDeltas as Record<string, Json>)[PLAYER_0]!.Lifee = { t: 'int', v: 20 };
    const issue = onlyIssue(DeltaPacketSchema, packet);
    expect(issue.path).toEqual(['objectDeltas', PLAYER_0]);
    expect(issue).toMatchObject({ code: 'unrecognized_keys', keys: ['Lifee'] });
  });

  it('an object whose _type disagrees with its delta key fails at …_type', () => {
    const packet = clone(DELTA.packet);
    (packet.objectDeltas as Record<string, Json>)[CARD_3]!._type = 1;
    const issue = onlyIssue(DeltaPacketSchema, packet);
    expect(issue.path).toEqual(['objectDeltas', CARD_3, '_type']);
  });

  it('an object whose _id disagrees with its delta key fails at …_id', () => {
    const packet = clone(DELTA.packet);
    (packet.objectDeltas as Record<string, Json>)[CARD_3]!._id = 4;
    const issue = onlyIssue(DeltaPacketSchema, packet);
    expect(issue.path).toEqual(['objectDeltas', CARD_3, '_id']);
  });

  it('a delta key that is not a Java int fails at the key', () => {
    const packet = clone(DELTA.packet);
    const table = packet.objectDeltas as Record<string, Json>;
    table['-3'] = table[CARD_3]!;
    delete table[CARD_3];
    const issue = onlyIssue(DeltaPacketSchema, packet);
    expect(issue.path).toEqual(['objectDeltas', '-3']);
  });

  it('an object with no properties fails — Forge never sends one', () => {
    const packet = clone(DELTA.packet);
    delete (packet.objectDeltas as Record<string, Json>)[CARD_3]!.Sickness;
    const issue = onlyIssue(DeltaPacketSchema, packet);
    expect(issue.path).toEqual(['objectDeltas', CARD_3]);
  });

  it('a sequence number sent as a string fails at seq', () => {
    const packet = clone(DELTA.packet);
    packet.seq = '8';
    expect(onlyIssue(DeltaPacketSchema, packet).path).toEqual(['seq']);
  });

  it('a checksum ordinal past the 214th property fails at its index', () => {
    const packet = clone(DELTA.packet);
    packet.checksumProperties = [0, 214];
    expect(onlyIssue(DeltaPacketSchema, packet).path).toEqual(['checksumProperties', 1]);
  });

  it('a packet with no events arm fails at events', () => {
    const packet = clone(DELTA.packet);
    delete packet.events;
    expect(onlyIssue(DeltaPacketSchema, packet).path).toEqual(['events']);
  });

  it('the envelope reports the full path, frame to field', () => {
    const packet = clone(DELTA.packet);
    ((packet.objectDeltas as Record<string, Json>)[GAME]!.Turn as Json).t = 'long';
    const frame = { kind: 'notify', method: 'applyDelta', payload: { packet } };
    const outcome = safeParseServerFrame(frame);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.map((e) => e.path)).toEqual([
      `$.payload.packet.objectDeltas.${GAME}.Turn.t`,
    ]);
  });

  it('a game state without its GameView is not a game state', () => {
    const gameView = clone(FULL_SYNC.packet.newObjects) as Record<string, Json>;
    delete gameView[GAME];
    const issue = onlyIssue(SetGameViewSchema, {
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView, sequenceNumber: 1 },
    });
    expect(issue.path).toEqual(['payload', 'gameView']);
    expect(issue.message).toContain('exactly one GameView');
  });

  it('a player’s Hand carrying a string id fails at the element', () => {
    const packet = clone(FULL_SYNC.packet);
    const hand = (packet.newObjects as Record<string, Json>)[PLAYER_0]!.Hand as { v: Json[] };
    hand.v[2] = { t: 'int', v: '3' };
    const issue = onlyIssue(DeltaPacketSchema, packet);
    expect(issue.path).toEqual(['newObjects', PLAYER_0, 'Hand', 'v', 2, 'v']);
  });

  it('openView refuses an empty or repeated seat list', () => {
    const frame = (myPlayers: unknown) => ({
      kind: 'notify',
      method: 'openView',
      payload: { myPlayers },
    });
    expect(onlyIssue(OpenViewSchema, frame([])).path).toEqual(['payload', 'myPlayers']);
    expect(onlyIssue(OpenViewSchema, frame([0, 0])).path).toEqual(['payload', 'myPlayers']);
  });
});

/* ── CombatData: the one value with a cross-field rule ───────────────── */

describe('Tier C — CombatData', () => {
  // Copied from a live combat packet in a full-stream re-run of the Wave 7
  // harness, which is not committed. The committed samples were taken outside
  // combat, so this one value is hand-carried — and says so.
  const CAPTURED = {
    t: 'combat',
    atk: [[65], [114]],
    def: [
      [1, 0],
      [1, 0],
    ],
    blk: [[], []],
    pblk: [[], []],
  };

  function withCombat(combat: unknown): Json {
    const packet = clone(DELTA.packet);
    (packet.objectDeltas as Record<string, Json>)[GAME]!.CombatView = combat;
    return packet;
  }

  it('accepts the captured shape', () => {
    expect(DeltaPacketSchema.safeParse(withCombat(CAPTURED)).error?.issues).toBeUndefined();
  });

  it('fails a band count mismatch at the list that is short', () => {
    const issue = onlyIssue(DeltaPacketSchema, withCombat({ ...CAPTURED, blk: [[]] }));
    expect(issue.path).toEqual(['objectDeltas', GAME, 'CombatView', 'blk']);
  });

  it('fails a defender marker that is neither card nor player', () => {
    const issue = onlyIssue(DeltaPacketSchema, withCombat({ ...CAPTURED, def: [[2, 0], [1, 0]] }));
    expect(issue.path).toEqual(['objectDeltas', GAME, 'CombatView', 'def', 0, 0]);
  });
});

describe('Tier C — stackTargetSpells (wave 49 §A)', () => {
  it('accepts a list of [from, to] id pairs', () => {
    expect(StackTargetSpellsSchema.safeParse([]).success).toBe(true);
    expect(StackTargetSpellsSchema.safeParse([[50, 49]]).success).toBe(true);
    expect(StackTargetSpellsSchema.safeParse([[50, 49], [12, 7]]).success).toBe(true);
  });

  it('rejects a pair that is not exactly two ints', () => {
    expect(StackTargetSpellsSchema.safeParse([[50]]).success).toBe(false);
    expect(StackTargetSpellsSchema.safeParse([[50, 49, 1]]).success).toBe(false);
    expect(StackTargetSpellsSchema.safeParse([['50', 49]]).success).toBe(false);
  });

  it('is optional on setGameView and applyDelta, and additive when present', () => {
    const withoutField = {
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView: FULL_SYNC.packet.newObjects, sequenceNumber: FULL_SYNC.packet.seq },
    };
    expect(SetGameViewSchema.safeParse(withoutField).success).toBe(true);

    const withField = {
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView: FULL_SYNC.packet.newObjects, sequenceNumber: FULL_SYNC.packet.seq, stackTargetSpells: [[50, 49]] },
    };
    const parsed = SetGameViewSchema.safeParse(withField);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.payload.stackTargetSpells).toEqual([[50, 49]]);

    const deltaWithField = {
      kind: 'notify',
      method: 'applyDelta',
      payload: { packet: DELTA.packet, stackTargetSpells: [[50, 49]] },
    };
    expect(ApplyDeltaSchema.safeParse(deltaWithField).success).toBe(true);
  });
});

describe('Tier C — lifePaying', () => {
  it('accepts [playerId, life] pairs and rejects anything else', () => {
    expect(LifePayingSchema.safeParse([]).success).toBe(true);
    expect(LifePayingSchema.safeParse([[1, 4]]).success).toBe(true);
    expect(LifePayingSchema.safeParse([1, 4]).success).toBe(false);
    expect(LifePayingSchema.safeParse([[1, '4']]).success).toBe(false);
  });

  it('is optional on setGameView and applyDelta, and carried when present', () => {
    const view = SetGameViewSchema.safeParse({
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView: FULL_SYNC.packet.newObjects, sequenceNumber: FULL_SYNC.packet.seq, lifePaying: [[1, 2]] },
    });
    expect(view.success && view.data.payload.lifePaying).toEqual([[1, 2]]);
    const delta = ApplyDeltaSchema.safeParse({ kind: 'notify', method: 'applyDelta', payload: { packet: DELTA.packet, lifePaying: [] } });
    expect(delta.success && delta.data.payload.lifePaying).toEqual([]);
  });
});

describe('Tier C — cantBlock', () => {
  it('accepts a list of card ids and rejects anything else', () => {
    expect(CantBlockSchema.safeParse([]).success).toBe(true);
    expect(CantBlockSchema.safeParse([101, 102]).success).toBe(true);
    expect(CantBlockSchema.safeParse(['101']).success).toBe(false);
    expect(CantBlockSchema.safeParse([[101, 102]]).success).toBe(false);
  });

  it('is optional on setGameView and applyDelta, and carried when present', () => {
    const view = SetGameViewSchema.safeParse({
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView: FULL_SYNC.packet.newObjects, sequenceNumber: FULL_SYNC.packet.seq, cantBlock: [101] },
    });
    expect(view.success && view.data.payload.cantBlock).toEqual([101]);
    const delta = ApplyDeltaSchema.safeParse({ kind: 'notify', method: 'applyDelta', payload: { packet: DELTA.packet, cantBlock: [101] } });
    expect(delta.success && delta.data.payload.cantBlock).toEqual([101]);
    expect(ApplyDeltaSchema.safeParse({ kind: 'notify', method: 'applyDelta', payload: { packet: DELTA.packet } }).success).toBe(true);
  });
});

describe('Tier C — printedTypes', () => {
  const land = { t: 'cardtype', sup: [], core: ['Land'], sub: [], all: false, exc: [] };

  it('accepts [cardId, cardtype] pairs and rejects anything else', () => {
    expect(PrintedTypesSchema.safeParse([]).success).toBe(true);
    expect(PrintedTypesSchema.safeParse([[101, land]]).success).toBe(true);
    expect(PrintedTypesSchema.safeParse([[101, 'Land']]).success).toBe(false);
    expect(PrintedTypesSchema.safeParse([[101, { ...land, t: 'str' }]]).success).toBe(false);
  });

  it('is optional on setGameView and applyDelta, and carried when present', () => {
    const view = SetGameViewSchema.safeParse({
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView: FULL_SYNC.packet.newObjects, sequenceNumber: FULL_SYNC.packet.seq, printedTypes: [[101, land]] },
    });
    expect(view.success && view.data.payload.printedTypes).toEqual([[101, land]]);
    const delta = ApplyDeltaSchema.safeParse({ kind: 'notify', method: 'applyDelta', payload: { packet: DELTA.packet, printedTypes: [[101, land]] } });
    expect(delta.success && delta.data.payload.printedTypes).toEqual([[101, land]]);
  });
});

describe('Tier C — damage', () => {
  it('accepts [target, source, amount] triples and rejects anything else', () => {
    expect(DamageSchema.safeParse([]).success).toBe(true);
    expect(DamageSchema.safeParse([[101, 131, 3], [102, -1, 1]]).success).toBe(true);
    expect(DamageSchema.safeParse([[101, 131]]).success).toBe(false);
    expect(DamageSchema.safeParse([101]).success).toBe(false);
  });

  it('is optional on applyDelta and carried when present; a snapshot never carries it', () => {
    const delta = ApplyDeltaSchema.safeParse({ kind: 'notify', method: 'applyDelta', payload: { packet: DELTA.packet, damage: [[101, 131, 3]] } });
    expect(delta.success && delta.data.payload.damage).toEqual([[101, 131, 3]]);
    const view = SetGameViewSchema.safeParse({
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView: FULL_SYNC.packet.newObjects, sequenceNumber: FULL_SYNC.packet.seq, damage: [[101, 131, 3]] },
    });
    expect(view.success).toBe(false);
  });
});

describe('Tier C — deaths', () => {
  it('accepts [cardId, cause] with one of the fork’s causes and rejects anything else', () => {
    expect(DeathsSchema.safeParse([[101, 'DESTROYED'], [102, 'LETHAL_DAMAGE']]).success).toBe(true);
    expect(DeathsSchema.safeParse([[101, 'EXPLODED']]).success).toBe(false);
    expect(DeathsSchema.safeParse([[101]]).success).toBe(false);
  });

  it('is optional on applyDelta and carried when present', () => {
    const delta = ApplyDeltaSchema.safeParse({ kind: 'notify', method: 'applyDelta', payload: { packet: DELTA.packet, deaths: [[101, 'SACRIFICED']] } });
    expect(delta.success && delta.data.payload.deaths).toEqual([[101, 'SACRIFICED']]);
  });
});

describe('Tier C — conditionMet', () => {
  it('accepts a list of card ids and rejects anything else', () => {
    expect(ConditionMetSchema.safeParse([]).success).toBe(true);
    expect(ConditionMetSchema.safeParse([101, 102]).success).toBe(true);
    expect(ConditionMetSchema.safeParse(['101']).success).toBe(false);
  });

  it('is optional on setGameView and applyDelta, and carried when present', () => {
    const view = SetGameViewSchema.safeParse({
      kind: 'notify',
      method: 'setGameView',
      payload: { gameView: FULL_SYNC.packet.newObjects, sequenceNumber: FULL_SYNC.packet.seq, conditionMet: [101] },
    });
    expect(view.success && view.data.payload.conditionMet).toEqual([101]);
    const delta = ApplyDeltaSchema.safeParse({ kind: 'notify', method: 'applyDelta', payload: { packet: DELTA.packet, conditionMet: [101] } });
    expect(delta.success && delta.data.payload.conditionMet).toEqual([101]);
  });
});
