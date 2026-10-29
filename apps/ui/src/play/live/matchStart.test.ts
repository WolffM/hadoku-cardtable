import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveMatch } from './match.ts';

const played: string[] = [];
const navigated: unknown[] = [];
vi.mock('../../sound/index.ts', () => ({ playRole: (role: string) => played.push(role) }));
vi.mock('../../screens/route.ts', () => ({ navigate: (route: unknown) => navigated.push(route) }));
/** Each match's room, answered when the test resolves it. */
const roomAnswers = new Map<string, (room: unknown) => void>();
vi.mock('../../rooms/api.ts', () => ({
  roomsClient: () => ({ roomOfMatch: (matchId: string) => new Promise((resolve) => roomAnswers.set(matchId, resolve)) }),
}));

const { BOARD_WAIT_MS, forgetMatchesFollowed, knownRoomOfMatch, matchStartSounded, openNewMatch, takeWarmMatch, warmMatchesWith } = await import('./matchStart.ts');

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

describe('the walk from the room to the board (w79d, item 5)', () => {
  /** Just enough of a handle for `subscribe` and `closeMatch`: what the opener's socket would fold. */
  function fakeMatch(matchId: string): LiveMatch & { closed: boolean } {
    const match = {
      matchId,
      view: null,
      lastError: null,
      asks: [],
      connected: false,
      revision: 0,
      listeners: new Set<() => void>(),
      closed: false,
      transport: { disconnect: () => (match.closed = true) },
    };
    return match as unknown as LiveMatch & { closed: boolean };
  }
  const changed = (match: LiveMatch, change: Partial<LiveMatch>): void => {
    Object.assign(match, change);
    for (const listener of match.listeners) listener();
  };
  let opened: (LiveMatch & { closed: boolean })[];

  beforeEach(() => {
    vi.useFakeTimers();
    navigated.length = 0;
    roomAnswers.clear();
    opened = [];
    forgetMatchesFollowed();
    warmMatchesWith((matchId) => {
      const match = fakeMatch(matchId);
      opened.push(match);
      return match;
    });
  });
  afterEach(() => {
    warmMatchesWith(null);
    vi.useRealTimers();
  });

  it('keeps the room up until the board has a state and its room is known, then hands the same handle to the match screen', async () => {
    openNewMatch('m-10');
    openNewMatch('m-10');
    expect(opened).toHaveLength(1);
    expect(navigated).toEqual([]);
    changed(opened[0]!, { connected: true });
    changed(opened[0]!, { view: {} as LiveMatch['view'] });
    expect(navigated, 'the room of the match is not known yet').toEqual([]);
    const room = { id: 'r-1' };
    roomAnswers.get('m-10')!(room);
    await vi.waitFor(() => expect(navigated).toEqual([{ kind: 'match', matchId: 'm-10' }]));
    expect(knownRoomOfMatch('m-10')).toBe(room);
    expect(takeWarmMatch('m-10')).toBe(opened[0]);
    expect(takeWarmMatch('m-10')).toBeNull();
    vi.advanceTimersByTime(BOARD_WAIT_MS);
    expect(opened[0]!.closed).toBe(false);
  });

  it('a refusal hands over as soon as the room is answered, so the board can say it', async () => {
    openNewMatch('m-11');
    roomAnswers.get('m-11')!(null);
    await Promise.resolve();
    expect(navigated).toEqual([]);
    changed(opened[0]!, { lastError: 'forge:join was refused: unknown-match' });
    expect(navigated).toEqual([{ kind: 'match', matchId: 'm-11' }]);
    expect(knownRoomOfMatch('m-11')).toBeNull();
  });

  it('a board that never draws hands over after the wait, and a handle nobody adopts is closed', () => {
    openNewMatch('m-12');
    vi.advanceTimersByTime(BOARD_WAIT_MS - 1);
    expect(navigated).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(navigated).toEqual([{ kind: 'match', matchId: 'm-12' }]);
    vi.advanceTimersByTime(BOARD_WAIT_MS);
    expect(opened[0]!.closed).toBe(true);
    expect(takeWarmMatch('m-12')).toBeNull();
  });
});
