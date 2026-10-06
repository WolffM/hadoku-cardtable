/*
 * Fold a stream of Tier C packets into one state — the browser's copy of
 * Forge's client-side tracker.
 *
 * The rules are Forge's own, read from `NetworkGuiGame.applyDelta`
 * (`forge-gui/.../gamemodes/net/NetworkGuiGame.java`), not invented here:
 *
 *   1. **`newObjects` REPLACE.** An entry for an object that already exists
 *      clears its property bag and starts again — a `CardView` is replaced by
 *      a new instance (a card that changes zones is a new object in the
 *      engine), and every other type is cleared and reused.
 *   2. **`objectDeltas` MERGE** into an existing object, property by property.
 *   3. **`null` means "back to the default"**, not "unknown":
 *      `TrackableObject.set` removes the key when the value is null. So a null
 *      in a delta deletes the property here, and the reader falls back to the
 *      type's default.
 *   4. **A delta for an object the client never saw is skipped**, exactly as
 *      Forge logs `NOT FOUND for delta application` and moves on. It is not
 *      created from the delta: a delta is a partial bag and would produce an
 *      object with most of its properties missing.
 *
 * The fold is pure: packets in, a fresh map out. Nothing here knows what a
 * battlefield is — that is `adapter.ts`.
 */

import { isAnnotationKey, type WireObject, type WirePacket } from './wire.ts';

/** Every object the client knows about, by delta key. */
export type WireState = ReadonlyMap<string, WireObject>;

/**
 * Wave 49 §A — `PlayBridge.java`'s `stackTargetSpells`, a SIBLING of the
 * packet rather than a property inside it (`visibility.ts`'s own note on why:
 * not a `TrackableProperty`, `forge/` being stock upstream). `[fromStackItemId,
 * toStackItemId]` pairs. `./live/match.ts`'s `foldFrames` merges this field
 * from each `ServerFrame.payload` into the packet it hands `foldPackets`,
 * since this module only knows packets, never frames.
 */
export type StackTargetSpellPairs = readonly (readonly [number, number])[];

/** A packet that MAY carry {@link StackTargetSpellPairs} as a sibling field. */
export interface FoldablePacket extends WirePacket {
  stackTargetSpells?: StackTargetSpellPairs;
}

export interface FoldResult {
  state: WireState;
  /** The last packet's `seq` — the cursor a live source resumes from. */
  seq: number;
  /** Deltas addressed to objects never created (rule 4). Counted, not hidden. */
  skippedDeltas: number;
  /**
   * The latest `stackTargetSpells` snapshot folded, as a `fromId → toId` map.
   * It is a full snapshot every time it is sent (never a delta of pairs), so
   * folding it is "replace, when present" — the same rule `newObjects` gets,
   * not `objectDeltas`'s merge. A packet that does not carry the field at all
   * (every packet before this wave, or one built by hand in a test) leaves
   * whatever was already folded untouched; empty before any packet ever
   * carries it.
   */
  stackTargetSpells: ReadonlyMap<number, number>;
}

export function foldPackets(packets: readonly FoldablePacket[]): FoldResult {
  const state = new Map<string, WireObject>();
  let seq = 0;
  let skippedDeltas = 0;
  let stackTargetSpells = new Map<number, number>();

  for (const packet of packets) {
    if (packet.stackTargetSpells !== undefined) {
      stackTargetSpells = new Map(packet.stackTargetSpells);
    }
    for (const [key, obj] of Object.entries(packet.newObjects)) {
      if (isAnnotationKey(key)) continue;
      state.set(key, withoutNulls(obj));
    }
    for (const [key, delta] of Object.entries(packet.objectDeltas)) {
      if (isAnnotationKey(key)) continue;
      const existing = state.get(key);
      if (existing === undefined) {
        skippedDeltas += 1;
        continue;
      }
      const next: WireObject = { ...existing };
      for (const [prop, value] of Object.entries(delta)) {
        if (prop === '_type' || prop === '_id') continue;
        if (value === null) delete next[prop];
        else next[prop] = value;
      }
      state.set(key, next);
    }
    seq = packet.seq;
  }

  return { state, seq, skippedDeltas, stackTargetSpells };
}

function withoutNulls(obj: WireObject): WireObject {
  const out: WireObject = { _type: obj._type, _id: obj._id };
  for (const [prop, value] of Object.entries(obj)) {
    if (value !== null) out[prop] = value;
  }
  return out;
}
