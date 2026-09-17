/*
 * Tier C — the state channel, and the tests that keep it honest.
 *
 * This file's job is unusual: it asserts that three schemas DO NOT WORK. Tier C
 * is unexercised (Wave 6 lane F), Wave 7 lane A is running the experiment that
 * settles it, and the failure mode this package is guarding against is a future
 * session finding a `z.unknown()` here, reading it as "done", and building a
 * browser on top of a shape nobody has ever seen cross a socket.
 *
 * So: the three methods are present in the envelope (a Tier C frame is
 * recognised, not "unknown method"), nothing parses as one, and the refusal
 * names the document that will contain the answer.
 *
 * When lane A lands, THIS FILE is what has to change first — and it will fail
 * loudly rather than let a real schema slip in beside a stale refusal.
 */

import { describe, expect, it } from 'vitest';

import {
  ApplyDeltaSchema,
  OpenViewSchema,
  SetGameViewSchema,
  TIER_C_METHODS,
  TIER_C_REPLIES,
  TIER_C_SPIKE,
  TIER_C_UNRESOLVED,
  tierCRefusal,
  type TierCMethod,
} from './tier-c.ts';
import {
  BLOCKING_METHODS,
  REPLY_SCHEMAS,
  REQUIRED_METHODS,
  isTierC,
  safeParseServerFrame,
  unresolvedReason,
} from './envelope.ts';
import { SERVER_FRAME_EXAMPLES } from './examples.ts';

const SCHEMAS = {
  setGameView: SetGameViewSchema,
  openView: OpenViewSchema,
  applyDelta: ApplyDeltaSchema,
} as const;

/**
 * Inputs a future session would plausibly reach for, including a delta packet
 * shaped the way `DeltaPacket.java:28-29` describes. Every one must be refused:
 * the shape being plausible is exactly what makes accepting it dangerous.
 */
function plausiblePayloads(method: TierCMethod): unknown[] {
  return [
    undefined,
    null,
    {},
    { anything: true },
    // The id-keyed property diff DeltaPacket actually carries.
    {
      objectDeltas: { '7': { Name: 'Lightning Bolt', Zone: 'Battlefield' } },
      newObjects: { '8': { Name: 'Mountain' } },
    },
    // A GameView-ish baseline with a sequence number, for setGameView.
    { gameView: { turn: 3, players: [] }, sequenceNumber: 42 },
    // A TrackableCollection<PlayerView>-ish list, for openView.
    [{ kind: 'player', id: 1 }],
    `a ${method} payload`,
  ];
}

describe('Tier C — present, named, and refusing', () => {
  it('is exactly three methods, all of them in the required 38', () => {
    expect(TIER_C_METHODS).toEqual(['setGameView', 'openView', 'applyDelta']);
    for (const method of TIER_C_METHODS) {
      expect(REQUIRED_METHODS).toContain(method);
    }
  });

  it('declares itself unresolved rather than leaving a consumer to guess', () => {
    expect(TIER_C_UNRESOLVED).toBe(true);
    expect(TIER_C_SPIKE).toBe('docs/spikes/tier-c.md');
  });

  it.each(TIER_C_METHODS)('%s refuses every plausible payload', (method) => {
    const schema = SCHEMAS[method];
    for (const payload of plausiblePayloads(method)) {
      expect([payload, schema.safeParse({ kind: 'unresolved', method, payload }).success]).toEqual([
        payload,
        false,
      ]);
    }
  });

  it.each(TIER_C_METHODS)('%s refuses even a well-formed-looking frame', (method) => {
    expect(safeParseServerFrame({ kind: 'notify', method }).ok).toBe(false);
    expect(safeParseServerFrame({ kind: 'unresolved', method, payload: {} }).ok).toBe(false);
  });

  it('refuses a frame with no payload key at all — an omitted field is not a pass', () => {
    // `z.never()` would be trivially satisfiable if a missing key skipped it,
    // which is how an "unresolved" arm quietly becomes an accepting one.
    for (const method of TIER_C_METHODS) {
      expect(SCHEMAS[method].safeParse({ kind: 'unresolved', method }).success).toBe(false);
    }
  });

  it('the refusal names the spike, the lane and the method', () => {
    for (const method of TIER_C_METHODS) {
      const reason = tierCRefusal(method);
      expect(reason).toContain(method);
      expect(reason).toContain('docs/spikes/tier-c.md');
      expect(reason).toContain('lane A');
      expect(reason).toContain('UNRESOLVED');
    }
  });

  it('a parse failure surfaces the refusal, not a bare type error', () => {
    const result = safeParseServerFrame({
      kind: 'unresolved',
      method: 'applyDelta',
      payload: { objectDeltas: {}, newObjects: {} },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.message).join('\n')).toContain('docs/spikes/tier-c.md');
  });

  it('unresolvedReason answers for Tier C and only for Tier C', () => {
    for (const method of REQUIRED_METHODS) {
      const expected = TIER_C_METHODS.includes(method as TierCMethod);
      expect([method, unresolvedReason(method) !== null]).toEqual([method, expected]);
      expect([method, isTierC(method)]).toEqual([method, expected]);
    }
  });

  it('has no reply schemas, because none of the three blocks', () => {
    expect(Object.keys(TIER_C_REPLIES)).toEqual([]);
    for (const method of TIER_C_METHODS) {
      expect(BLOCKING_METHODS).not.toContain(method);
      expect(Object.keys(REPLY_SCHEMAS)).not.toContain(method);
    }
  });

  it('has no example frame — there is nothing valid to be an example of', () => {
    for (const method of TIER_C_METHODS) {
      expect(Object.keys(SERVER_FRAME_EXAMPLES)).not.toContain(method);
    }
  });
});
