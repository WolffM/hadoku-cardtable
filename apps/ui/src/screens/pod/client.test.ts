// @vitest-environment jsdom
/*
 * The pod's own HTTP calls, against a mocked `fetch` — the same approach
 * `RoomShell.test.ts` already uses for a raw endpoint nobody has wrapped a
 * typed client around yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseRoomView, type RoomView } from '../../rooms/api.ts';
import { fetchPodContext, heldFor, nextGameStarts, playPod, relayedPodSource, sitPod, standPod, startTableMatch } from './client.ts';
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
  personas: {},
  // wave 73 §A: PodView gains these three; this file is not a reader of any
  // of them, so a minimal fixture is all this needs.
  plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
  roundNames: ['Test Cube', 'Test Cube', 'Test Cube'],
  verdict: null,
});

/** A room body as `GET /api/rooms/:id` sends one: the fields a body must carry to be a room, and these. */
const roomBody = (fields: Record<string, unknown>): Record<string, unknown> => ({ id: 'r-cube', name: 'Cube night', gameType: 'draft', locked: false, members: [], ...fields });
const answer = (fields: Record<string, unknown>): Response => new Response(JSON.stringify(roomBody(fields)), { status: 200 });
const room = (fields: Record<string, unknown>): RoomView => parseRoomView(roomBody(fields))!;

describe('fetchPodContext', () => {
  it('reads pod, tables and a name map in one call — every AI entrant by its own character', async () => {
    const pod = { ...podFixture(), personas: { ai: { name: 'Knight', avatarId: 'knight' }, 'ai:3': { name: 'Rogue', avatarId: 'rogue' } } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      answer({
        pod,
        tables: [{ id: 't-aaaaaaaa', players: [], matchId: null, series: { length: 3, wins: [0, 0], games: [], phase: 'seating' } }],
        members: [
          { id: 'u-alice', name: 'Alice', avatarId: 'sage' },
          { id: 'u-bob', name: 'Bob' },
          { id: 'u-cat', name: 'Cat', look: { picture: 'https://cdn.discordapp.com/avatars/1/a.png', cosmetics: { overlay: 'overlay.crown' } } },
        ],
        leader: 'u-bob',
      }),
    );

    const ctx = await fetchPodContext('r-cube');
    expect(ctx.pod).toEqual(pod);
    expect(ctx.tables).toHaveLength(1);
    expect(ctx.names).toEqual({ 'u-alice': 'Alice', 'u-bob': 'Bob', 'u-cat': 'Cat', ai: 'Knight', 'ai:3': 'Rogue' });
    // Bob has no character and no look: no entry, and the face falls back to his initial. Cat has
    // no character, but her picture and what she wears are her face.
    expect(ctx.avatars).toEqual({
      'u-alice': { id: 'sage' },
      'u-cat': { id: null, look: { picture: 'https://cdn.discordapp.com/avatars/1/a.png', cosmetics: { overlay: 'overlay.crown' } } },
      ai: { id: 'knight' },
      'ai:3': { id: 'rogue' },
    });
    // The member list and its owner, for the pod's spectators.
    expect([ctx.members, ctx.leaderId]).toEqual([[{ id: 'u-alice', name: 'Alice' }, { id: 'u-bob', name: 'Bob' }, { id: 'u-cat', name: 'Cat' }], 'u-bob']);
  });

  it('answers empty rather than throwing on a failed read', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await fetchPodContext('r-cube')).toEqual({ pod: null, tables: [], games: {}, names: {}, members: [], leaderId: '', avatars: {}, me: null, name: '', leader: false, gone: false });
  });

  it('says the room is gone on the server’s 404, and only then', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    expect((await fetchPodContext('r-cube')).gone).toBe(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    expect((await fetchPodContext('r-cube')).gone).toBe(false);
  });

  it('says whether I own the room', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer({ pod: null, you: { id: 'u-alice', leader: true } }));
    expect(await fetchPodContext('r-cube')).toMatchObject({ me: 'u-alice', leader: true, gone: false });
  });

  it('drops a malformed tables array rather than guessing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer({ pod: null, tables: 'nonsense' }));
    const ctx = await fetchPodContext('r-cube');
    expect(ctx.tables).toEqual([]);
  });
});

describe('relayedPodSource', () => {
  it("hands the pod each of the room screen's reads, the newest at once to a new follower, and nothing of another room's", () => {
    const source = relayedPodSource('r-cube');
    source.land(room({ name: 'First' }));
    const seen: string[] = [];
    const stop = source.follow('r-cube', (ctx) => seen.push(ctx.name));
    source.land(room({ name: 'Second' }));
    source.land(room({ id: 'r-other', name: 'Another room' }));
    stop();
    source.land(room({ name: 'After the pod left' }));
    expect(seen).toEqual(['First', 'Second']);
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

describe('nextGameStarts', () => {
  it('starts a fresh series, a game that died, and the next game of a series with no sideboarding', () => {
    expect(nextGameStarts('seating')).toBe(true);
    expect(nextGameStarts('playing')).toBe(true);
    // Gauntlet's Bo3 has no sideboarding: game 1 settles to `between` (`room/series.ts`).
    expect(nextGameStarts('between')).toBe(true);
  });

  it('waits for sideboarding, and never restarts a finished series', () => {
    expect(nextGameStarts('sideboarding')).toBe(false);
    expect(nextGameStarts('done')).toBe(false);
  });
});

describe('heldFor', () => {
  // A round's table is read once it is mine; the next round's table replaces it while the read of the
  // last one is still held. That read must never answer for the new table: it held the deck the last
  // round played, and the table started before this round's deck was picked (forge.yml run 42425042362).
  it('answers a read only for the table it was made at', () => {
    const held = { tableId: 't-round1', value: { deckLegal: true } };
    expect(heldFor(held, 't-round1')).toEqual({ deckLegal: true });
    expect(heldFor(held, 't-round2')).toBeNull();
    expect(heldFor(held, undefined)).toBeNull();
    expect(heldFor(null, 't-round1')).toBeNull();
  });
});
