import { describe, expect, it } from 'vitest';

import { clockOn, DEFAULT_ROOM_SETTINGS, PatchRoomBodySchema, RoomSettingsSchema } from './room-requests.ts';

describe('the room settings', () => {
  it('defaults parse against the schema, with the clock on auto and the pick timer off', () => {
    expect(RoomSettingsSchema.parse(DEFAULT_ROOM_SETTINGS)).toEqual({
      handSmoothing: true,
      tournament: false,
      tournamentDecks: 'locked',
      clock: 'auto',
      pickTimer: { on: false, speed: 1 },
    });
  });

  it('runs the clock on auto exactly in a tournament, and as the leader said otherwise', () => {
    expect(clockOn({ clock: 'auto', tournament: true })).toBe(true);
    expect(clockOn({ clock: 'auto', tournament: false })).toBe(false);
    expect(clockOn({ clock: 'on', tournament: false })).toBe(true);
    expect(clockOn({ clock: 'off', tournament: true })).toBe(false);
  });

  it('patches the clock and the pick timer as settings', () => {
    expect(PatchRoomBodySchema.safeParse({ settings: { clock: 'on' } }).success).toBe(true);
    expect(PatchRoomBodySchema.safeParse({ settings: { pickTimer: { on: true, speed: 0.5 } } }).success).toBe(true);
  });
});
