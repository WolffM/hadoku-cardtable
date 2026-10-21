import { describe, expect, it } from 'vitest';

import { MATCH_MUSIC_ROLES, type ManaColor } from '@hadoku/shared';

import { matchMusicRoles, pickFor } from './match-music.ts';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `match-${i}`);

describe('match music', () => {
  it('a mono deck plays its colour first', () => {
    expect(matchMusicRoles('m-1', ['R'])[0]).toBe('music.match.R');
  });

  it('a two-colour deck plays its pair, whichever order the colours came in', () => {
    expect(matchMusicRoles('m-1', ['W', 'U'])[0]).toBe('music.match.WU');
    expect(matchMusicRoles('m-1', ['U', 'W'])[0]).toBe('music.match.WU');
    expect(matchMusicRoles('m-1', ['G', 'W'])[0]).toBe('music.match.GW');
    expect(matchMusicRoles('m-1', ['W', 'G'])[0]).toBe('music.match.GW');
    expect(matchMusicRoles('m-1', ['B', 'W'])[0]).toBe('music.match.WB');
    expect(matchMusicRoles('m-1', ['U', 'G'])[0]).toBe('music.match.GU');
  });

  const THREE: readonly [ManaColor[], string[]][] = [
    [['G', 'W', 'U'], ['GW', 'WU', 'GU']],
    [['W', 'U', 'B'], ['WU', 'UB', 'WB']],
    [['U', 'B', 'R'], ['UB', 'BR', 'UR']],
    [['B', 'R', 'G'], ['BR', 'RG', 'BG']],
    [['R', 'G', 'W'], ['RG', 'GW', 'RW']],
    [['W', 'B', 'G'], ['WB', 'BG', 'GW']],
    [['U', 'R', 'W'], ['UR', 'RW', 'WU']],
    [['B', 'G', 'U'], ['BG', 'GU', 'UB']],
    [['R', 'W', 'B'], ['RW', 'WB', 'BR']],
    [['G', 'U', 'R'], ['GU', 'UR', 'RG']],
  ];

  it.each(THREE)('a %j deck plays one of the three pairs inside it, the same one all match, a different one across matches', (colors, pairs) => {
    const roles = pairs.map((p) => `music.match.${p}`);
    const first = matchMusicRoles('m-abc', colors)[0];
    expect(roles).toContain(first);
    for (let i = 0; i < 5; i++) expect(matchMusicRoles('m-abc', colors)[0]).toBe(first);
    expect(new Set(ids(60).map((id) => matchMusicRoles(id, colors)[0]))).toEqual(new Set(roles));
    // Its other two pairs are its next choices.
    expect(new Set(matchMusicRoles('m-abc', colors).slice(0, 3))).toEqual(new Set(roles));
  });

  it('four or five colours play any of the fifteen, across matches', () => {
    for (const colors of [['W', 'U', 'B', 'R'], ['W', 'U', 'B', 'R', 'G']] as ManaColor[][]) {
      expect(MATCH_MUSIC_ROLES).toContain(matchMusicRoles('m-5', colors)[0]);
      expect(matchMusicRoles('m-5', colors)[0]).toBe(matchMusicRoles('m-5', colors)[0]);
      expect(new Set(ids(400).map((id) => matchMusicRoles(id, colors)[0]))).toEqual(new Set(MATCH_MUSIC_ROLES));
    }
  });

  it('a colourless deck and a watcher play any of the fifteen too, then the match music', () => {
    for (const colors of [[], null] as const) {
      const roles = matchMusicRoles('m-3', colors);
      expect(roles[0]).toBe(MATCH_MUSIC_ROLES[pickFor('m-3', 15)]);
      expect(new Set(roles.slice(0, 15))).toEqual(new Set(MATCH_MUSIC_ROLES));
      expect(roles.slice(15)).toEqual(['music.match']);
    }
  });

  it('falls back through the deck’s own candidates, its mono colours, the match music, then every track', () => {
    const roles = matchMusicRoles('m-2', ['B', 'R', 'G']);
    expect(roles.slice(3, 7)).toEqual(['music.match.B', 'music.match.R', 'music.match.G', 'music.match']);
    expect(new Set(roles)).toEqual(new Set([...MATCH_MUSIC_ROLES, 'music.match']));
    expect(roles.length).toBe(16);

    const pair = matchMusicRoles('m-2', ['R', 'G']);
    expect(pair.slice(0, 4)).toEqual(['music.match.RG', 'music.match.R', 'music.match.G', 'music.match']);
    expect(pair.length).toBe(16);

    const mono = matchMusicRoles('m-2', ['R']);
    expect(mono.slice(0, 2)).toEqual(['music.match.R', 'music.match']);
    expect(mono.length).toBe(16);
  });

  it('plays nothing until the server has said what the deck is', () => {
    expect(matchMusicRoles('m-4', undefined)).toEqual([]);
  });

  it('pickFor is stable and in range', () => {
    for (const n of [1, 2, 3, 5, 15]) {
      const p = pickFor('some-match-id', n);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(n);
      expect(pickFor('some-match-id', n)).toBe(p);
    }
  });
});
