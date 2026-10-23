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
  TableGameSchema,
  TableGamesSchema,
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

describe('TableGameSchema', () => {
  const DECK = { name: 'Goblins', colors: ['R'], art: 'Goblin Matron' };
  const LIVE = { turn: 7, active: 1, life: [14, 9], hand: [2, 4] };

  it('accepts a game under way, a table between games, and a seat whose deck was never seen', () => {
    expect(TableGameSchema.safeParse({ decks: [DECK, DECK], live: LIVE }).success).toBe(true);
    expect(TableGameSchema.safeParse({ decks: [DECK, null], live: null }).success).toBe(true);
    expect(TableGameSchema.safeParse({ decks: [{ ...DECK, art: null }, DECK], live: { ...LIVE, active: null, life: [null, 20] } }).success).toBe(true);
  });

  it('refuses a third seat, a colour that is not one, and an unknown field', () => {
    expect(TableGameSchema.safeParse({ decks: [DECK, DECK, DECK], live: null }).success).toBe(false);
    expect(TableGameSchema.safeParse({ decks: [{ ...DECK, colors: ['X'] }, DECK], live: null }).success).toBe(false);
    expect(TableGameSchema.safeParse({ decks: [DECK, DECK], live: { ...LIVE, step: 'Combat' } }).success).toBe(false);
  });

  it('keys a room body’s games by table id', () => {
    expect(TableGamesSchema.safeParse({ 't-1234abcd': { decks: [DECK, DECK], live: LIVE } }).success).toBe(true);
    expect(TableGamesSchema.safeParse({ 't-1234abcd': { decks: [DECK], live: null } }).success).toBe(false);
  });
});
