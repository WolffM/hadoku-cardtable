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

import { isAnnotationKey, type Tagged, type WireObject, type WirePacket } from './wire.ts';

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

/**
 * `PlayBridge.java`'s `pendingTriggers`, the packet's other sibling: the triggers Forge has
 * collected and not yet put on the stack (`packages/forge-wire`'s `PendingTriggersSchema`).
 */
export type PendingTriggers = readonly { id: number; hostCard: number; controller: number; key: string; current?: true }[];

/**
 * `PlayBridge.java`'s `waitingEffects`, the packet's third sibling: what a resolved ability left
 * waiting on the card that made it (`packages/forge-wire`'s `WaitingEffectsSchema`).
 */
export type WaitingEffects = readonly { source: number; text: string; kind: 'trigger' | 'effect' }[];

/** `PlayBridge.java`'s `tokenSources`, the packet's fourth sibling: `[tokenId, sourceId]`, which card made each token (`packages/forge-wire`'s `TokenSourcesSchema`). */
export type TokenSources = readonly (readonly [number, number])[];

/** `PlayBridge.java`'s `cantBlock`, the packet's fifth sibling: the battlefield creatures that can't block (`packages/forge-wire`'s `CantBlockSchema`). */
export type CantBlock = readonly number[];

/** `PlayBridge.java`'s `printedTypes`, the packet's sixth sibling: `[cardId, printedType]` for each permanent whose type line is not its printed one (`packages/forge-wire`'s `PrintedTypesSchema`). */
export type PrintedTypes = readonly (readonly [number, Tagged])[];

/** `PlayBridge.java`'s `lifePaying`, the packet's seventh sibling: `[playerId, life]`, the life each player has committed to an open payment and Forge has not taken yet (`packages/forge-wire`'s `LifePayingSchema`). */
export type LifePaying = readonly (readonly [number, number])[];

/** `PlayBridge.java`'s `conditionMet`, the packet's eighth sibling: the hand and battlefield cards whose condition is on (`packages/forge-wire`'s `ConditionMetSchema`). */
export type ConditionMet = readonly number[];

/** A packet that MAY carry {@link StackTargetSpellPairs}, {@link PendingTriggers}, {@link WaitingEffects}, {@link TokenSources}, {@link CantBlock}, {@link PrintedTypes}, {@link LifePaying} and {@link ConditionMet} as sibling fields. */
export interface FoldablePacket extends WirePacket {
  stackTargetSpells?: StackTargetSpellPairs;
  pendingTriggers?: PendingTriggers;
  waitingEffects?: WaitingEffects;
  tokenSources?: TokenSources;
  cantBlock?: CantBlock;
  printedTypes?: PrintedTypes;
  lifePaying?: LifePaying;
  conditionMet?: ConditionMet;
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
  /** The latest `printedTypes` snapshot folded, as a `cardId → printedType` map — replaced when present. */
  printedTypes: ReadonlyMap<number, Tagged>;
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
  let printedTypes = new Map<number, Tagged>();
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
    if (packet.printedTypes !== undefined) printedTypes = new Map(packet.printedTypes);
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

  return { state, seq, skippedDeltas, stackTargetSpells, pendingTriggers, waitingEffects, tokenSources, cantBlock, printedTypes, lifePaying, conditionMet };
}

function withoutNulls(obj: WireObject): WireObject {
  const out: WireObject = { _type: obj._type, _id: obj._id };
  for (const [prop, value] of Object.entries(obj)) {
    if (value !== null) out[prop] = value;
  }
  return out;
}
