/*
 * TEST SUPPORT — a real socket.io server that speaks `./transport.ts`'s
 * contract and replays REAL captured frames. Never imported by the app.
 *
 * Lane A is writing the actual match server in parallel, so the client's
 * "live" tests run against this instead: a real server on an ephemeral
 * loopback port, real `socket.io-client` connections, real bytes, and the
 * committed Tier C capture (`../fixtures/tierc-game1-seq1-27.json`) as the
 * state stream. Only Forge is missing — the frames it would have produced are
 * the frames it DID produce, in a real match.
 *
 * ## How it keeps the contract
 *
 * - The cursor is per recipient: `seq` starts at 1 and rises by exactly 1 per
 *   `forge:s2c` frame, whatever the frame is. `epoch` is minted per "process
 *   start" (`restart()`).
 * - A snapshot's `frames` is the state-channel history (Tier C frames);
 *   its `cursor` is the cursor of the LAST `forge:s2c` frame sent, whatever
 *   kind it was. That second half is this lane's reading of the contract, and
 *   the report explains why: if it were the last STATE frame's cursor, a
 *   pending ask re-sent after the snapshot would always arrive as a gap.
 * - Every open ask is re-sent after the snapshot as an ordinary frame. Asks
 *   are held by `callId`, as the real server holds them
 *   (`apps/server/src/play/match.ts`), so two can be open at once.
 *
 * ## Why `socket.io` is loaded through `createRequire`
 *
 * `socket.io` (the server) is a dependency of `@hadoku/server`, not of
 * `@hadoku/ui`, and this lane does not edit manifests. So it is resolved from
 * the server package's own directory — the same copy lane A's server uses —
 * and typed here by the few members these tests touch.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTierC, parseServerFrame, safeParseClientFrame, type ServerFrame } from '@hadoku/forge-wire';

import game1 from '../fixtures/tierc-game1-seq1-27.json';
import { MATCH_EVENTS, type MatchSnapshot, type ServerEnvelope, type WireCursor } from './transport.ts';

interface IoSocket {
  id: string;
  on(event: string, handler: (payload: unknown, ack?: (response: unknown) => void) => void): void;
  emit(event: string, payload: unknown): void;
}

interface IoServer {
  on(event: 'connection', handler: (socket: IoSocket) => void): void;
  close(): void;
}

const serverRequire = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../server/package.json'),
);
const { Server } = serverRequire('socket.io') as { Server: new (http: HttpServer) => IoServer };

/**
 * The committed capture as `applyDelta` frames — exactly as captured, minus the
 * fixture's own `_truncatedTo` annotation, which is not wire data (the same
 * treatment `packages/forge-wire/src/tier-c.fixture.test.ts` gives it).
 */
export function fixtureFrames(): ServerFrame[] {
  return (game1 as Record<string, unknown>[]).map((packet, i) => {
    const { _truncatedTo: _, ...wire } = packet;
    return parseServerFrame({ kind: 'notify', method: 'applyDelta', payload: { packet: wire } }, `fixture packet ${i}`);
  });
}

/** A real `showConfirmDialog` ask — the shape Wave 6 round-tripped. */
export function confirmAsk(callId: string, defaultYes = true): ServerFrame {
  return parseServerFrame({
    kind: 'ask',
    callId,
    method: 'showConfirmDialog',
    message: 'Keep this hand of seven?',
    title: 'Mulligan',
    yesButtonText: 'Keep',
    noButtonText: 'Mulligan',
    defaultYes,
  });
}

export interface Received {
  event: string;
  payload: unknown;
}

export interface ReplayServer {
  url: string;
  matchId: string;
  epoch: string;
  /** Everything any client sent, in arrival order. */
  received: Received[];
  /** `received`, `forge:c2s` only, each frame parsed by forge-wire. */
  clientFrames(): ReturnType<typeof safeParseClientFrame>[];
  joins: number;
  resyncs: number;
  /** Send one frame to every joined client, stamped with the next cursor. */
  send(frame: ServerFrame): WireCursor;
  /** As `send`, but the frame is "lost": the cursor advances, nothing is delivered. */
  lose(frame: ServerFrame): WireCursor;
  /** Deliver an arbitrary payload on `forge:s2c` — a replay, junk, anything. */
  sendRaw(payload: unknown): void;
  /** The envelope `send` produced for a given seq, for replaying it. */
  sent(seq: number): ServerEnvelope;
  /** A new process: new epoch, cursor from 0, no history, no open asks. */
  restart(epoch: string): void;
  /** Answer joins/resyncs with `{ error }` instead of a snapshot. */
  refuseWith: string | null;
  close(): Promise<void>;
}

export async function startReplayServer(options: { matchId?: string; playerId?: number } = {}): Promise<ReplayServer> {
  const matchId = options.matchId ?? 'match-replay-1';
  const playerId = options.playerId ?? 0;
  const http = createServer();
  const io = new Server(http);
  const joined = new Set<IoSocket>();

  let seq = 0;
  let history: ServerFrame[] = [];
  const openAsks = new Map<string, ServerFrame>();
  const sentLog = new Map<string, ServerEnvelope>();

  const server: ReplayServer = {
    url: '',
    matchId,
    epoch: 'epoch-a',
    received: [],
    joins: 0,
    resyncs: 0,
    refuseWith: null,
    clientFrames: () =>
      server.received
        .filter((r) => r.event === MATCH_EVENTS.clientToServer)
        .map((r) => safeParseClientFrame((r.payload as { frame?: unknown }).frame)),
    send: (frame) => stamp(frame, true),
    lose: (frame) => stamp(frame, false),
    sendRaw: (payload) => {
      for (const socket of joined) socket.emit(MATCH_EVENTS.serverToClient, payload);
    },
    sent: (n) => {
      const envelope = sentLog.get(`${server.epoch}:${n}`);
      if (envelope === undefined) throw new Error(`nothing was sent at seq ${n} in ${server.epoch}`);
      return envelope;
    },
    restart: (epoch) => {
      server.epoch = epoch;
      seq = 0;
      history = [];
      openAsks.clear();
    },
    close: () =>
      new Promise<void>((done) => {
        io.close();
        http.close(() => done());
      }),
  };

  function stamp(frame: ServerFrame, deliver: boolean): WireCursor {
    seq += 1;
    const cursor = { epoch: server.epoch, seq };
    const envelope: ServerEnvelope = { matchId, cursor, frame };
    sentLog.set(`${server.epoch}:${seq}`, envelope);
    if (isTierC(frame.method)) history.push(frame);
    if (frame.kind === 'ask') openAsks.set(frame.callId, frame);
    if (deliver) server.sendRaw(envelope);
    return cursor;
  }

  function snapshot(): MatchSnapshot {
    return {
      matchId,
      seat: 0,
      playerId,
      cursor: seq === 0 ? null : { epoch: server.epoch, seq },
      frames: [...history],
    };
  }

  io.on('connection', (socket) => {
    const answer = (event: string) => (payload: unknown, ack?: (response: unknown) => void) => {
      server.received.push({ event, payload });
      if (event === MATCH_EVENTS.join) server.joins += 1;
      else server.resyncs += 1;
      if (server.refuseWith !== null) {
        ack?.({ error: server.refuseWith });
        return;
      }
      joined.add(socket);
      ack?.(snapshot());
      // The contract: every open ask is re-sent after the snapshot, as a frame.
      for (const ask of [...openAsks.values()]) stamp(ask, true);
    };
    socket.on(MATCH_EVENTS.join, answer(MATCH_EVENTS.join));
    socket.on(MATCH_EVENTS.resync, answer(MATCH_EVENTS.resync));
    socket.on(MATCH_EVENTS.clientToServer, (payload) => {
      server.received.push({ event: MATCH_EVENTS.clientToServer, payload });
      const parsed = safeParseClientFrame((payload as { frame?: unknown }).frame);
      if (!parsed.ok || (parsed.value.kind !== 'reply' && parsed.value.kind !== 'abort')) return;
      openAsks.delete(parsed.value.callId);
    });
  });

  await new Promise<void>((ready) => http.listen(0, '127.0.0.1', ready));
  server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return server;
}

/** Poll until `check` holds, or fail naming what was being waited for. */
export async function until(what: string, check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
