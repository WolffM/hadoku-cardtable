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

import type { PendingTriggers, PrintedTypes, StateSiblings, WaitingEffects } from '@hadoku/forge-wire';

import { isAnnotationKey, type WireObject, type WirePacket } from './wire.ts';

/** Every object the client knows about, by delta key. */
export type WireState = ReadonlyMap<string, WireObject>;

/** A packet with the bridge's state facts beside it (`packages/forge-wire`'s `StateSiblingsSchema`), each replacing the last folded. */
export interface FoldablePacket extends WirePacket, StateSiblings {}

/** A permanent's printed card, as `printedTypes` names it: its type line, and whether it is a token. */
export interface PrintedCard {
  readonly type: PrintedTypes[number][1];
  readonly token: boolean;
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
  /** The latest `pendingTriggers` snapshot folded — replaced when present, as `stackTargetSpells` is. */
  pendingTriggers: PendingTriggers;
  /** The latest `waitingEffects` snapshot folded — replaced when present, as `stackTargetSpells` is. */
  waitingEffects: WaitingEffects;
  /** The latest `tokenSources` snapshot folded, as a `tokenId → sourceId` map — replaced when present. */
  tokenSources: ReadonlyMap<number, number>;
  /** The latest `cantBlock` snapshot folded, as a set of card ids — replaced when present. */
  cantBlock: ReadonlySet<number>;
  /** The latest `printedTypes` snapshot folded, as a `cardId → printed card` map — replaced when present. */
  printedTypes: ReadonlyMap<number, PrintedCard>;
  /** The latest `printedPT` snapshot folded, as a `cardId → printed power and toughness` map — replaced when present. */
  printedPT: ReadonlyMap<number, { power: number; toughness: number }>;
  /** The latest `lifePaying` snapshot folded, as a `playerId → life` map — replaced when present. */
  lifePaying: ReadonlyMap<number, number>;
  /** The latest `conditionMet` snapshot folded, as a set of card ids — replaced when present. */
  conditionMet: ReadonlySet<number>;
}

export function foldPackets(packets: readonly FoldablePacket[]): FoldResult {
  const state = new Map<string, WireObject>();
  let seq = 0;
  let skippedDeltas = 0;
  let stackTargetSpells = new Map<number, number>();
  let pendingTriggers: PendingTriggers = [];
  let waitingEffects: WaitingEffects = [];
  let tokenSources = new Map<number, number>();
  let cantBlock = new Set<number>();
  let printedTypes = new Map<number, PrintedCard>();
  let printedPT = new Map<number, { power: number; toughness: number }>();
  let lifePaying = new Map<number, number>();
  let conditionMet = new Set<number>();

  for (const packet of packets) {
    if (packet.stackTargetSpells !== undefined) {
      stackTargetSpells = new Map(packet.stackTargetSpells);
    }
    if (packet.pendingTriggers !== undefined) pendingTriggers = packet.pendingTriggers;
    if (packet.waitingEffects !== undefined) waitingEffects = packet.waitingEffects;
    if (packet.tokenSources !== undefined) tokenSources = new Map(packet.tokenSources);
    if (packet.cantBlock !== undefined) cantBlock = new Set(packet.cantBlock);
    if (packet.printedTypes !== undefined) printedTypes = new Map(packet.printedTypes.map(([id, type, token]) => [id, { type, token }]));
    if (packet.printedPT !== undefined) printedPT = new Map(packet.printedPT.map(([id, power, toughness]) => [id, { power, toughness }]));
    if (packet.lifePaying !== undefined) lifePaying = new Map(packet.lifePaying);
    if (packet.conditionMet !== undefined) conditionMet = new Set(packet.conditionMet);
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

  return { state, seq, skippedDeltas, stackTargetSpells, pendingTriggers, waitingEffects, tokenSources, cantBlock, printedTypes, printedPT, lifePaying, conditionMet };
}

function withoutNulls(obj: WireObject): WireObject {
  const out: WireObject = { _type: obj._type, _id: obj._id };
  for (const [prop, value] of Object.entries(obj)) {
    if (value !== null) out[prop] = value;
  }
  return out;
}
