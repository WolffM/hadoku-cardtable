/*
 * The match transport contract — wave 64 §S (S1/S8).
 *
 * Both apps' own `transport.ts` are now thin re-exports; the cross-package
 * "no second copy" check lives in `apps/ui/src/play/live/transport.test.ts`
 * (it has to import both apps to compare them). This file tests the one
 * source of truth itself: the schemas parse what they must and refuse what
 * they must, and the two-stage envelope parsers keep their documented
 * properties.
 */

import { describe, expect, it } from 'vitest';

import {
  AutoYieldSchema,
  autoYieldFrame,
  ClientEnvelopeSchema,
  FullControlSchema,
  fullControlFrame,
  MATCH_EVENTS,
  MatchErrorSchema,
  MatchRequestSchema,
  MatchSnapshotSchema,
  parseAutoYield,
  parseClientEnvelope,
  parseFullControl,
  parseMatchRequest,
  parseServerEnvelope,
  parseStopPreference,
  ServerEnvelopeSchema,
  StopPhaseSchema,
  StopPreferenceSchema,
  stopAt,
  stopPreferenceFrame,
  stopStep,
  parseTriggerDecision,
  parseTriggerDecisions,
  triggerDecisionFrame,
} from './match-wire.ts';

const VALID_FRAME = { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } };

describe('MATCH_EVENTS', () => {
  it('names every event this contract uses, both directions', () => {
    expect(MATCH_EVENTS.join).toBe('forge:join');
    expect(MATCH_EVENTS.resync).toBe('forge:resync');
    expect(MATCH_EVENTS.fullControl).toBe('forge:full-control');
    expect(MATCH_EVENTS.autoYield).toBe('forge:auto-yield');
    expect(MATCH_EVENTS.stopPreference).toBe('forge:stop-preference');
    expect(MATCH_EVENTS.seats).toBe('forge:seats');
    expect(MATCH_EVENTS.role).toBe('forge:role');
    expect(MATCH_EVENTS.triggerDecision).toBe('forge:trigger-decision');
    expect(MATCH_EVENTS.triggerDecisions).toBe('forge:trigger-decisions');
    expect(typeof MATCH_EVENTS.serverToClient).toBe('string');
    expect(typeof MATCH_EVENTS.clientToServer).toBe('string');
  });
});

describe('MatchRequestSchema / parseMatchRequest', () => {
  it('accepts a bare matchId and refuses an empty one or an extra field', () => {
    expect(MatchRequestSchema.safeParse({ matchId: 'm1' }).success).toBe(true);
    expect(parseMatchRequest({ matchId: 'm1' })).toEqual({ ok: true, value: { matchId: 'm1' } });
    expect(parseMatchRequest({ matchId: '' }).ok).toBe(false);
    expect(parseMatchRequest({ matchId: 'm1', extra: 1 }).ok).toBe(false);
  });

  it('takes an optional tab id of 8..64 url-safe characters, and nothing else in its place', () => {
    expect(parseMatchRequest({ matchId: 'm1', tabId: 'a1B2-c3_d4' })).toEqual({ ok: true, value: { matchId: 'm1', tabId: 'a1B2-c3_d4' } });
    expect(parseMatchRequest({ matchId: 'm1', tabId: 'short' }).ok).toBe(false);
    expect(parseMatchRequest({ matchId: 'm1', tabId: 'x'.repeat(65) }).ok).toBe(false);
    expect(parseMatchRequest({ matchId: 'm1', tabId: 'has space!' }).ok).toBe(false);
    expect(parseMatchRequest({ matchId: 'm1', tabId: 12345678 }).ok).toBe(false);
  });
});

describe('ClientEnvelopeSchema / parseClientEnvelope', () => {
  it('checks the envelope, then the frame — a malformed frame is a frame-path error', () => {
    const good = parseClientEnvelope({ matchId: 'm1', frame: { kind: 'act', method: 'selectButtonOk' } });
    expect(good).toEqual({ ok: true, value: { matchId: 'm1', frame: { kind: 'act', method: 'selectButtonOk' } } });

    const bad = parseClientEnvelope({ matchId: 'm1', frame: { kind: 'act', method: 'not-a-real-method' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.path.startsWith('$.frame'))).toBe(true);

    const noMatchId = parseClientEnvelope({ frame: { kind: 'act', method: 'selectButtonOk' } });
    expect(noMatchId.ok).toBe(false);
  });

  it('carries an optional placement only with a selectCard act, and refuses an unknown field', () => {
    expect(ClientEnvelopeSchema.safeParse({ matchId: 'm1', frame: {}, bogus: true }).success).toBe(false);
  });
});

describe('FullControlSchema / fullControlFrame — one name, one shape, both directions', () => {
  it('builds a payload the schema itself accepts', () => {
    const payload = fullControlFrame('m1', true);
    expect(FullControlSchema.safeParse(payload).success).toBe(true);
    expect(payload).toEqual({ matchId: 'm1', on: true });
  });

  it('refuses a payload missing either field', () => {
    expect(parseFullControl({ matchId: 'm1' }).ok).toBe(false);
    expect(parseFullControl({ on: true }).ok).toBe(false);
  });
});

describe('AutoYieldSchema / autoYieldFrame', () => {
  it('is the exact same shape as FullControlSchema, client → server only', () => {
    const payload = autoYieldFrame('m1', false);
    expect(AutoYieldSchema.safeParse(payload).success).toBe(true);
    expect(parseAutoYield(payload)).toEqual({ ok: true, value: payload });
  });
});

describe('trigger decisions', () => {
  const key = 'Whenever another creature enters, you may gain 1 life.';
  it("a seat sends Forge's own decision for one key, ASK included", () => {
    for (const decision of ['ACCEPT', 'DECLINE', 'ASK'] as const) {
      expect(parseTriggerDecision(triggerDecisionFrame('m1', key, decision))).toEqual({ ok: true, value: { matchId: 'm1', key, decision } });
    }
    expect(parseTriggerDecision({ matchId: 'm1', key, decision: 'ALWAYS' }).ok).toBe(false);
    expect(parseTriggerDecision({ matchId: 'm1', key: '', decision: 'ACCEPT' }).ok).toBe(false);
  });
  it('the server sends the remembered list with names; ASK is never in it', () => {
    const decisions = [{ key, name: "Soul's Attendant", decision: 'ACCEPT' }];
    expect(parseTriggerDecisions({ matchId: 'm1', decisions }).ok).toBe(true);
    expect(parseTriggerDecisions({ matchId: 'm1', decisions: [{ ...decisions[0], decision: 'ASK' }] }).ok).toBe(false);
    expect(parseTriggerDecisions({ matchId: 'm1', decisions: [{ key, decision: 'ACCEPT' }] }).ok).toBe(false);
  });
});

describe('StopPreferenceSchema / stopPreferenceFrame', () => {
  it('pins type to the literal "stopPreference"', () => {
    const payload = stopPreferenceFrame('m1', true);
    expect(payload).toEqual({ matchId: 'm1', type: 'stopPreference', stopAtEndStep: true });
    expect(StopPreferenceSchema.safeParse(payload).success).toBe(true);
    expect(parseStopPreference({ matchId: 'm1', type: 'somethingElse', stopAtEndStep: true }).ok).toBe(false);
  });
});

describe('a stop and the step it holds', () => {
  it('COMBAT is a stop; Untap and Cleanup are not', () => {
    expect(StopPhaseSchema.safeParse('COMBAT').success).toBe(true);
    expect(StopPhaseSchema.safeParse('UNTAP').success).toBe(false);
    expect(StopPhaseSchema.safeParse('CLEANUP').success).toBe(false);
  });

  it('COMBAT holds Beginning of combat on the seat’s own turn, Declare attackers on the opponent’s', () => {
    expect(stopStep('COMBAT', true)).toBe('COMBAT_BEGIN');
    expect(stopStep('COMBAT', false)).toBe('COMBAT_DECLARE_ATTACKERS');
    expect(stopStep('COMBAT_BEGIN', false)).toBe('COMBAT_BEGIN');
    expect(stopStep('END_OF_TURN', true)).toBe('END_OF_TURN');
  });

  it('a later step of the stop’s own combat means its step went by: missed; anything else waits', () => {
    expect(stopAt('COMBAT', false, 'COMBAT_BEGIN')).toBe('wait');
    expect(stopAt('COMBAT', false, 'COMBAT_DECLARE_ATTACKERS')).toBe('hold');
    expect(stopAt('COMBAT', false, 'COMBAT_END')).toBe('missed');
    expect(stopAt('COMBAT', false, 'MAIN2')).toBe('wait');
    expect(stopAt('COMBAT', true, 'COMBAT_BEGIN')).toBe('hold');
    expect(stopAt('COMBAT_DECLARE_BLOCKERS', false, 'COMBAT_END')).toBe('wait');
  });
});

describe('ServerEnvelopeSchema — eager; parseServerEnvelope — not', () => {
  it('ServerEnvelopeSchema validates the frame inline, as the server side always relied on', () => {
    const parsed = ServerEnvelopeSchema.safeParse({ matchId: 'm1', cursor: { epoch: 'e', seq: 1 }, frame: VALID_FRAME });
    expect(parsed.success).toBe(true);
    expect(ServerEnvelopeSchema.safeParse({ matchId: 'm1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'not-a-real-method' } }).success).toBe(false);
  });

  it('parseServerEnvelope does NOT validate the frame at all — a garbage frame still parses, cursor intact', () => {
    // The whole point of the split: `ingest()` in `apps/ui/src/play/live/match.ts`
    // needs the cursor BEFORE it knows whether the frame parses, so it can resync
    // from it — it calls `safeParseServerFrame` itself, as its own second step,
    // once it already has this function's `cursor`. Folding frame validation in
    // HERE broke exactly that: a real regression this test is pinned against
    // (`match.test.ts`'s "an ask that does not parse is still aborted, and the
    // client resyncs" times out — no cursor, no resync — when this function
    // fails the whole envelope over a bad frame instead of leaving it unchecked).
    const raw = { matchId: 'm1', cursor: { epoch: 'e', seq: 7 }, frame: { kind: 'notify', method: 'not-a-real-method' } };
    const result = parseServerEnvelope(raw);
    expect(result).toEqual({ ok: true, value: { matchId: 'm1', cursor: { epoch: 'e', seq: 7 }, frame: { kind: 'notify', method: 'not-a-real-method' } } });
  });

  it('displayOnly is `true` or absent — never false, never another value', () => {
    const base = { matchId: 'm1', cursor: { epoch: 'e', seq: 1 }, frame: VALID_FRAME };
    expect(ServerEnvelopeSchema.safeParse({ ...base, displayOnly: true }).success).toBe(true);
    expect(ServerEnvelopeSchema.safeParse({ ...base, displayOnly: false }).success).toBe(false);
    expect(ServerEnvelopeSchema.safeParse({ ...base, displayOnly: 'yes' }).success).toBe(false);
    expect(parseServerEnvelope({ ...base, displayOnly: true })).toEqual({ ok: true, value: { ...base, displayOnly: true } });
  });

  it('forceNotice is `true` or absent — never false, never another value', () => {
    const base = { matchId: 'm1', cursor: { epoch: 'e', seq: 1 }, frame: VALID_FRAME };
    expect(ServerEnvelopeSchema.safeParse({ ...base, displayOnly: true, forceNotice: true }).success).toBe(true);
    expect(ServerEnvelopeSchema.safeParse({ ...base, displayOnly: true, forceNotice: false }).success).toBe(false);
    expect(ServerEnvelopeSchema.safeParse({ ...base, displayOnly: true, forceNotice: 'yes' }).success).toBe(false);
    expect(parseServerEnvelope({ ...base, displayOnly: true, forceNotice: true })).toEqual({ ok: true, value: { ...base, displayOnly: true, forceNotice: true } });
  });

  it('parseServerEnvelope accepts a good envelope and a good frame', () => {
    const result = parseServerEnvelope({ matchId: 'm1', cursor: { epoch: 'e', seq: 1 }, frame: VALID_FRAME });
    expect(result).toEqual({ ok: true, value: { matchId: 'm1', cursor: { epoch: 'e', seq: 1 }, frame: VALID_FRAME } });
  });
});

describe('MatchSnapshotSchema / MatchErrorSchema', () => {
  it('a snapshot carries seat, playerId, cursor (nullable) and frames', () => {
    expect(MatchSnapshotSchema.safeParse({ matchId: 'm1', seat: 0, playerId: 1, cursor: null, frames: [] }).success).toBe(true);
    expect(MatchSnapshotSchema.safeParse({ matchId: 'm1', seat: -1, playerId: 1, cursor: null, frames: [] }).success).toBe(false);
  });

  it('an error carries just the code by default, and the two extra fields only when both are given', () => {
    expect(MatchErrorSchema.safeParse({ error: 'not-joined' }).success).toBe(true);
    expect(MatchErrorSchema.safeParse({ error: 'unknown-match', outcome: 'match-gone', message: 'the match ended' }).success).toBe(true);
    expect(MatchErrorSchema.safeParse({ error: 'not-joined', surprise: true }).success).toBe(false);
  });
});
