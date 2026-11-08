/**
 * Magic's schemas built on `@hadoku/platform-wire` keep their field names: one recorded payload of
 * each comes back equal. Recorded on 2026-11-07: the presence row from a prod match recording
 * (`m-c04f95019ce4.public.jsonl.gz`), the sound event from prod's log (its `data`, as the server
 * flattened it), the event from the server's own `POST /api/events`.
 */
import { describe, expect, it } from 'vitest';

import { EventViewSchema } from './events.ts';
import { PresenceEchoSchema } from './presence.ts';
import { RoomTableSchema } from './room-tables.ts';
import { ClientEventSchema } from './telemetry.ts';

const PRESENCE_ECHO = {
  matchId: 'm-c04f95019ce4',
  type: 'presence',
  pointer: { zone: 'battlefield', x: 0.9750195697559556, y: 0.7461412608658607 },
  anchor: { zone: 'battlefield', own: true, row: null, card: 154, item: null, x: 14.401403608378168, y: 0.6729412865330069 },
  held: false,
  from: null,
  arranging: null,
  placing: null,
  handMove: null,
  seat: 0,
};

const EVENT = {
  id: 'e-ec143b995014',
  kind: 'constructed-tournament',
  title: 'Pauper cup',
  startsAt: '2026-10-30T12:00:00.000Z',
  organizer: 'user-alice',
  mine: true,
  roomId: 'r-b97bb1051d2a',
  room: {
    gameType: 'constructed-1v1',
    mode: 'classic',
    format: 'free',
    settings: { handSmoothing: false, tournament: true, tournamentDecks: 'per-round', clock: 'on', pickTimer: { on: false, speed: 1 }, draftBots: 'model' },
    pool: null,
    locked: false,
    phase: 'lobby',
    members: 1,
    entrants: 1,
  },
};

describe('Magic on platform-wire round trip', () => {
  it('a presence row', () => {
    expect(PresenceEchoSchema.parse(PRESENCE_ECHO)).toEqual(PRESENCE_ECHO);
  });

  it('a seat telemetry post', () => {
    const sound = { matchId: 'm-c04f95019ce4', kind: 'sound', data: { why: 'decision', roles: 'ui.prompt', cells: '', count: 1, seq: 2, turn: 0, muted: false, key: 'bar:Keep' } };
    expect(ClientEventSchema.parse(sound)).toEqual(sound);
  });

  it('an event', () => {
    expect(EventViewSchema.parse(EVENT)).toEqual(EVENT);
  });

  it('a table between games of a Bo3', () => {
    const table = { id: 't-abcd1234', players: [], matchId: null, series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-13e598202544', winner: 0 }], phase: 'sideboarding' } };
    expect(RoomTableSchema.parse(table)).toEqual(table);
  });
});
