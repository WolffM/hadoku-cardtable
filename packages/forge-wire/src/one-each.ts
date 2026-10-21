/**
 * "For each card type, you may put a card of that type …" (an order's `oneEach`, `tier-b.ts`): a set
 * of cards is a legal answer when each can fill a type it is listed under, no two the same type. One
 * card never fills two types (an artifact creature is the artifact OR the creature).
 */

/** One type and the keys of the cards that could fill it. */
export interface OneEachType {
  readonly type: string;
  readonly keys: readonly string[];
}

/**
 * The type each of `keys` fills, as a map from type to key, or null when no way of filling the types
 * takes every one of them. Augmenting paths over the (at most nine) card types.
 */
export function oneEachFill(oneEach: readonly OneEachType[], keys: readonly string[]): Map<string, string> | null {
  const typesOf = new Map<string, string[]>();
  for (const { type, keys: of } of oneEach) for (const k of of) typesOf.set(k, [...(typesOf.get(k) ?? []), type]);
  const holder = new Map<string, string>();
  const place = (key: string, seen: Set<string>): boolean => {
    for (const type of typesOf.get(key) ?? []) {
      if (seen.has(type)) continue;
      seen.add(type);
      const held = holder.get(type);
      if (held === undefined || place(held, seen)) {
        holder.set(type, key);
        return true;
      }
    }
    return false;
  };
  for (const key of new Set(keys)) if (!place(key, new Set())) return null;
  return holder;
}
