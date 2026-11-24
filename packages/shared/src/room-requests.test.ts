import { describe, expect, it } from 'vitest';

import { clockOn, DEFAULT_ROOM_SETTINGS, PatchRoomBodySchema, RoomSettingsSchema } from './room-requests.ts';

describe('the room settings', () => {
  it('defaults parse against the schema, with the clock on auto, the pick timer off and every bot on the model', () => {
    expect(RoomSettingsSchema.parse(DEFAULT_ROOM_SETTINGS)).toEqual({
      handSmoothing: true,
      tournament: false,
      tournamentDecks: 'locked',
      clock: 'auto',
      pickTimer: { on: false, speed: 1 },
      draftBots: 'model',
      botsPlay: true,
    });
  });

  it('a PATCH turns the bots out of the Swiss, and refuses anything but a boolean', () => {
    expect(PatchRoomBodySchema.safeParse({ settings: { botsPlay: false } }).success).toBe(true);
    expect(PatchRoomBodySchema.safeParse({ settings: { botsPlay: 'no' } }).success).toBe(false);
  });

  it('a PATCH sets the draft bots to split or pick order, and refuses any other value', () => {
    expect(PatchRoomBodySchema.safeParse({ settings: { draftBots: 'split' } }).success).toBe(true);
    expect(PatchRoomBodySchema.safeParse({ settings: { draftBots: 'pick-order' } }).success).toBe(true);
    expect(PatchRoomBodySchema.safeParse({ settings: { draftBots: 'random' } }).success).toBe(false);
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

  // The refusals a client has always been answered, word for word, now that the fields are declared through the platform's spec.
  it.each([
    [{ handSmoothing: 1 }, 'settings.handSmoothing must be a boolean'],
    [{ tournamentDecks: 'never' }, 'settings.tournamentDecks must be one of: locked, per-round'],
    [{ clock: 'sometimes' }, 'settings.clock must be one of: auto, on, off'],
    [{ pickTimer: { on: true, speed: 9 } }, 'settings.pickTimer must be { on: boolean, speed: 0.25–4 }'],
    [{ draftBots: 'random' }, 'settings.draftBots must be one of: model, pick-order, split'],
    [{ matchLength: 3 }, 'unknown setting(s): matchLength'],
    [{}, 'settings names no setting'],
    ['on', 'settings must be an object'],
  ])('a PATCH of settings %j is refused: %s', (settings, error) => {
    const parsed = PatchRoomBodySchema.safeParse({ settings });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(error);
  });
});
