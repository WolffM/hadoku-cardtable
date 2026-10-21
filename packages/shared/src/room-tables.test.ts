/**
 * The wire shape of `RoomView.tables`, checked at the schema — the one thing
 * lane G's board strip and `apps/server/src/room/lobby.ts` both have to agree
 * on without importing each other.
 */

import { describe, expect, it } from 'vitest';
import {
  RoomTableGameSchema,
  RoomTableSchema,
  RoomTableSeriesSchema,
  RoomTablesSchema,
  SeriesLengthSchema,
  SeriesPhaseSchema,
  SERIES_PHASES,
} from './room-tables.ts';

const GAME = { matchId: 'm-1', winner: 0 } as const;
const SERIES = { length: 1, wins: [0, 0], games: [], phase: 'seating' } as const;
const TABLE = { id: 't-abcd1234', players: [], matchId: null, series: SERIES } as const;

describe('SeriesLengthSchema', () => {
  it('accepts 1 and 3, and refuses 2 or a string', () => {
    expect(SeriesLengthSchema.safeParse(1).success).toBe(true);
    expect(SeriesLengthSchema.safeParse(3).success).toBe(true);
    expect(SeriesLengthSchema.safeParse(2).success).toBe(false);
    expect(SeriesLengthSchema.safeParse('3').success).toBe(false);
  });
});

describe('SeriesPhaseSchema', () => {
  it('is exactly the five phases, in the order the series moves through them', () => {
    expect(SERIES_PHASES).toEqual(['seating', 'playing', 'sideboarding', 'between', 'done']);
    for (const p of SERIES_PHASES) expect(SeriesPhaseSchema.safeParse(p).success).toBe(true);
    expect(SeriesPhaseSchema.safeParse('building').success).toBe(false);
  });
});

describe('RoomTableGameSchema', () => {
  it('accepts a decided game and an undecided one, refuses a third winner value', () => {
    expect(RoomTableGameSchema.safeParse(GAME).success).toBe(true);
    expect(RoomTableGameSchema.safeParse({ matchId: 'm-2', winner: null }).success).toBe(true);
    expect(RoomTableGameSchema.safeParse({ matchId: 'm-3', winner: 2 }).success).toBe(false);
    expect(RoomTableGameSchema.safeParse({ winner: 0 }).success).toBe(false);
  });
});

describe('RoomTableSeriesSchema', () => {
  it('accepts the shape a table starts on and refuses an out-of-range length', () => {
    expect(RoomTableSeriesSchema.safeParse(SERIES).success).toBe(true);
    expect(RoomTableSeriesSchema.safeParse({ ...SERIES, length: 5 }).success).toBe(false);
    expect(RoomTableSeriesSchema.safeParse({ ...SERIES, wins: [0, 0, 0] }).success).toBe(false);
    expect(RoomTableSeriesSchema.safeParse({ ...SERIES, games: [GAME] }).success).toBe(true);
  });
});

describe('RoomTableSchema', () => {
  it('accepts an empty table and a seated one, in seat order', () => {
    expect(RoomTableSchema.safeParse(TABLE).success).toBe(true);
    const seated = { ...TABLE, players: [{ memberId: 'fk:a', name: 'alice' }, { memberId: 'fk:b', name: 'bob' }] };
    expect(RoomTableSchema.safeParse(seated).success).toBe(true);
  });

  it('refuses a third player and an unknown field', () => {
    const three = { ...TABLE, players: [{ memberId: 'a', name: 'a' }, { memberId: 'b', name: 'b' }, { memberId: 'c', name: 'c' }] };
    expect(RoomTableSchema.safeParse(three).success).toBe(false);
    expect(RoomTableSchema.safeParse({ ...TABLE, extra: 1 }).success).toBe(false);
  });
});

describe('RoomTablesSchema', () => {
  it('requires at least one table — a room never has zero', () => {
    expect(RoomTablesSchema.safeParse([]).success).toBe(false);
    expect(RoomTablesSchema.safeParse([TABLE]).success).toBe(true);
    expect(RoomTablesSchema.safeParse([TABLE, { ...TABLE, id: 't-5678abcd' }]).success).toBe(true);
  });
});
