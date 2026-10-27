import { describe, expect, it } from 'vitest';

import { ReplayDetailResponseSchema, ReplayListResponseSchema, ReplaySummarySchema } from './replay.ts';

const VALID_FRAME = { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } };

const SUMMARY = {
  matchId: 'm-1',
  roomId: 'r-1',
  players: ['A', 'B'] as [string, string],
  decks: [['W', 'U'], null] as [string[] | null, string[] | null],
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:10:00.000Z',
  winner: 0 as const,
  source: 'stream' as const,
};

describe('ReplaySummarySchema', () => {
  it('parses a full row', () => {
    expect(ReplaySummarySchema.safeParse(SUMMARY).success).toBe(true);
  });

  it('accepts a null winner (a draw, or a match still being played) and null decks (an unseen deck)', () => {
    expect(ReplaySummarySchema.safeParse({ ...SUMMARY, winner: null, decks: [null, null], endedAt: null }).success).toBe(true);
  });

  it('refuses a winner outside {0, 1, null}, an unknown source, and an extra field', () => {
    expect(ReplaySummarySchema.safeParse({ ...SUMMARY, winner: 2 }).success).toBe(false);
    expect(ReplaySummarySchema.safeParse({ ...SUMMARY, source: 'cached' }).success).toBe(false);
    expect(ReplaySummarySchema.safeParse({ ...SUMMARY, extra: true }).success).toBe(false);
  });

  it('refuses a players tuple that is not exactly two', () => {
    expect(ReplaySummarySchema.safeParse({ ...SUMMARY, players: ['A'] }).success).toBe(false);
  });
});

describe('ReplayListResponseSchema', () => {
  it('parses a list of rows, including an empty one', () => {
    expect(ReplayListResponseSchema.safeParse({ replays: [SUMMARY] }).success).toBe(true);
    expect(ReplayListResponseSchema.safeParse({ replays: [] }).success).toBe(true);
  });
});

describe('ReplayDetailResponseSchema', () => {
  it('parses a header, a list of envelopes with a validated frame, and an end', () => {
    const detail = {
      header: { matchId: 'm-1', roomId: 'r-1', players: ['A', 'B'], ai: [false, false], decks: [['W'], null], startedAt: '2026-01-01T00:00:00.000Z' },
      envs: [{ at: 0, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: VALID_FRAME } }],
      end: { endedAt: '2026-01-01T00:10:00.000Z', winner: 1 },
    };
    expect(ReplayDetailResponseSchema.safeParse(detail).success).toBe(true);
  });

  it('refuses an envelope whose frame is not a real server frame', () => {
    const detail = {
      header: { matchId: 'm-1', roomId: null, players: ['A', 'B'], ai: [false, true], decks: [null, null], startedAt: '2026-01-01T00:00:00.000Z' },
      envs: [{ at: 0, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'not-a-real-method' } } }],
      end: { endedAt: '2026-01-01T00:10:00.000Z', winner: null },
    };
    expect(ReplayDetailResponseSchema.safeParse(detail).success).toBe(false);
  });
});
