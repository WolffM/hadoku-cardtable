// @vitest-environment jsdom
/*
 * A reloaded match link asks the server which room the match is in once. The page asks first,
 * because its chat has to know before the board mounts (`App.tsx`'s `useMatchRoomId`); the match
 * screen's own way back to the room is the same answer, not a second ask.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';

import type { MatchTransport } from '../play/live/match.ts';

// The board is not what this is about: it draws the room the screen hands it, and nothing else.
vi.mock('../play/live/LiveBoard.tsx', async () => {
  const { createElement: h } = await import('react');
  return { LiveBoard: ({ roomId }: { roomId: string | null }) => h('output', { 'data-testid': 'board-room' }, roomId ?? 'none') };
});
// No socket in jsdom: a room nobody pings.
vi.mock('../rooms/follow.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  roomFeed: () => ({ follow: () => () => undefined }),
}));

const { useMatchRoomId } = await import('../App.tsx');
const { MatchScreen } = await import('./MatchScreen.tsx');
const { forgetMatchesFollowed } = await import('../play/live/matchStart.ts');
const { default: SERVER_BODIES } = await import('../rooms/room-bodies.fixture.json');

const quiet = (): MatchTransport => ({ on() {}, emit() {}, request() {}, disconnect() {} });

afterEach(() => {
  cleanup();
  forgetMatchesFollowed();
  vi.unstubAllGlobals();
});

describe('a reloaded match link', () => {
  it('asks which room the match is in once, for the page and the board together', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (!String(url).includes('/rooms/of-match/')) return new Response('{}', { status: 404 });
      asked.push(String(url));
      return new Response(JSON.stringify(SERVER_BODIES.constructed), { status: 200 });
    });

    const page = renderHook(() => useMatchRoomId('m-reloaded'));
    await waitFor(() => expect(page.result.current.roomId).toBe(SERVER_BODIES.constructed.id));
    render(createElement(MatchScreen, { matchId: 'm-reloaded', makeTransport: quiet }));
    await waitFor(() => expect(screen.getByTestId('board-room').textContent).toBe(SERVER_BODIES.constructed.id));

    expect(asked).toEqual(['/api/rooms/of-match/m-reloaded']);
  });

  it('asks again after an ask that failed: a failure is not "no room"', async () => {
    let answers = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (!String(url).includes('/rooms/of-match/')) return new Response('{}', { status: 404 });
      answers += 1;
      return answers === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(SERVER_BODIES.constructed), { status: 200 });
    });

    const page = renderHook(() => useMatchRoomId('m-unlucky'));
    await waitFor(() => expect(page.result.current.pending).toBe(false));
    expect(page.result.current.roomId).toBeNull();
    render(createElement(MatchScreen, { matchId: 'm-unlucky', makeTransport: quiet }));
    await waitFor(() => expect(screen.getByTestId('board-room').textContent).toBe(SERVER_BODIES.constructed.id));
    expect(answers).toBe(2);
  });
});
