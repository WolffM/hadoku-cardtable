/*
 * Reading Tier C state: the delta keys an object table is indexed by, and the
 * tagged values its property bags hold.
 *
 * The server's projector and stats, and the UI's fold and adapter, all read
 * the same folded table, so the key encoding and the readers are written here
 * once. They take any property bag, typed or not, and never throw: a value
 * that is absent, null or of another tag reads as absent.
 */

import { deltaKeyOf } from './tier-c.ts';

/** `DeltaPacket.TYPE_*` (`DeltaPacket.java:34-38`), the same order as `DELTA_OBJECT_TYPES`. */
export const DELTA_TYPE = { card: 0, player: 1, stackItem: 2, game: 3, cardState: 4 } as const;

/** `DeltaPacket.makeDeltaKey(type, id)` as the string a JSON object key is. */
export function deltaKey(type: number, id: number): string {
  return String(deltaKeyOf(type, id));
}

/**
 * The delta key of one card's state view. A `CardStateView`'s id on the wire is
 * `cardId * 16 + CardStateName.ordinal()` (`DeltaPacket.java:61-66`), which is
 * how a card's `CurrentState` ordinal finds the face to draw.
 */
export function cardStateKey(cardId: number, stateOrdinal: number): string {
  return deltaKey(DELTA_TYPE.cardState, cardId * 16 + stateOrdinal);
}

/** The card a `CardStateView` id belongs to — the inverse of {@link cardStateKey}'s id. */
export function cardIdOfState(stateId: number): number {
  return Math.floor(stateId / 16);
}

/** One object's property bag, as any reader of the table holds it. */
export type PropertyBag = { readonly [property: string]: unknown };

/** A property's tagged value, absent for a missing or null one. */
export function tagOf(obj: PropertyBag | undefined, prop: string): { t: string; v?: unknown } | undefined {
  const value = obj?.[prop];
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string'
    ? (value as { t: string; v?: unknown })
    : undefined;
}

/** An int, long or byte property, null when it is not one. */
export function intOf(obj: PropertyBag | undefined, prop: string): number | null {
  const v = tagOf(obj, prop);
  return v !== undefined && (v.t === 'int' || v.t === 'long' || v.t === 'byte') && typeof v.v === 'number' ? v.v : null;
}

export function boolOf(obj: PropertyBag | undefined, prop: string): boolean {
  const v = tagOf(obj, prop);
  return v !== undefined && v.t === 'bool' && v.v === true;
}

export function strOf(obj: PropertyBag | undefined, prop: string): string | null {
  const v = tagOf(obj, prop);
  return v !== undefined && v.t === 'str' && typeof v.v === 'string' ? v.v : null;
}

export function enumOf(obj: PropertyBag | undefined, prop: string): string | null {
  const v = tagOf(obj, prop);
  return v !== undefined && v.t === 'enum' && typeof v.v === 'string' ? v.v : null;
}

/** The ids of a list or set property, with Forge's `-1` (no object) left out. */
export function idsOf(obj: PropertyBag | undefined, prop: string): number[] {
  const v = tagOf(obj, prop);
  if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
  const out: number[] = [];
  for (const item of v.v as unknown[]) {
    const t = item as { t?: unknown; v?: unknown } | null;
    if (t !== null && t.t === 'int' && typeof t.v === 'number' && t.v !== -1) out.push(t.v);
  }
  return out;
}

/** A card's current face (`CardStateView`), off its `CurrentState` ordinal. */
export function currentFace<T extends PropertyBag>(state: ReadonlyMap<string, T>, cardId: number): T | undefined {
  return state.get(cardStateKey(cardId, intOf(state.get(deltaKey(DELTA_TYPE.card, cardId)), 'CurrentState') ?? 0));
}

/**
 * The core types of a card's current face (`Land`, `Creature`, …), or null when
 * the face's type is not known — which is not the same as a face with none.
 */
export function coreTypes(state: ReadonlyMap<string, PropertyBag>, cardId: number): string[] | null {
  const type = tagOf(currentFace(state, cardId), 'Type') as { t: string; core?: unknown } | undefined;
  return type?.t === 'cardtype' && Array.isArray(type.core) ? (type.core as unknown[]).filter((t): t is string => typeof t === 'string') : null;
}
