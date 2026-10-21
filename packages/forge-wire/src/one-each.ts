/**
 * "For each card type, you may put a card of that type …" (an order's `oneEach`, `tier-b.ts`): a set
 * of cards is a legal answer when each can fill a type it is listed under, no two the same type. One
 * card never fills two types (an artifact creature is the artifact OR the creature), and which one
 * it is stays open until the other picks decide it: the set is a matching of cards to types, and
 * any matching will do.
 */

/** One type and the keys of the cards that could fill it. */
export interface OneEachType {
  readonly type: string;
  readonly keys: readonly string[];
}

/** What a legal set of picks fills, read over every way of matching it. */
export interface OneEachFit {
  /** One matching, type → key: earlier types go to earlier picks where the rest still fit. */
  readonly fill: ReadonlyMap<string, string>;
  /** The types every matching fills. */
  readonly filled: ReadonlySet<string>;
  /** Each pick's types that some matching puts it in, in `oneEach` order. */
  readonly could: ReadonlyMap<string, readonly string[]>;
}

/**
 * A matching of `keys` into the types not in `without`, as a map from type to key, or null when
 * there is none. Augmenting paths over the (at most nine) card types.
 */
function match(oneEach: readonly OneEachType[], keys: readonly string[], without: ReadonlySet<string>): Map<string, string> | null {
  const typesOf = new Map<string, string[]>();
  for (const { type, keys: of } of oneEach) {
    if (!without.has(type)) for (const k of of) typesOf.set(k, [...(typesOf.get(k) ?? []), type]);
  }
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
  for (const key of keys) if (!place(key, new Set())) return null;
  return holder;
}

/** What `keys` fill, or null when no matching takes every one of them. */
export function oneEachFit(oneEach: readonly OneEachType[], keys: readonly string[]): OneEachFit | null {
  const picks = [...new Set(keys)];
  const fill = match(oneEach, picks, new Set());
  if (fill === null) return null;
  const filled = new Set(oneEach.map((t) => t.type).filter((type) => match(oneEach, picks, new Set([type])) === null));
  const could = new Map(
    picks.map((key) => {
      const others = picks.filter((k) => k !== key);
      return [key, oneEach.filter((t) => t.keys.includes(key) && match(oneEach, others, new Set([t.type])) !== null).map((t) => t.type)] as const;
    }),
  );
  return { fill, filled, could };
}
