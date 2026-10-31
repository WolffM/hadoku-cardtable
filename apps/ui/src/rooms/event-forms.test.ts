import { describe, expect, it, vi } from 'vitest';
import { CreateEventBodySchema } from '@hadoku/shared';

import { finishRallyReturn } from './event-forms.ts';
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
