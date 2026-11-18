import { describe, expect, it } from 'vitest';
import { AI_SEAT, CLOSED_SEAT } from '@hadoku/platform-wire/seats';

import { platformSeats, type PlatformSeatRoom } from './platform.ts';

const look = { picture: 'https://cdn.discordapp.com/avatars/1/a.png' };
const room = (over: Partial<PlatformSeatRoom> = {}): PlatformSeatRoom => ({
  leader: 'ada',
  seats: ['ada', AI_SEAT, null, CLOSED_SEAT],
  members: [
    { id: 'ada', name: 'Ada', avatarId: 'mentor', look, ready: true },
    { id: 'bo', name: 'Bo' },
  ],
  aiSeats: [null, { name: 'Knight', avatarId: 'knight' }, null, null],
  ...over,
});

describe('platformSeats', () => {
  it('a member wears their account’s face — character AND picture — and a bot the server’s persona', () => {
    const { slots, mySeat, spectators, realSeatCount } = platformSeats(room(), 'ada', { ceiling: 6 });
    expect(slots.map((s) => s.occupant.kind)).toEqual(['member', 'bot', 'open', 'closed']);
    expect(slots[0]!.occupant).toEqual({ kind: 'member', id: 'ada', name: 'Ada', avatarId: 'mentor', look, ready: true, leader: true, mine: true });
    expect(slots[1]!.occupant).toEqual({ kind: 'bot', name: 'Knight', avatarId: 'knight' });
    expect(mySeat).toBe(0);
    expect(realSeatCount).toBe(4);
    expect(spectators).toEqual([{ id: 'bo', name: 'Bo' }]);
  });

  it('draws the "+1" slot only when every seat is taken and the room can grow', () => {
    expect(platformSeats(room(), 'ada', { ceiling: 6 }).slots).toHaveLength(4);
    const full = room({ seats: ['ada', AI_SEAT] });
    expect(platformSeats(full, 'ada', { ceiling: 6 }).slots.map((s) => s.occupant.kind)).toEqual(['member', 'bot', 'open']);
    expect(platformSeats(full, 'ada', { ceiling: 2 }).slots).toHaveLength(2);
    // A closed seat is the leader's to open; nothing is grown past it.
    expect(platformSeats(room({ seats: ['ada', CLOSED_SEAT] }), 'ada', { ceiling: 6 }).slots).toHaveLength(2);
  });

  it('a seat whose holder left reads as open; a bot with no persona is just "Bot"', () => {
    const { slots } = platformSeats(room({ seats: ['gone', AI_SEAT], aiSeats: undefined }), null, { ceiling: 2 });
    expect(slots.map((s) => s.occupant)).toEqual([{ kind: 'open' }, { kind: 'bot', name: 'Bot' }]);
  });

  it('readiness: false reads every member ready', () => {
    const r = room({ seats: ['bo', null] });
    expect(platformSeats(r, null, { ceiling: 2 }).slots[0]!.occupant).toMatchObject({ ready: false });
    expect(platformSeats(r, null, { ceiling: 2, readiness: false }).slots[0]!.occupant).toMatchObject({ ready: true });
  });
});
