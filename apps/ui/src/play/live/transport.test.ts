/*
 * Wave 64 §S (S1/S8): the match transport schemas live ONCE, in
 * `packages/shared/src/match-wire.ts`. Both apps' own `transport.ts` import
 * and re-export the shared instances — never a second copy of their own.
 *
 * The test below is the mutation target S8's own "Done when" names: if either
 * `transport.ts` ever re-defines one of these ten names as its own schema
 * (even one that is STRUCTURALLY identical — the exact drift this wave
 * found), this file fails, because it asserts REFERENCE equality, not deep
 * equality. A second copy parses the same inputs the same way right up until
 * the day someone edits one copy and not the other; reference equality is the
 * only check that cannot be fooled by "they still look the same".
 */

import { describe, expect, it } from 'vitest';

import * as shared from '@hadoku/shared';
import * as uiTransport from './transport.ts';
// Cross-package relative import, the same device `prompts.jvm.test.ts` and
// `combat-drag.jvm.test.ts` already use to reach `apps/server/src/play/auto.ts`.
import * as serverTransport from '../../../../server/src/play/transport.ts';

/** The ten names both `transport.ts` files used to define a second copy of. */
const SHARED_NAMES = [
  'MATCH_EVENTS',
  'MatchRequestSchema',
  'ClientEnvelopeSchema',
  'FullControlSchema',
  'fullControlFrame',
  'AutoYieldSchema',
  'StopPreferenceSchema',
  'TriggerDecisionRequestSchema',
  'TriggerDecisionsSchema',
  'ServerEnvelopeSchema',
  'MatchSnapshotSchema',
  'MatchErrorSchema',
] as const;

describe('the match transport schemas live once', () => {
  it('both apps re-export the EXACT instance from @hadoku/shared — never a schema of their own', () => {
    for (const name of SHARED_NAMES) {
      const sharedValue = (shared as unknown as Record<string, unknown>)[name];
      expect(sharedValue, `@hadoku/shared must export ${name}`).toBeDefined();
      expect((serverTransport as unknown as Record<string, unknown>)[name], `apps/server/.../transport.ts's ${name}`).toBe(sharedValue);
      expect((uiTransport as unknown as Record<string, unknown>)[name], `apps/ui/.../transport.ts's ${name}`).toBe(sharedValue);
    }
  });

  it('parseClientEnvelope is the same function on both sides too, not just the schemas it is built from', () => {
    expect(serverTransport.parseClientEnvelope).toBe(shared.parseClientEnvelope);
    expect(uiTransport.parseClientEnvelope).toBe(shared.parseClientEnvelope);
  });

  it('fullControlEcho is gone — fullControlFrame is the one name now (S1)', () => {
    expect('fullControlEcho' in serverTransport).toBe(false);
    expect('fullControlEcho' in uiTransport).toBe(false);
  });

  it('what is NOT shared stays exactly one place each: the server never parses forge:seats/forge:role', () => {
    // SeatIdentitySchema/MatchSeatsSchema/MatchRoleSchema/MatchAckSchema have
    // no server-side mirror to collide with — the server only builds and
    // sends their payloads (`Match.seatIdentities()`), it never parses them.
    expect('SeatIdentitySchema' in serverTransport).toBe(false);
    expect('MatchSeatsSchema' in serverTransport).toBe(false);
    expect('MatchRoleSchema' in serverTransport).toBe(false);
    expect(uiTransport.SeatIdentitySchema).toBeDefined();
    expect(uiTransport.MatchSeatsSchema).toBeDefined();
    expect(uiTransport.MatchRoleSchema).toBeDefined();
  });

  it('MATCH_EVENTS carries forge:seats and forge:role on both sides — only the payload schema stayed local', () => {
    expect(serverTransport.MATCH_EVENTS.seats).toBe('forge:seats');
    expect(serverTransport.MATCH_EVENTS.role).toBe('forge:role');
    expect(uiTransport.MATCH_EVENTS.seats).toBe('forge:seats');
    expect(uiTransport.MATCH_EVENTS.role).toBe('forge:role');
  });
});
