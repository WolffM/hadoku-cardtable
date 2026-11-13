// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { fetchParked, resumeParked, UnfinishedGames, type ParkedGame } from './UnfinishedGames.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.location.hash = '';
});

const parked: ParkedGame = {
  matchId: 'm-0123456789ab',
  room: 'Friday night',
  format: 'Free pick',
  turn: 7,
  parkedAt: '2026-11-02T21:00:00.000Z',
  seats: [
    { name: 'Alice', deck: 'Burn', ai: false, you: true },
    { name: 'Bob', deck: 'Ramp', ai: false, you: false },
  ],
  resumed: null,
};

describe('the Unfinished games list', () => {
  it('draws nothing until the list arrives, and nothing for a player with none', async () => {
    let answer: (g: ParkedGame[]) => void = () => {};
    const { container } = render(createElement(UnfinishedGames, { load: () => new Promise<ParkedGame[]>((r) => (answer = r)) }));
    expect(container.innerHTML).toBe('');
    answer([]);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('names the other player, the pool and the turn; Resume, or Join once the other player has picked it up', async () => {
    const joined: ParkedGame = { ...parked, matchId: 'm-ba9876543210', resumed: { roomId: 'r-00000002', tableId: 't-00000002' } };
    render(createElement(UnfinishedGames, { load: async () => [parked, joined] }));
    await waitFor(() => expect(screen.getAllByTestId('unfinished-game')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('unfinished-game');
    expect(first?.textContent).toContain('vs Bob');
    expect(first?.textContent).not.toContain('Alice');
    expect(first?.textContent).toContain('Free pick · Turn 7 · ');
    expect(screen.getAllByTestId('unfinished-resume').map((b) => [b.textContent, b.dataset.action])).toEqual([
      ['Resume', 'resume'],
      ['Join', 'join'],
    ]);
    expect(second?.querySelector('time')?.getAttribute('datetime')).toBe(parked.parkedAt);
  });

  it('goes to the table the game is played at', async () => {
    const resume = vi.fn(async () => ({ roomId: 'r-00000002', tableId: 't-00000002' }));
    render(createElement(UnfinishedGames, { load: async () => [parked], resume }));
    fireEvent.click(await screen.findByTestId('unfinished-resume'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/room/r-00000002/table/t-00000002'));
    expect(resume).toHaveBeenCalledWith(parked.matchId);
  });

  it('says why a game could not be picked up again, and lets the player try again', async () => {
    const resume = vi.fn(async (): Promise<{ roomId: string; tableId: string }> => {
      throw new Error('This game could not be picked up again: Puzzle: no card named Grizzly Bearz');
    });
    render(createElement(UnfinishedGames, { load: async () => [parked], resume }));
    const button = await screen.findByTestId('unfinished-resume');
    fireEvent.click(button);
    expect((await screen.findByTestId('unfinished-error')).textContent).toContain('Grizzly Bearz');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads /api/play/parked, keeping only the games it understands, and posts a resume', async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      if (init?.method === 'POST') return new Response(JSON.stringify({ roomId: 'r-1', tableId: 't-1', matchId: 'm-1' }), { status: 201 });
      return new Response(JSON.stringify({ games: [parked, { matchId: 'broken' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchParked(fetchImpl)).toEqual([parked]);
    expect(await resumeParked(parked.matchId, fetchImpl)).toEqual({ roomId: 'r-1', tableId: 't-1' });
    expect(calls).toEqual([
      { url: expect.stringMatching(/\/api\/play\/parked$/), method: 'GET' },
      { url: expect.stringMatching(/\/api\/play\/parked\/m-0123456789ab\/resume$/), method: 'POST' },
    ]);
  });

  it('a refused resume carries the server’s words', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'no such parked game of yours' }), { status: 404 })) as unknown as typeof fetch;
    await expect(resumeParked(parked.matchId, fetchImpl)).rejects.toThrow('no such parked game of yours');
  });
});
