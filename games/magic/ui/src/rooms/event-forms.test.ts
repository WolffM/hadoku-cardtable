import { describe, expect, it, vi } from 'vitest';
import { CreateEventBodySchema } from '@hadoku/shared';

import { refreshPolls, setPollsClient, subscribePolls } from '@hadoku/game-ui/front/polls.ts';
import { attachRallyForm, finishRallyReturn } from './event-forms.ts';
import { NEW_ROOM_FIELDS, NEW_TOURNAMENT, tournamentRoom } from './RoomFields.tsx';

const at = (href: string) => {
  const url = new URL(href);
  return { origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash } as Location;
};

function harness(href: string, kept: string | null) {
  const replaceState = vi.fn();
  const removeItem = vi.fn();
  const attachForm = vi.fn(async (formId: string) => ({ ok: false as const, message: formId }));
  const run = () => finishRallyReturn(at(href), { replaceState, state: null }, { getItem: () => kept, removeItem }, { attachForm });
  return { run, replaceState, removeItem, attachForm };
}

describe('Rally’s return trip', () => {
  it('attaches the form this tab asked for, and takes the trip off the address', async () => {
    const h = harness('https://hadoku.me/cardtable/?form=abc123&ref=ct-1#/rooms', 'ct-1');
    expect(await h.run()).toEqual({ ok: false, message: 'abc123' });
    expect(h.attachForm).toHaveBeenCalledWith('abc123');
    expect(h.replaceState).toHaveBeenCalledWith(null, '', 'https://hadoku.me/cardtable/#/rooms');
    expect(h.removeItem).toHaveBeenCalled();
  });

  it('a return this tab did not start attaches nothing; a page with no trip is left alone', async () => {
    const foreign = harness('https://hadoku.me/cardtable/?form=abc123&ref=ct-other', 'ct-1');
    expect(await foreign.run()).toBe('foreign');
    expect(foreign.attachForm).not.toHaveBeenCalled();
    expect(foreign.replaceState).toHaveBeenCalled();

    const none = harness('https://hadoku.me/cardtable/#/rooms', 'ct-1');
    expect(await none.run()).toBe('none');
    expect(none.replaceState).not.toHaveBeenCalled();
  });
});

describe('a tournament’s room, as Create event sends it', () => {
  it('a constructed tournament sends its format and deck rule; the server takes the body', () => {
    const room = tournamentRoom({ ...NEW_ROOM_FIELDS, mode: 'classic' }, { ...NEW_TOURNAMENT, format: '2015-09-18', tournamentDecks: 'per-round', clock: 'on' });
    expect(room).toMatchObject({ gameType: 'constructed-1v1', mode: 'classic', format: '2015-09-18', settings: { tournamentDecks: 'per-round', clock: 'on', handSmoothing: true } });
    expect(CreateEventBodySchema.safeParse({ title: 'Cup', startsAt: '2026-11-01T20:00:00.000Z', room }).success).toBe(true);
  });

  it('a draft tournament sends its cube every round and its pick timer, never a deck rule', () => {
    const room = tournamentRoom({ ...NEW_ROOM_FIELDS, gameType: 'draft' }, { ...NEW_TOURNAMENT, cube: 'vintage', pickTimer: { on: true, speed: 2 }, format: '2015-09-18' });
    expect(room).toEqual({
      gameType: 'draft',
      clientMode: 'builtin',
      plan: { rounds: [0, 1, 2].map(() => ({ kind: 'cube', cubeId: 'vintage' })) },
      settings: { clock: 'auto', pickTimer: { on: true, speed: 2 }, handSmoothing: true },
    });
    expect(CreateEventBodySchema.safeParse({ title: 'Pod', startsAt: '2026-11-01T20:00:00.000Z', room }).success).toBe(true);
  });
});

describe('a form attached from Create event shows under Polls at once (cardtable#24 item 5)', () => {
  const form = (id: string) => ({
    id,
    title: `Form ${id}`,
    status: 'open' as const,
    closesAt: null,
    url: `https://hadoku.me/rally/f/${id}`,
    createdBy: 'alice',
    schema: { name: 'event-signup', version: 1 },
    attachedBy: 'alice',
    mine: true,
    windows: [],
  });

  /** A polls read the test answers by hand, in whatever order it likes. */
  function deferredReads() {
    const reads: { answer: (forms: ReturnType<typeof form>[]) => void }[] = [];
    const list = () =>
      new Promise<ReturnType<typeof form>[]>((resolve) => {
        reads.push({ answer: resolve });
      });
    return { reads, client: { list } };
  }

  it('the attach puts the form in the polls the moment it answers, and a read begun before it cannot take it away', async () => {
    const { reads, client } = deferredReads();
    setPollsClient(client);
    const seen: (string[] | null)[] = [];
    const stop = subscribePolls((polls) => seen.push(polls === null ? null : polls.map((p) => p.id)));

    // The Polls card mounts and reads; Rally's return attaches the form while that read is out.
    void refreshPolls();
    const attachForm = vi.fn(async () => ({ ok: true as const, form: form('new') }));
    const outcome = await attachRallyForm('new', { attachForm });
    expect(outcome).toMatchObject({ ok: true });
    expect(seen.at(-1)).toEqual(['new']);

    // The first read answers late, without the form: it is stale, and changes nothing.
    reads[0]!.answer([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)).toEqual(['new']);

    // The read the attach began is the one that counts.
    reads.at(-1)!.answer([form('old'), form('new')]);
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['old', 'new']));
    stop();
  });

  it('Rally’s return trip attaches through the same path', async () => {
    const { client } = deferredReads();
    setPollsClient(client);
    const seen: (string[] | null)[] = [];
    const stop = subscribePolls((polls) => seen.push(polls === null ? null : polls.map((p) => p.id)));
    const attachForm = vi.fn(async () => ({ ok: true as const, form: form('trip') }));
    await finishRallyReturn(at('https://hadoku.me/cardtable/?form=trip&ref=ct-1#/'), { replaceState: vi.fn(), state: null }, { getItem: () => 'ct-1', removeItem: vi.fn() }, { attachForm });
    expect(seen.at(-1)).toEqual(['trip']);
    stop();
  });
});
