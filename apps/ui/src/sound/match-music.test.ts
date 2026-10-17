import { describe, expect, it } from 'vitest';

import { matchMusicRoles, pickFor } from './match-music.ts';

describe('match music', () => {
  it('a mono deck plays its colour first', () => {
    expect(matchMusicRoles('m-1', ['R'])[0]).toBe('music.match.R');
  });

  it('a deck of several colours plays one of them, the same one for the whole match', () => {
    const first = matchMusicRoles('m-abc', ['W', 'U', 'B'])[0];
    expect(['music.match.W', 'music.match.U', 'music.match.B']).toContain(first);
    for (let i = 0; i < 5; i++) expect(matchMusicRoles('m-abc', ['W', 'U', 'B'])[0]).toBe(first);
  });

  it('picks across a deck’s colours from one match to the next', () => {
    const picks = new Set(Array.from({ length: 40 }, (_, i) => matchMusicRoles(`match-${i}`, ['G', 'U'])[0]));
    expect(picks).toEqual(new Set(['music.match.G', 'music.match.U']));
  });

  it('falls back to the match music, then to one of the five colours, picked once per match', () => {
    const roles = matchMusicRoles('m-2', ['R', 'G']);
    expect(roles.slice(1, 2)).toEqual(['music.match']);
    expect(roles.length).toBeLessThanOrEqual(3);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('a colourless deck and a watcher play the match music, then one of the five', () => {
    for (const colors of [[], null] as const) {
      const roles = matchMusicRoles('m-3', colors);
      expect(roles[0]).toBe('music.match');
      expect(roles).toEqual(['music.match', `music.match.${'WUBRG'[pickFor('m-3', 5)]}`]);
    }
  });

  it('plays nothing until the server has said what the deck is', () => {
    expect(matchMusicRoles('m-4', undefined)).toEqual([]);
  });

  it('pickFor is stable and in range', () => {
    for (const n of [1, 2, 3, 5]) {
      const p = pickFor('some-match-id', n);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(n);
      expect(pickFor('some-match-id', n)).toBe(p);
    }
  });
});
