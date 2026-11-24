/*
 * The galleries' one order and filter (wave 127 §D): starred first in every sort, then the chosen
 * order, equal counts by name, and a query on the name or a set's code.
 */
import { describe, expect, it } from 'vitest';
import type { PoolUsage } from '@hadoku/shared';

import { DEFAULT_POOL_SORT, POOL_SORTS, isPoolSort, sortPools, type PoolSort } from './poolSort.ts';

interface Pool {
  key: string;
  name: string;
  usage?: PoolUsage;
}

const used = (drafts: number, matches: number): PoolUsage => ({ drafts, matches, lastPlayedAt: null });

// The server's order: imported newest first, then the shortlist.
const POOLS: readonly Pool[] = [
  { key: 'cube:charlie', name: 'Charlie', usage: used(1, 9) },
  { key: 'cube:bravo', name: 'bravo', usage: used(3, 2) },
  { key: 'cube:alpha', name: 'Alpha', usage: used(0, 0) },
  { key: 'cube:delta', name: 'Delta' },
];

const names = (sort: PoolSort, favourites: readonly string[] = [], query = ''): string[] =>
  sortPools(POOLS, (p) => p.key, { sort, query, favourites: new Set(favourites) }).map((p) => p.name);

describe('sortPools', () => {
  it('Newest is the default and keeps the server’s order, which is what the gallery drew before the bar', () => {
    expect(DEFAULT_POOL_SORT).toBe('newest');
    expect(POOL_SORTS[0]?.sort).toBe('newest');
    expect(names('newest')).toEqual(['Charlie', 'bravo', 'Alpha', 'Delta']);
  });

  it('Most drafted: most recorded drafts first, a pool with no usage counting none, equal counts by name', () => {
    expect(names('drafted')).toEqual(['bravo', 'Charlie', 'Alpha', 'Delta']);
  });

  it('Most played: most matches first', () => {
    expect(names('played')).toEqual(['Charlie', 'bravo', 'Alpha', 'Delta']);
  });

  it('Name: by name, ignoring case', () => {
    expect(names('name')).toEqual(['Alpha', 'bravo', 'Charlie', 'Delta']);
  });

  it('a starred pool comes first in every sort, and starred pools keep the chosen order among themselves', () => {
    for (const { sort } of POOL_SORTS) expect(names(sort, ['cube:delta'])[0], sort).toBe('Delta');
    expect(names('drafted', ['cube:alpha', 'cube:charlie'])).toEqual(['Charlie', 'Alpha', 'bravo', 'Delta']);
    expect(names('newest', ['cube:alpha', 'cube:charlie'])).toEqual(['Charlie', 'Alpha', 'bravo', 'Delta']);
  });

  it('a query keeps the pools whose name holds it, ignoring case and spaces around it', () => {
    expect(names('newest', [], '  HAR ')).toEqual(['Charlie']);
    expect(names('newest', [], 'zzz')).toEqual([]);
    expect(names('name', ['cube:delta'], 'a')).toEqual(['Delta', 'Alpha', 'bravo', 'Charlie']);
  });

  it('a query matches a set’s code, never a cube’s id', () => {
    const sets = [
      { key: 'set:ISD', name: 'Innistrad' },
      { key: 'set:ALA', name: 'Shards of Alara' },
    ];
    const query = (q: string) => sortPools(sets, (s) => s.key, { sort: 'newest', query: q, favourites: new Set() }).map((s) => s.name);
    expect(query('isd')).toEqual(['Innistrad']);
    expect(query('alara')).toEqual(['Shards of Alara']);
    expect(names('newest', [], 'cube')).toEqual([]);
  });

  it('never mutates what it was given', () => {
    const copy = POOLS.map((p) => p.name);
    names('name', ['cube:delta']);
    expect(POOLS.map((p) => p.name)).toEqual(copy);
  });

  it('knows its own sorts and nothing else', () => {
    expect(isPoolSort('drafted')).toBe(true);
    expect(isPoolSort('favourites')).toBe(false);
  });
});
