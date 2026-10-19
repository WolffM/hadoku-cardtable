// @vitest-environment jsdom
/*
 * The pod's own HTTP calls, against a mocked `fetch` — the same approach
 * `RoomShell.test.ts` already uses for a raw endpoint nobody has wrapped a
 * typed client around yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPodContext, playPod, sitPod, standPod, startTableMatch } from './client.ts';
import { POD_SEATS, type PodView } from './wire.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const podFixture = (): PodView => ({
  phase: 'lobby',
  seats: Array.from({ length: POD_SEATS }, () => null),
  round: 0,
  rounds: 0,
  results: [],
  standings: [],
  pairings: [],
  bye: null,
  drafters: [],
  built: [],
});

describe('fetchPodContext', () => {
  it('reads pod, tables and a name map in one call', async () => {
    const pod = podFixture();
    const body = {
      id: 'r-cube',
      pod,
      tables: [{ id: 't-aaaaaaaa', players: [], matchId: null, series: { length: 3, wins: [0, 0], games: [], phase: 'seating' } }],
      members: [{ id: 'u-alice', name: 'Alice' }, { id: 'u-bob', name: 'Bob' }],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    const ctx = await fetchPodContext('r-cube');
    expect(ctx.pod).toEqual(pod);
    expect(ctx.tables).toHaveLength(1);
    expect(ctx.names).toEqual({ 'u-alice': 'Alice', 'u-bob': 'Bob', ai: 'AI' });
  });

  it('answers empty rather than throwing on a failed read', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await fetchPodContext('r-cube')).toEqual({ pod: null, tables: [], names: {}, me: null, name: '', leader: false, gone: false });
  });

  it('says the room is gone on the server’s 404, and only then', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    expect((await fetchPodContext('r-cube')).gone).toBe(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    expect((await fetchPodContext('r-cube')).gone).toBe(false);
  });

  it('says whether I own the room', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'r-cube', pod: null, members: [], you: { id: 'u-alice', leader: true } }), { status: 200 }));
    expect(await fetchPodContext('r-cube')).toMatchObject({ me: 'u-alice', leader: true, gone: false });
  });

  it('drops a malformed tables array rather than guessing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'r-cube', pod: null, tables: 'nonsense', members: [] }), { status: 200 }));
    const ctx = await fetchPodContext('r-cube');
    expect(ctx.tables).toEqual([]);
  });
});

describe('sitPod / standPod', () => {
  it('posts the chosen seat, or an empty body when none is chosen', async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const withSeat = await sitPod('r-cube', 3);
    expect(withSeat.ok).toBe(true);
    expect(bodies[0]).toEqual({ seat: 3 });

    const withoutSeat = await sitPod('r-cube');
    expect(withoutSeat.ok).toBe(true);
    expect(bodies[1]).toEqual({});
  });

  it('surfaces the server’s own refusal message rather than guessing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'the lobby phase has ended' }), { status: 409 }));
    const outcome = await standPod('r-cube');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe('the lobby phase has ended');
  });

  it('reports a network failure as a refusal, never a throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const outcome = await sitPod('r-cube', 0);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe('offline');
  });
});

describe('playPod', () => {
  it('posts to the room’s own play route, no body fields', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      calls.push({ url: String(input), body: init?.body });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const outcome = await playPod('r-cube');
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.url).toContain('/rooms/r-cube/pod/play');
    expect(calls[0]?.body).toBe('{}');
  });

  it('surfaces a refusal — my deck is not legal yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'your deck is not saved and legal yet' }), { status: 409 }));
    const outcome = await playPod('r-cube');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe('your deck is not saved and legal yet');
  });
});

describe('startTableMatch', () => {
  it('readies my seat, then starts the match once both are ready', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.includes('/ready')) return Promise.resolve(new Response('{}', { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ matchId: 'm-aaaaaaaaaaaa' }), { status: 201 }));
    });

    const outcome = await startTableMatch('r-cube', 't-aaaaaaaa');
    expect(outcome).toEqual({ ok: true, matchId: 'm-aaaaaaaaaaaa' });
    expect(calls[0]?.url).toContain('/tables/rooms/r-cube/ready');
    expect(calls[0]?.body).toEqual({ ready: true, table: 't-aaaaaaaa' });
    expect(calls[1]?.url).toContain('/play/matches');
    expect(calls[1]?.body).toEqual({ room: 'r-cube', table: 't-aaaaaaaa' });
  });

  it('reports the OTHER seat not being ready yet as success with no match — not an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).includes('/ready')) return Promise.resolve(new Response('{}', { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ error: 'e2e-alice is not ready yet' }), { status: 409 }));
    });
    const outcome = await startTableMatch('r-cube', 't-aaaaaaaa');
    expect(outcome).toEqual({ ok: true, matchId: null });
  });

  it('surfaces a refusal to ready my own seat', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'the lobby phase has ended' }), { status: 409 }));
    const outcome = await startTableMatch('r-cube', 't-aaaaaaaa');
    expect(outcome).toEqual({ ok: false, message: 'the lobby phase has ended' });
  });

  it('surfaces a refusal for any OTHER reason once both are ready', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).includes('/ready')) return Promise.resolve(new Response('{}', { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ error: 'a deck is illegal' }), { status: 409 }));
    });
    const outcome = await startTableMatch('r-cube', 't-aaaaaaaa');
    expect(outcome).toEqual({ ok: false, message: 'a deck is illegal' });
  });
});
