/*
 * The jar-free half of `jvm-harness.ts`: what an ask's record says after its
 * replies, and what `expectNoDesync` says about a server that keeps talking.
 * The jar half is proven by every `*.jvm.test.ts` that reads
 * `LiveHarness.asks`, and by `prompts.jvm.test.ts`'s rows.
 */

import { describe, expect, it } from 'vitest';
import { isTierC, type ClientFrame, type ServerFrame } from '@hadoku/forge-wire';

import { expectNoDesync, recordReply, waitUntil, type AskRecord, type DesyncSource } from './jvm-harness.ts';
import { closeMatch, startMatch } from './match.ts';
import { confirmAsk, fixtureFrames } from './replay-server.ts';
import { MATCH_EVENTS, type MatchSnapshot, type ServerEnvelope } from './transport.ts';

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

/**
 * One seat of a server that sends a frame whenever it is told to, keeps the
 * history and cursor `Match.snapshot` keeps (the latest cursor of any kind,
 * Tier C frames as history), records every envelope the way the harness's
 * `emitted` does, and delivers each one a macrotask later, as the harness does.
 */
function talkingServer() {
  const matchId = 'm-desync';
  const epoch = 'e-1';
  let seq = 0;
  const history: ServerFrame[] = [];
  const emitted: { seat: number; envelope: ServerEnvelope }[] = [];
  let deliver: ((payload: unknown) => void) | undefined;
  /** Called at the top of every snapshot read; what a frame "crossing" the read looks like. */
  let onRead: () => void = () => {};
  const send = (frame: ServerFrame): void => {
    if (isTierC(frame.method)) history.push(frame);
    seq += 1;
    const envelope: ServerEnvelope = { matchId, cursor: { epoch, seq }, frame };
    emitted.push({ seat: 0, envelope });
    const to = deliver;
    if (to !== undefined) setTimeout(() => to(envelope), 0);
  };
  const snapshot = (seat: number): MatchSnapshot | { error: string } => {
    onRead();
    return { matchId, seat, playerId: 0, cursor: seq === 0 ? null : { epoch, seq }, frames: [...history] };
  };
  const live = startMatch({
    matchId,
    transport: {
      on: (event, handler) => {
        if (event === MATCH_EVENTS.serverToClient) deliver = handler as (payload: unknown) => void;
        if (event === 'connect') setTimeout(() => handler(undefined), 0);
      },
      emit: () => {},
      request: (_e, _p, onAck) => setTimeout(() => onAck(null, snapshot(0)), 0),
      disconnect: () => {
        deliver = undefined;
      },
    },
  });
  const source: DesyncSource & { emitted: typeof emitted } = { match: { id: matchId, snapshot }, seats: [{ seat: 0, live }], emitted };
  return {
    source,
    live,
    send,
    seq: () => seq,
    setOnRead: (fn: () => void) => {
      onRead = fn;
    },
  };
}

/** A seat level with a server that has sent it ten fixture frames; `reads` counts the server's snapshot reads from here on. */
async function levelAfterTen(frames: readonly ServerFrame[]) {
  const server = talkingServer();
  for (const f of frames.slice(0, 10)) server.send(f);
  await waitUntil(() => server.live.view !== null && server.live.cursor?.seq === 10, "the seat at the server's cursor", 3000);
  return server;
}

describe('expectNoDesync: a server that keeps talking is not a desync', () => {
  // The server's last auto-pass can land at any point of the check — before
  // the seat has caught up, between two of its reads, or after the fresh
  // fold's snapshot. Each is a frame the seat is simply about to fold. So a
  // frame is sent just before each snapshot read the check makes, one run per
  // read, however many reads that is.
  it('one more frame, sent just before any one of the check\'s snapshot reads', async () => {
    const frames = fixtureFrames();
    const quiet = await levelAfterTen(frames);
    let reads = 0;
    quiet.setOnRead(() => (reads += 1));
    await expectNoDesync(quiet.source);
    closeMatch(quiet.live);
    expect(reads, 'the check reads the server').toBeGreaterThan(0);

    for (let n = 1; n <= reads; n++) {
      const server = await levelAfterTen(frames);
      try {
        let read = 0;
        server.setOnRead(() => {
          read += 1;
          if (read === n) server.send(frames[10]!);
        });
        await expectNoDesync(server.source);
        // Not vacuous: the frame was sent, and the seat folded it.
        expect(server.seq(), `read #${n} of ${reads} sent the frame`).toBe(11);
        await waitUntil(() => server.live.cursor?.seq === 11, 'the seat to fold the extra frame', 3000);
      } finally {
        closeMatch(server.live);
      }
    }
  });
});
