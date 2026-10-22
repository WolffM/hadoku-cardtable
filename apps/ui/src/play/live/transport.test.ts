/*
 * The match transport schemas live once, in `packages/shared/src/match-wire.ts`.
 * The server imports them from there; the UI's `transport.ts` re-exports the
 * shared instances and never a copy of its own. This asserts REFERENCE
 * equality, not deep equality: a second copy parses the same inputs the same
 * way right up until the day someone edits one copy and not the other.
 */

import { describe, expect, it } from 'vitest';

import * as shared from '@hadoku/shared';
import * as uiTransport from './transport.ts';

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
  it('the UI re-exports the EXACT instance from @hadoku/shared — never a schema of its own', () => {
    for (const name of SHARED_NAMES) {
      const sharedValue = (shared as unknown as Record<string, unknown>)[name];
      expect(sharedValue, `@hadoku/shared must export ${name}`).toBeDefined();
      expect((uiTransport as unknown as Record<string, unknown>)[name], `apps/ui/.../transport.ts's ${name}`).toBe(sharedValue);
    }
  });

  it('parseClientEnvelope is the shared function too, not just the schemas it is built from', () => {
    expect(uiTransport.parseClientEnvelope).toBe(shared.parseClientEnvelope);
  });

  it('fullControlEcho is gone — fullControlFrame is the one name now (S1)', () => {
    expect('fullControlEcho' in uiTransport).toBe(false);
  });

  it('what is NOT shared stays exactly one place each: the server never parses forge:seats/forge:role', () => {
    // SeatIdentitySchema/MatchSeatsSchema/MatchRoleSchema/MatchAckSchema have
    // no server-side mirror to collide with — the server only builds and
    // sends their payloads (`Match.seatIdentities()`), it never parses them.
    expect(uiTransport.SeatIdentitySchema).toBeDefined();
    expect(uiTransport.MatchSeatsSchema).toBeDefined();
    expect(uiTransport.MatchRoleSchema).toBeDefined();
  });

  it('MATCH_EVENTS carries forge:seats and forge:role — only the payload schema stayed local', () => {
    expect(uiTransport.MATCH_EVENTS.seats).toBe('forge:seats');
    expect(uiTransport.MATCH_EVENTS.role).toBe('forge:role');
  });
});
