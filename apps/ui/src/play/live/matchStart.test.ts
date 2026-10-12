import { beforeEach, describe, expect, it, vi } from 'vitest';

const played: string[] = [];
const navigated: unknown[] = [];
vi.mock('../../sound/index.ts', () => ({ playRole: (role: string) => played.push(role) }));
vi.mock('../../screens/route.ts', () => ({ navigate: (route: unknown) => navigated.push(route) }));

const { matchStartSounded, openNewMatch } = await import('./matchStart.ts');

describe('openNewMatch', () => {
  beforeEach(() => {
    played.length = 0;
    navigated.length = 0;
  });

  it('sounds the game start once per match, however many paths open it', () => {
    openNewMatch('m-1');
    openNewMatch('m-1');
    expect(played).toEqual(['g.match-start']);
    expect(navigated).toEqual([
      { kind: 'match', matchId: 'm-1' },
      { kind: 'match', matchId: 'm-1' },
    ]);
    expect(matchStartSounded('m-1')).toBe(true);
  });

  it('a rematch is a new match and sounds again', () => {
    openNewMatch('m-2');
    expect(played).toEqual(['g.match-start']);
    expect(matchStartSounded('m-3')).toBe(false);
  });
});
