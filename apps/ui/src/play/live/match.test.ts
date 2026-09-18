/*
 * The live match driver, against a REAL socket.io server replaying a REAL
 * match's frames (`./replay-server.ts`), over a real `socket.io-client`
 * connection. The board state every live case ends in is compared, whole,
 * against the fixture path's — `boardFromFixture` — because the two sources
 * must agree, not merely both look plausible.
 *
 * The sequencing cases assert COUNTS, and the one that matters most is a
 * negative: a burst of duplicates produces exactly zero resync requests, on
 * the client AND as received by the server.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parseServerFrame, type ServerFrame } from '@hadoku/forge-wire';

import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import {
  answerConfirm,
  closeMatch,
  ingest,
  MAX_RESYNCS_WITHOUT_PROGRESS,
  socketIoMatchTransport,
  startMatch,
  type LiveMatch,
  type MatchTransport,
} from './match.ts';
import { confirmAsk, fixtureFrames, startReplayServer, until, type ReplayServer } from './replay-server.ts';
import { MATCH_EVENTS, parseMatchAck, parseServerEnvelope } from './transport.ts';

const FRAMES = fixtureFrames();
const FIXTURE_VIEW = boardFromFixture(PLAY_FIXTURES[0]!);

/** A delta that changes nothing, sent to mark "everything before me has been processed". */
function sentinel(): ServerFrame {
  return parseServerFrame({
    kind: 'notify',
    method: 'applyDelta',
    payload: { packet: { seq: 27, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] } },
  });
}

/** A blocking ask this client does not render. */
function optionAsk(callId: string): ServerFrame {
  return parseServerFrame({
    kind: 'ask',
    callId,
    method: 'showOptionDialog',
    message: 'Choose a mode',
    title: 'Modes',
    icon: null,
    options: ['Deal 2 damage', 'Gain 2 life'],
    defaultOption: 0,
  });
}

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;

afterEach(async () => {
  if (match !== null) closeMatch(match);
  match = null;
  if (server !== null) await server.close();
  server = null;
});

async function connect(s: ReplayServer): Promise<LiveMatch> {
  const m = startMatch({
    matchId: s.matchId,
    transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
  });
  match = m;
  await until('the join snapshot', () => m.stats.snapshots === 1);
  return m;
}

/** Send, and wait until the client has applied it. */
async function sendAndApply(s: ReplayServer, m: LiveMatch, frames: readonly ServerFrame[]): Promise<void> {
  const target = m.stats.applied + frames.length;
  for (const f of frames) s.send(f);
  await until(`${frames.length} frame(s) applied`, () => m.stats.applied >= target);
}

async function fullGame(): Promise<{ s: ReplayServer; m: LiveMatch }> {
  const s = (server = await startReplayServer());
  const m = await connect(s);
  await sendAndApply(s, m, FRAMES);
  return { s, m };
}

describe('the transport contract', () => {
  it('a snapshot and an error both parse as the join ack', () => {
    const snapshot = { matchId: 'm', seat: 0, playerId: 0, cursor: null, frames: [FRAMES[0]] };
    expect(parseMatchAck(snapshot).ok).toBe(true);
    expect(parseMatchAck({ error: 'no such match' }).ok).toBe(true);
  });

  it('a snapshot carrying a malformed frame is refused, with the path named', () => {
    const bad = { matchId: 'm', seat: 0, playerId: 0, cursor: null, frames: [{ kind: 'notify', method: 'applyDelta' }] };
    const result = parseMatchAck(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.path)).toContain('$.frames[0].payload');
  });

  it('an envelope with a field the contract does not have is refused', () => {
    const result = parseServerEnvelope({ matchId: 'm', cursor: { epoch: 'e', seq: 1 }, frame: {}, seat: 1 });
    expect(result.ok).toBe(false);
  });

  it('a cursor must be a positive seq', () => {
    expect(parseServerEnvelope({ matchId: 'm', cursor: { epoch: 'e', seq: 0 }, frame: {} }).ok).toBe(false);
  });
});

describe('a live delta stream', () => {
  it('joins mid-game, then follows the stream to the fixture’s exact board', async () => {
    const s = (server = await startReplayServer());
    for (const f of FRAMES.slice(0, 10)) s.send(f); // before anyone joined: history only
    const m = await connect(s);

    expect(m.seat).toBe(0);
    expect(m.playerId).toBe(0);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: 10 });
    const early = m.view!;
    expect(early.players.map((p) => p.name)).toEqual(['Bob (Capturing)', 'Alice (Host AI)']);

    await sendAndApply(s, m, FRAMES.slice(10));
    expect(m.view).toEqual(FIXTURE_VIEW);
    expect(m.view!.turn).not.toBe(early.turn);
    expect(m.stats).toMatchObject({ snapshots: 1, applied: 17, resyncsRequested: 0, duplicatesDropped: 0, invalid: 0 });
    expect(s.resyncs).toBe(0);
  });

  it('a whole game streamed from an empty join ends on the fixture’s board', async () => {
    const { s, m } = await fullGame();
    expect(m.view).toEqual(FIXTURE_VIEW);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: 27 });
    expect(m.skippedDeltas).toBe(0);
    expect(s.joins).toBe(1);
  });
});

describe('sequencing: classifySeq, over the wire', () => {
  it('drops a burst of duplicates and asks for NOTHING', async () => {
    const { s, m } = await fullGame();
    for (const seq of [27, 20, 27, 1, 26, 27]) s.sendRaw(s.sent(seq));
    await sendAndApply(s, m, [sentinel()]);

    expect(m.stats.duplicatesDropped).toBe(6);
    expect(m.stats.resyncsRequested).toBe(0);
    expect(s.resyncs).toBe(0);
    expect(m.stats.gaps).toBe(0);
    expect(m.view).toEqual(FIXTURE_VIEW);
  });

  it('a gap asks for exactly one resync, and the snapshot restores the stream', async () => {
    const s = (server = await startReplayServer());
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES.slice(0, 10));

    s.lose(FRAMES[10]!); // seq 11 never arrives
    s.send(FRAMES[11]!); // seq 12: a gap
    await until('the resync snapshot', () => m.stats.snapshots === 2);

    expect(m.stats.gaps).toBe(1);
    expect(m.stats.resyncsRequested).toBe(1);
    expect(s.resyncs).toBe(1);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: 12 });

    await sendAndApply(s, m, FRAMES.slice(12));
    expect(m.view).toEqual(FIXTURE_VIEW);
    expect(m.stats.resyncsRequested).toBe(1);
  });

  it('an epoch change discards everything and refetches', async () => {
    const { s, m } = await fullGame();
    s.restart('epoch-b');
    for (const f of FRAMES) s.send(f);
    await until('the new epoch at seq 27', () => m.cursor?.epoch === 'epoch-b' && m.cursor.seq === 27);

    expect(m.stats.epochChanges).toBe(1);
    expect(m.stats.resyncsRequested).toBe(1);
    expect(s.resyncs).toBe(1);
    expect(m.view).toEqual(FIXTURE_VIEW);
  });

  it('stops resyncing when snapshots never catch up, and says so', () => {
    // A server whose snapshot cursor lags its own stream: every frame after
    // the snapshot is a gap. Stubbed, because it is the server being wrong.
    const acks: ((err: Error | null, response: unknown) => void)[] = [];
    const transport: MatchTransport = {
      on: () => {},
      emit: () => {},
      request: (_event, _payload, onAck) => acks.push(onAck),
      disconnect: () => {},
    };
    const m = startMatch({ matchId: 'm', transport });
    const lagging = { matchId: 'm', seat: 0, playerId: 0, cursor: { epoch: 'e', seq: 1 }, frames: [FRAMES[0]] };
    acks.shift()!(null, lagging);
    for (let i = 0; i < 10; i += 1) {
      ingest(m, { matchId: 'm', cursor: { epoch: 'e', seq: 3 }, frame: FRAMES[1] });
      acks.shift()?.(null, lagging);
    }
    expect(m.stats.resyncsRequested).toBe(MAX_RESYNCS_WITHOUT_PROGRESS);
    expect(m.lastError).toMatch(/stopped after 3 resyncs/);
  });
});

describe('showConfirmDialog, end to end', () => {
  it('the ask arrives, and the answer — the opposite of the default — reaches the server', async () => {
    const { s, m } = await fullGame();
    s.send(confirmAsk('c-1', true));
    await until('the ask', () => m.pendingAsk !== null);
    expect(m.pendingAsk).toMatchObject({ callId: 'c-1', title: 'Mulligan', defaultYes: true });

    expect(answerConfirm(m, 'c-1', false)).toBe(true);
    await until('the reply at the server', () => s.clientFrames().length === 1);
    const [reply] = s.clientFrames();
    expect(reply).toEqual({
      ok: true,
      value: { kind: 'reply', callId: 'c-1', method: 'showConfirmDialog', result: false },
    });
    expect(s.received.at(-1)?.payload).toMatchObject({ matchId: s.matchId });
    expect(m.pendingAsk).toBeNull();
  });

  it('one ask gets one answer: a second click sends nothing', async () => {
    const { s, m } = await fullGame();
    s.send(confirmAsk('c-2', false));
    await until('the ask', () => m.pendingAsk !== null);
    expect(answerConfirm(m, 'c-2', true)).toBe(true);
    expect(answerConfirm(m, 'c-2', false)).toBe(false);
    expect(answerConfirm(m, 'c-other', true)).toBe(false);
    await sendAndApply(s, m, [sentinel()]);
    expect(s.clientFrames()).toHaveLength(1);
    expect(m.stats.replies).toBe(1);
  });

  it('a pending ask survives a resync: the server re-sends it after the snapshot', async () => {
    const s = (server = await startReplayServer());
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES.slice(0, 5));
    s.send(confirmAsk('c-3'));
    await until('the ask', () => m.pendingAsk?.callId === 'c-3');

    s.lose(FRAMES[5]!);
    s.send(FRAMES[6]!);
    await until('the resync, and the ask again', () => m.stats.snapshots === 2 && m.pendingAsk?.callId === 'c-3');
    expect(m.stats.resyncsRequested).toBe(1);

    expect(answerConfirm(m, 'c-3', true)).toBe(true);
    await until('the reply', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { callId: 'c-3', result: true } });
  });
});

describe('every other ask is aborted, never left waiting', () => {
  it('an ask this client does not render is answered with an unsupported abort', async () => {
    const { s, m } = await fullGame();
    s.send(optionAsk('c-9'));
    await until('the abort at the server', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({
      ok: true,
      value: { kind: 'abort', callId: 'c-9', reason: 'unsupported' },
    });
    expect(m.pendingAsk).toBeNull();
    expect(m.stats.aborts).toBe(1);
  });

  it('an ask that does not parse is still aborted, and the client resyncs', async () => {
    const { s, m } = await fullGame();
    s.sendRaw({
      matchId: s.matchId,
      cursor: { epoch: 'epoch-a', seq: 28 },
      frame: { kind: 'ask', callId: 'c-bad', method: 'showConfirmDialog', message: 'no buttons' },
    });
    await until('the resync', () => m.stats.snapshots === 2);
    expect(m.stats.invalid).toBe(1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'abort', callId: 'c-bad', reason: 'unsupported' } });
    expect(m.view).toEqual(FIXTURE_VIEW);
  });

  it('closing the board with a question open cancels it', async () => {
    const { s, m } = await fullGame();
    s.send(confirmAsk('c-4'));
    await until('the ask', () => m.pendingAsk !== null);
    closeMatch(m);
    match = null;
    await until('the abort at the server', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'abort', callId: 'c-4', reason: 'cancelled' } });
  });
});

describe('what the client refuses', () => {
  it('a refused join is surfaced, not retried', async () => {
    const s = (server = await startReplayServer());
    s.refuseWith = 'no such match';
    const m = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    });
    match = m;
    await until('the refusal', () => m.lastError !== null);
    expect(m.lastError).toBe(`${MATCH_EVENTS.join} was refused: no such match`);
    expect(m.view).toBeNull();
    expect(s.joins).toBe(1);
  });

  it('a frame for another match is refused and does not move the cursor', async () => {
    const { s, m } = await fullGame();
    s.sendRaw({ ...s.sent(27), matchId: 'someone-else', cursor: { epoch: 'epoch-a', seq: 28 } });
    await sendAndApply(s, m, [sentinel()]);
    expect(m.stats.invalid).toBe(1);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: 28 });
    expect(m.stats.resyncsRequested).toBe(0);
  });
});

describe('the viewer comes from the snapshot', () => {
  it('a playerId that names no seat hides EVERY hand rather than showing one', async () => {
    const s = (server = await startReplayServer({ playerId: 99 }));
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES);
    expect(m.view!.players.map((p) => [p.id, p.isViewer, p.hand, p.handCount])).toEqual([
      [0, false, null, 5],
      [1, false, null, 2],
    ]);
  });
});
