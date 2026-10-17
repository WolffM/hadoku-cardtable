/*
 * The jar-free half of `jvm-harness.ts`: what an ask's record says after its
 * replies. The jar half is proven by every `*.jvm.test.ts` that reads
 * `LiveHarness.asks`.
 */

import { describe, expect, it } from 'vitest';
import type { ClientFrame } from '@hadoku/forge-wire';

import { recordReply, type AskRecord } from './jvm-harness.ts';
import { confirmAsk } from './replay-server.ts';

function openRecord(callId: string): AskRecord {
  return { seat: 0, callId, method: 'showConfirmDialog', ask: confirmAsk(callId), answer: null, outcome: null, framesAfter: 0, stateWhileOpen: 0 };
}

const reply = (callId: string, result: boolean): Extract<ClientFrame, { kind: 'reply' }> => ({ kind: 'reply', callId, method: 'showConfirmDialog', result });

describe('recordReply: an ask records the reply Forge took', () => {
  it('records the first reply and its outcome', () => {
    const asks = [openRecord('s0-1')];
    recordReply(asks, reply('s0-1', true), { ok: true });
    expect(asks[0]).toMatchObject({ answer: reply('s0-1', true), outcome: { ok: true } });
  });

  it('a later refused reply never overwrites the accepted one', () => {
    const asks = [openRecord('s0-1')];
    recordReply(asks, reply('s0-1', true), { ok: true });
    recordReply(asks, reply('s0-1', true), { ok: false, error: 'stale-reply' });
    expect(asks[0]).toMatchObject({ answer: reply('s0-1', true), outcome: { ok: true } });
  });

  it('a refused reply is replaced by the accepted one that follows it', () => {
    const asks = [openRecord('s0-1')];
    recordReply(asks, reply('s0-1', false), { ok: false, error: 'reply is for something else' });
    recordReply(asks, reply('s0-1', true), { ok: true });
    expect(asks[0]).toMatchObject({ answer: reply('s0-1', true), outcome: { ok: true } });
  });

  it('a reply to an ask the harness never saw records nothing', () => {
    const asks = [openRecord('s0-1')];
    recordReply(asks, reply('s0-9', true), { ok: true });
    expect(asks[0]).toMatchObject({ answer: null, outcome: null });
  });
});
