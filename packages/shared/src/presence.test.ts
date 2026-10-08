/*
 * The presence wire schema: a spot is board-relative with a zone hint only,
 * and a message carries the sender's own hand row count. A match spans a
 * deploy, so both schemas also have to accept the shape a tab still on the
 * OLD bundle sends — a spot's old `owner` field, a message with no
 * `handRows` at all — without ever reading what they accepted (presence.ts's
 * header has the full argument). The properties load-bearing enough to need
 * a valid, an invalid, and an old-shape case each.
 */

import { describe, expect, it } from 'vitest';

import { PresenceEchoSchema, PresenceSchema, PresenceSpotSchema } from './presence.ts';

const spot = (zone: 'hand' | 'battlefield' | 'stack' | null = null) => ({ zone, x: 0.4, y: 0.6 });

describe('PresenceSpotSchema', () => {
  it('accepts a zone hint or none, with board-relative fractions', () => {
    expect(PresenceSpotSchema.safeParse(spot('battlefield')).success).toBe(true);
    expect(PresenceSpotSchema.safeParse(spot(null)).success).toBe(true);
  });

  it('rejects a fraction outside [0, 1], an unknown zone, and an unrelated extra key', () => {
    expect(PresenceSpotSchema.safeParse({ ...spot(), x: 1.1 }).success).toBe(false);
    expect(PresenceSpotSchema.safeParse({ ...spot(), zone: 'rail' }).success).toBe(false);
    expect(PresenceSpotSchema.safeParse({ ...spot(), cardId: 7 }).success).toBe(false);
  });

  it('a pre-deploy sender’s `owner` field is accepted and dropped, never carried into the parsed spot', () => {
    const parsed = PresenceSpotSchema.safeParse({ ...spot('hand'), owner: 'you' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(spot('hand'));
    expect(parsed.success && Object.keys(parsed.data)).not.toContain('owner');
  });
});

describe('PresenceSchema', () => {
  const base = { matchId: 'm-1', type: 'presence' as const, pointer: spot('hand'), held: false, from: null, handRows: 1 as const };

  it('accepts a message with handRows 1 or 2', () => {
    expect(PresenceSchema.safeParse(base).success).toBe(true);
    expect(PresenceSchema.safeParse({ ...base, handRows: 2 }).success).toBe(true);
  });

  it('rejects a handRows that is neither 1 nor 2, and a card id smuggled in anywhere', () => {
    expect(PresenceSchema.safeParse({ ...base, handRows: 3 }).success).toBe(false);
    expect(PresenceSchema.safeParse({ ...base, cardId: 7 }).success).toBe(false);
  });

  it('a pre-deploy sender’s message (no handRows at all, `owner` on its spots) relays as handRows 1 with no owner', () => {
    const { handRows: _omit, ...oldShape } = base;
    const parsed = PresenceSchema.safeParse({ ...oldShape, pointer: { ...spot('hand'), owner: 'you' } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.handRows).toBe(1);
    expect(parsed.success && parsed.data.pointer).toEqual(spot('hand'));
  });

  it('a held card may carry an arrow tail; letting go carries the release spot in the same field', () => {
    const aiming = { ...base, held: true, from: spot('hand') };
    expect(PresenceSchema.safeParse(aiming).success).toBe(true);
    const releasing = { ...base, held: false, pointer: spot('battlefield'), from: spot('battlefield') };
    expect(PresenceSchema.safeParse(releasing).success).toBe(true);
  });

  it('a pre-deploy sender (no `placing` at all) still parses, defaulted to null', () => {
    const parsed = PresenceSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.placing).toBeNull();
  });

  it('a spell release carries its point as `placing.at`, beside `from`', () => {
    const releasing = { ...base, held: false, pointer: spot('stack'), from: spot('stack'), placing: { at: spot('stack') } };
    const parsed = PresenceSchema.safeParse(releasing);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.placing).toEqual({ at: spot('stack') });
  });

  it('rejects a `placing` missing `at`, or carrying an extra key', () => {
    expect(PresenceSchema.safeParse({ ...base, placing: {} }).success).toBe(false);
    expect(PresenceSchema.safeParse({ ...base, placing: { at: spot('stack'), cardId: 7 } }).success).toBe(false);
  });
});

describe('PresenceEchoSchema', () => {
  it('is the message plus the seat it came from', () => {
    const base = { matchId: 'm-1', type: 'presence' as const, pointer: spot(), held: false, from: null, handRows: 1 as const };
    expect(PresenceEchoSchema.safeParse({ ...base, seat: 0 }).success).toBe(true);
    expect(PresenceEchoSchema.safeParse(base).success).toBe(false);
    expect(PresenceEchoSchema.safeParse({ ...base, seat: -1 }).success).toBe(false);
  });
});
