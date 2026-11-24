/*
 * The order and the filter of a cube or set gallery (wave 127 §D): the room's picker (Cube and Set
 * tabs) and the Library's Cubes tab draw their cards through this one function.
 *
 * The person's own starred pools come first in every order. After them, the chosen order:
 *
 * - `newest`, the default: the server's own order, kept. That is what every gallery drew before
 *   this bar (imported cubes newest first, then the shortlist in file order; sets newest first),
 *   so the gallery looks the same until someone picks another sort.
 * - `drafted`: most recorded drafts first (`usage.drafts`).
 * - `played`: most matches played first (`usage.matches`).
 * - `name`: by name.
 *
 * Equal counts break by name. A pool the server sent no `usage` for counts as never drafted or played.
 * The query keeps a pool whose name holds it, or a set whose code does, ignoring case.
 */
import type { PoolUsage } from '@hadoku/shared';

export type PoolSort = 'newest' | 'drafted' | 'played' | 'name';

/** The Sort select's entries, in the order it lists them; the first is the default. */
export const POOL_SORTS: readonly { sort: PoolSort; label: string }[] = [
  { sort: 'newest', label: 'Newest' },
  { sort: 'drafted', label: 'Most drafted' },
  { sort: 'played', label: 'Most played' },
  { sort: 'name', label: 'Name' },
];

export const DEFAULT_POOL_SORT: PoolSort = 'newest';

export function isPoolSort(value: string): value is PoolSort {
  return POOL_SORTS.some((s) => s.sort === value);
}

export interface PoolSortOptions {
  sort: PoolSort;
  query: string;
  /** The person's starred pool keys (`cube:<id>`, `set:<code>`). */
  favourites: ReadonlySet<string>;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** A set's code from its pool key, or null for a cube. */
const codeOf = (poolKey: string): string | null => (poolKey.startsWith('set:') ? poolKey.slice('set:'.length) : null);

/**
 * `items` filtered by the query and ordered: starred first, then the chosen order. `key` gives an
 * item's pool key. Never mutates `items`.
 */
export function sortPools<T extends { name: string; usage?: PoolUsage | undefined }>(items: readonly T[], key: (t: T) => string, opts: PoolSortOptions): T[] {
  const q = opts.query.trim().toLowerCase();
  const kept =
    q === ''
      ? [...items]
      : items.filter((t) => {
          if (t.name.toLowerCase().includes(q)) return true;
          const code = codeOf(key(t));
          return code !== null && code.toLowerCase().includes(q);
        });

  const count = (t: T): number => (opts.sort === 'drafted' ? (t.usage?.drafts ?? 0) : opts.sort === 'played' ? (t.usage?.matches ?? 0) : 0);
  const order = (a: T, b: T): number => {
    if (opts.sort === 'newest') return 0;
    if (opts.sort === 'name') return byName(a, b);
    return count(b) - count(a) || byName(a, b);
  };

  // `Array.prototype.sort` is stable, so `newest` keeps the server's order inside each group.
  const starred = kept.filter((t) => opts.favourites.has(key(t))).sort(order);
  const rest = kept.filter((t) => !opts.favourites.has(key(t))).sort(order);
  return [...starred, ...rest];
}
