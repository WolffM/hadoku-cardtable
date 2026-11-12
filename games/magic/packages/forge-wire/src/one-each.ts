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
 * A maximum matching of `keys` into the types not in `without`, placed in `keys`' order by augmenting
 * paths over the (at most nine) card types: a placed key stays placed, so an earlier key keeps a type
 * over a later one, and `unplaced` are the keys left without one.
 */
function place(oneEach: readonly OneEachType[], keys: readonly string[], without: ReadonlySet<string>): { holder: Map<string, string>; unplaced: string[] } {
  const typesOf = new Map<string, string[]>();
  for (const { type, keys: of } of oneEach) {
    if (!without.has(type)) for (const k of of) typesOf.set(k, [...(typesOf.get(k) ?? []), type]);
  }
  const holder = new Map<string, string>();
  const augment = (key: string, seen: Set<string>): boolean => {
    for (const type of typesOf.get(key) ?? []) {
      if (seen.has(type)) continue;
      seen.add(type);
      const held = holder.get(type);
      if (held === undefined || augment(held, seen)) {
        holder.set(type, key);
        return true;
      }
    }
    return false;
  };
  return { holder, unplaced: keys.filter((key) => !augment(key, new Set())) };
}

/** A matching of every one of `keys` into the types not in `without`, type → key, or null when there is none. */
function match(oneEach: readonly OneEachType[], keys: readonly string[], without: ReadonlySet<string>): Map<string, string> | null {
  const { holder, unplaced } = place(oneEach, keys, without);
  return unplaced.length === 0 ? holder : null;
}

/** The keys a maximum matching placed in `keys`' order leaves without a type (`place`). */
export const oneEachUnplaced = (oneEach: readonly OneEachType[], keys: readonly string[]): string[] => place(oneEach, keys, new Set()).unplaced;

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
