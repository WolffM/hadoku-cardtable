/**
 * Every schema that moved keeps its field names: one recorded payload of each, parsed through the
 * package, comes back equal. Recorded on 2026-11-07: the presence row from a prod match recording
 * (`m-c04f95019ce4.public.jsonl.gz`), the page and match telemetry from prod's own log lines (their
 * `data`, as the server flattened it), the event from the server's `POST /api/events`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { serverEnvelopeSchema } from './envelope.ts';
import { eventListSchema, eventViewSchema } from './events.ts';
import { BoardFractionSchema, presenceEchoSchema } from './presence.ts';
import { roomTableSchemas } from './tables.ts';
import { clientEventSchema, PageEventSchema } from './telemetry.ts';

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

const PAGE_EVENT = {
  page: 'front',
  kind: 'perf',
  data: { what: 'scroll', frames: 14, ms: 484, p50: 18, p95: 18, max: 17, over25: 0, over50: 0, browser: 'firefox', version: 153, dpr: 1.5, vw: 1707, vh: 813, rooms: 4, ui: 'v0.56.0+91a313c62' },
};

const CLIENT_EVENT = {
  matchId: 'm-c04f95019ce4',
  kind: 'sound',
  data: { why: 'decision', roles: 'ui.prompt', cells: '', count: 1, seq: 2, turn: 0, muted: false, key: 'bar:Keep' },
};

const EVENT = {
  id: 'e-ec143b995014',
  kind: 'constructed-tournament',
  title: 'Pauper cup',
  startsAt: '2026-10-30T12:00:00.000Z',
  organizer: 'user-alice',
  mine: true,
  roomId: 'r-b97bb1051d2a',
  room: { gameType: 'constructed-1v1', mode: 'classic', format: 'free', pool: null, locked: false, phase: 'lobby', members: 1, entrants: 1 },
};

const TABLE = {
  id: 't-abcd1234',
  players: [{ memberId: 'fk:9401d17b40b86019', name: 'Hadoku' }],
  matchId: 'm-c04f95019ce4',
  series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-13e598202544', winner: 0 }], phase: 'playing' },
};

/** A stand-in for a game's own shapes: the package's frame around them is what is under test. */
const opaque = z.record(z.string(), z.unknown());

describe('platform-wire round trip', () => {
  it('a page telemetry post and a match one', () => {
    expect(PageEventSchema.parse(PAGE_EVENT)).toEqual(PAGE_EVENT);
    expect(clientEventSchema(['sound']).parse(CLIENT_EVENT)).toEqual(CLIENT_EVENT);
  });

  it('a presence row, stamped with its seat', () => {
    const { seat: _seat, pointer: _pointer, ...rest } = PRESENCE_ECHO;
    const game = z.strictObject({
      ...Object.fromEntries(Object.keys(rest).map((k) => [k, z.unknown()])),
      pointer: z.strictObject({ zone: z.string().nullable(), x: BoardFractionSchema, y: BoardFractionSchema }).nullable(),
    });
    expect(presenceEchoSchema(game).parse(PRESENCE_ECHO)).toEqual(PRESENCE_ECHO);
  });

  it('an event, and a list of one', () => {
    const view = eventViewSchema(z.string(), opaque);
    expect(view.parse(EVENT)).toEqual(EVENT);
    expect(eventListSchema(view).parse({ events: [EVENT] })).toEqual({ events: [EVENT] });
  });

  it('a table and its series', () => {
    expect(roomTableSchemas(['seating', 'playing', 'done']).RoomTablesSchema.parse([TABLE])).toEqual([TABLE]);
  });

  it('a server envelope around a game frame', () => {
    const envelope = { matchId: 'm-c04f95019ce4', cursor: { epoch: 'e1', seq: 7 }, frame: { method: 'setGameView', args: [1] } };
    expect(serverEnvelopeSchema(opaque).parse(envelope)).toEqual(envelope);
  });
});
