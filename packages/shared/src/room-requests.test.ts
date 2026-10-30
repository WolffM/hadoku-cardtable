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

  it('runs the clock on auto exactly in a pod (a tournament or a draft), and as the leader said otherwise', () => {
    expect(clockOn({ clock: 'auto', tournament: true }, 'constructed-1v1')).toBe(true);
    expect(clockOn({ clock: 'auto', tournament: false }, 'constructed-1v1')).toBe(false);
    expect(clockOn({ clock: 'auto', tournament: false }, 'draft')).toBe(true);
    expect(clockOn({ clock: 'on', tournament: false }, 'constructed-1v1')).toBe(true);
    expect(clockOn({ clock: 'off', tournament: true }, 'draft')).toBe(false);
  });

  it('patches the clock and the pick timer as settings', () => {
    expect(PatchRoomBodySchema.safeParse({ settings: { clock: 'on' } }).success).toBe(true);
    expect(PatchRoomBodySchema.safeParse({ settings: { pickTimer: { on: true, speed: 0.5 } } }).success).toBe(true);
  });
});
