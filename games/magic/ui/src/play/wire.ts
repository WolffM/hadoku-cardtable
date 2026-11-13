/*
 * Tier C state, as this renderer reads it.
 *
 * This is the JSON encoding of Forge's `DeltaPacket` that Wave 7's spike
 * produced and measured (`scripts/spike/tierc/src/JsonDelta.java`,
 * `docs/spikes/tier-c.md`). The delta keys and the tagged-value readers are
 * `@hadoku/forge-wire`'s (`state.ts`), shared with the server's projector; the
 * types here narrow its untyped property bags to the tags this renderer draws,
 * and the fixtures in `./fixtures/` are validated against its schema.
 *
 * ## The shape, in one paragraph
 *
 * A packet carries two maps, `newObjects` and `objectDeltas`, each keyed by a
 * **delta key** — `(typeTag << 28) | id` as a decimal string
 * (`DeltaPacket.makeDeltaKey`). Each value is one object's property bag: the
 * `_type`/`_id` pair, then `TrackableProperty` names mapped to **tagged
 * values** `{t, v}`. Every entity reference has already been flattened to an
 * int id by the server (`DeltaSyncManager.toNetworkValue`); there are no
 * object references in the value position, only ids.
 *
 * A property whose value is JSON `null` was set to null on the server, which in
 * Forge means "back to the default" (`TrackableObject.set` removes the key when
 * the value is null or equals the default). The fold in `./fold.ts` honours
 * that; it is not an absent value and it is not an error.
 */

import { deltaKey, intOf, tagOf } from '@hadoku/forge-wire';

/**
 * A value in the property position. The tags are exactly the ones
 * `JsonDelta.encode` emits and the fixtures contain; anything else is kept as
 * `UnknownTagged` and read as absent rather than guessed at.
 */
export type Tagged =
  | { t: 'str'; v: string }
  | { t: 'int'; v: number }
  | { t: 'long'; v: number }
  | { t: 'byte'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'enum'; c: string; v: string }
  | { t: 'list'; v: Tagged[] }
  | { t: 'set'; v: Tagged[] }
  | { t: 'map'; v: [Tagged, Tagged][] }
  /** `ManaCost.serialize`: generic amount, then `ManaCostShard` names, `\u0006`-delimited. */
  | { t: 'manacost'; v: string }
  | { t: 'cardtype'; sup: string[]; core: string[]; sub: string[]; all: boolean; exc: string[] }
  | { t: 'keywords'; v: string[] }
  /** A counter multiset: `[counterName, count]` pairs. */
  | { t: 'multiset'; v: [string, number][] }
  | { t: 'ints'; v: number[] }
  | { t: 'combat'; atk: number[][]; def: number[][]; blk: number[][]; pblk: number[][] }
  | { t: 'papercard'; n: string; e: string; a: number; f: boolean }
  | UnknownTagged;

export interface UnknownTagged {
  t: string;
  [field: string]: unknown;
}

/** One object's property bag. `_type`/`_id` are the only non-property keys. */
export interface WireObject {
  _type: number;
  _id: number;
  [property: string]: Tagged | null | number;
}

/** A property's tagged value, absent for a missing or null one. */
export function prop(obj: WireObject | undefined, name: string): Tagged | undefined {
  return tagOf(obj, name) as Tagged | undefined;
}

export function readInt(obj: WireObject | undefined, name: string, fallback = 0): number {
  return intOf(obj, name) ?? fallback;
}

/** One `DeltaPacket` in the spike's JSON encoding. */
export interface WirePacket {
  seq: number;
  checksum: number;
  checksumProperties: number[];
  /** The spike's own annotation of what a committed sample leaves out. */
  _truncatedTo?: string;
  /** Keyed by delta key. A truncated sample may also carry `_omitted: n`. */
  newObjects: Record<string, WireObject>;
  objectDeltas: Record<string, WireObject>;
  /** The events arm. Opaque to this lane — lane B owns it. */
  events: unknown[];
}

/**
 * The spike's committed samples are truncated, and say so inside the map:
 * `"_omitted": 240` is how many objects `packetToJson(packet, limit)` left out
 * (`JsonDelta.objMapToJson`). A delta key is always digits, so an underscore
 * key is never an object; the fold skips it.
 */
export function isAnnotationKey(key: string): boolean {
  return key.startsWith('_');
}

/**
 * Structural check at the boundary, so a JSON import is never simply asserted
 * to be a `WirePacket[]`. It checks what the fold and adapter rely on — the
 * packet skeleton, and that every object's `_type`/`_id` agree with its delta
 * key — and names the path of the first thing wrong. It is not the Tier C
 * schema (that is lane A's `tier-c.ts`); it is this renderer refusing input it
 * would misread.
 */
export function expectWirePackets(raw: unknown, source: string): WirePacket[] {
  const fail = (path: string, why: string): never => {
    throw new Error(`${source}${path}: ${why}`);
  };
  if (!Array.isArray(raw)) return fail('', 'expected an array of packets');
  raw.forEach((packet: unknown, i) => {
    const at = `[${i}]`;
    if (typeof packet !== 'object' || packet === null) return fail(at, 'expected a packet object');
    const p = packet as Record<string, unknown>;
    if (typeof p.seq !== 'number') fail(`${at}.seq`, 'expected a number');
    if (!Array.isArray(p.events)) fail(`${at}.events`, 'expected an array');
    for (const arm of ['newObjects', 'objectDeltas'] as const) {
      const map = p[arm];
      if (typeof map !== 'object' || map === null || Array.isArray(map)) {
        fail(`${at}.${arm}`, 'expected an object keyed by delta key');
      }
      for (const [key, obj] of Object.entries(map as Record<string, unknown>)) {
        const where = `${at}.${arm}["${key}"]`;
        if (isAnnotationKey(key)) {
          if (typeof obj !== 'number') fail(where, 'expected a count');
          continue;
        }
        if (typeof obj !== 'object' || obj === null) fail(where, 'expected an object');
        const o = obj as Record<string, unknown>;
        if (typeof o._type !== 'number' || typeof o._id !== 'number') {
          fail(where, 'expected numeric _type and _id');
        }
        if (deltaKey(o._type as number, o._id as number) !== key) {
          fail(where, `_type ${String(o._type)} / _id ${String(o._id)} do not encode to this delta key`);
        }
      }
    }
  });
  return raw as WirePacket[];
}
