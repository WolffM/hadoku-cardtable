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

import { CLIENT_EVENT } from '@hadoku/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig } from '@testing-library/react';
import { onTestFailed } from 'vitest';

import { isTierC, parseServerFrame, safeParseClientFrame, type ServerFrame } from '@hadoku/forge-wire';

import game1 from '../fixtures/tierc-game1-seq1-27.json';
import { subscribe, type LiveMatch } from './match.ts';
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

/** The event `caughtUp` sends its marker on. */
const CAUGHT_UP = 'replay:caught-up';

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
  /**
   * Resolves on the arrival of the `n`th `forge:c2s` frame, and rejects at once
   * if more than `n` have already arrived. It has no deadline of its own: the
   * test's timeout is the bound. A `waitFor` polling `clientFrames()` gave the
   * client-to-server hop RTL's one second, and a loaded host outlasted that
   * with the frame already sent.
   */
  untilClientFrames(n: number): Promise<void>;
  /**
   * Resolves once everything `match` has sent so far has arrived: a marker sent
   * behind it on the same socket, which delivers in order. For a test that
   * reads `received` once the client has done its sending.
   */
  caughtUp(match: LiveMatch): Promise<void>;
  /**
   * `clientFrames()` once {@link caughtUp}: everything `match` has sent so far,
   * arrived. The read for a claim about what the client sent — or did not —
   * right after it acted: the hop to this server is a socket, and a loaded host
   * holds a frame on it while the client has long since sent it.
   */
  framesFrom(match: LiveMatch): Promise<ReturnType<typeof safeParseClientFrame>[]>;
  joins: number;
  resyncs: number;
  /** Send one frame to every joined client, stamped with the next cursor. */
  send(frame: ServerFrame): WireCursor;
  /** As `send`, but the frame is "lost": the cursor advances, nothing is delivered. */
  lose(frame: ServerFrame): WireCursor;
  /** Deliver an arbitrary payload on `forge:s2c` — a replay, junk, anything. */
  sendRaw(payload: unknown): void;
  /**
   * Deliver `{ matchId, seats }` on `forge:seats` — item 4, wave 29 §B's own
   * event (`match.ts`'s `adoptSeats`). `seats` is `unknown`, like `sendRaw`'s
   * payload: a test that wants a malformed shape should be able to send one.
   */
  sendSeats(seats: unknown): void;
  /**
   * Deliver `{ matchId, role }` on `forge:role` (wave 31 §S). Also what every
   * join and resync answers with, as the real server does: `role`, below.
   */
  sendRole(role: unknown): void;
  /** Deliver `{ matchId, decisions }` on `forge:trigger-decisions`, as the real server does after a change. */
  sendTriggerDecisions(decisions: unknown): void;
  /** Deliver `{ matchId, phase }` on `forge:phase-stop`, as the real server does after a join and a change. */
  sendPhaseStop(phase: unknown): void;
  /** The role every join and resync is answered with. `'player'` unless a test says otherwise. */
  role: 'player' | 'spectator' | 'watcher';
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
  // Every TCP connection, so `close` can end them without the client's say-so.
  const connections = new Set<Socket>();
  http.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  const io = new Server(http);
  const joined = new Set<IoSocket>();

  let seq = 0;
  let history: ServerFrame[] = [];
  const openAsks = new Map<string, ServerFrame>();
  const sentLog = new Map<string, ServerEnvelope>();
  // `untilClientFrames` waiters, each told of every `forge:c2s` arrival.
  const onClientFrame = new Set<() => void>();
  // `caughtUp` markers in flight, by id.
  const markers = new Map<number, () => void>();
  let lastMarker = 0;
  // The open input, kept the way `Match` keeps it per seat (wave 31 §S, P10):
  // a reload's snapshot starts from nothing and the server re-sends these.
  const input: { selection: ServerFrame | null; highlighted: Map<string, unknown>; weakly: ServerFrame | null } = {
    selection: null,
    highlighted: new Map(),
    weakly: null,
  };

  const server: ReplayServer = {
    url: '',
    matchId,
    epoch: 'epoch-a',
    received: [],
    joins: 0,
    resyncs: 0,
    refuseWith: null,
    role: 'player',
    clientFrames: () =>
      server.received
        .filter((r) => r.event === MATCH_EVENTS.clientToServer)
        .map((r) => safeParseClientFrame((r.payload as { frame?: unknown }).frame)),
    untilClientFrames: (n) =>
      new Promise<void>((resolve, reject) => {
        const check = (): void => {
          const count = server.clientFrames().length;
          if (count < n) return;
          onClientFrame.delete(check);
          if (count === n) resolve();
          else reject(new Error(`expected ${String(n)} client frames, ${String(count)} arrived: ${JSON.stringify(server.clientFrames())}`));
        };
        onClientFrame.add(check);
        check();
      }),
    caughtUp: (match) =>
      new Promise<void>((resolve) => {
        const id = (lastMarker += 1);
        markers.set(id, resolve);
        match.transport.emit(CAUGHT_UP, id);
      }),
    framesFrom: async (match) => {
      await server.caughtUp(match);
      return server.clientFrames();
    },
    send: (frame) => stamp(frame, true),
    lose: (frame) => stamp(frame, false),
    sendRaw: (payload) => {
      for (const socket of joined) socket.emit(MATCH_EVENTS.serverToClient, payload);
    },
    sendSeats: (seats) => {
      for (const socket of joined) socket.emit(MATCH_EVENTS.seats, { matchId, seats });
    },
    sendTriggerDecisions: (decisions) => {
      for (const socket of joined) socket.emit(MATCH_EVENTS.triggerDecisions, { matchId, decisions });
    },
    sendPhaseStop: (phase) => {
      for (const socket of joined) socket.emit(MATCH_EVENTS.phaseStop, { matchId, phase });
    },
    sendRole: (role) => {
      for (const socket of joined) socket.emit(MATCH_EVENTS.role, { matchId, role });
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
      input.selection = null;
      input.highlighted.clear();
      input.weakly = null;
    },
    // `http.close` only calls back once every connection has ended, and a
    // websocket's end waits on its peer (ws gives a silent one 30 s). This
    // close was the only await in gestures.test's afterEach when that hook
    // timed out at 30 s on 8620c5f (2026-10-12). Destroying the connections
    // makes the close the server's alone.
    close: () =>
      new Promise<void>((done) => {
        http.close(() => done());
        io.close();
        for (const socket of connections) socket.destroy();
      }),
  };

  function stamp(frame: ServerFrame, deliver: boolean): WireCursor {
    seq += 1;
    const cursor = { epoch: server.epoch, seq };
    const envelope: ServerEnvelope = { matchId, cursor, frame };
    sentLog.set(`${server.epoch}:${seq}`, envelope);
    if (isTierC(frame.method)) history.push(frame);
    if (frame.kind === 'ask') openAsks.set(frame.callId, frame);
    if (frame.method === 'setSelectables') input.selection = frame;
    else if (frame.method === 'clearSelectables') {
      input.selection = null;
      input.highlighted.clear();
    } else if (frame.method === 'setHighlighted') {
      for (const e of frame.entities) {
        if (frame.on) input.highlighted.set(`${e.kind}:${e.id}`, e);
        else input.highlighted.delete(`${e.kind}:${e.id}`);
      }
    } else if (frame.method === 'setWeaklySelectable') input.weakly = frame;
    else if (frame.method === 'clearWeaklySelectable') input.weakly = null;
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
      // And, since wave 31 §S, the open selection, its marks and the actionable
      // set — in `Match.resendAfterSnapshot`'s order, each on the next cursor.
      if (input.selection !== null) stamp(input.selection, true);
      if (input.highlighted.size > 0) {
        stamp({ kind: 'notify', method: 'setHighlighted', entities: [...input.highlighted.values()], on: true } as ServerFrame, true);
      }
      if (input.weakly !== null) stamp(input.weakly, true);
      socket.emit(MATCH_EVENTS.role, { matchId, role: server.role });
    };
    socket.on(MATCH_EVENTS.join, answer(MATCH_EVENTS.join));
    socket.on(MATCH_EVENTS.resync, answer(MATCH_EVENTS.resync));
    socket.on(MATCH_EVENTS.clientToServer, (payload) => {
      server.received.push({ event: MATCH_EVENTS.clientToServer, payload });
      for (const check of [...onClientFrame]) check();
      const parsed = safeParseClientFrame((payload as { frame?: unknown }).frame);
      if (!parsed.ok || (parsed.value.kind !== 'reply' && parsed.value.kind !== 'abort')) return;
      openAsks.delete(parsed.value.callId);
    });
    // Recorded and nothing else: the real server only logs a refusal, so there
    // is no ack to fake and no state to hold.
    socket.on(MATCH_EVENTS.fullControl, (payload) => {
      server.received.push({ event: MATCH_EVENTS.fullControl, payload });
    });
    // Item 2/6 (wave 30): same shape as full control — recorded, no ack, no
    // state held here. The REAL handler (`apps/server/src/play/socket.ts`)
    // folds it into the seat's `StopPolicy`; this double only has to prove
    // what the CLIENT sent.
    socket.on(MATCH_EVENTS.stopPreference, (payload) => {
      server.received.push({ event: MATCH_EVENTS.stopPreference, payload });
    });
    // Same shape as full control and stop-preference above — recorded, no
    // ack, no state held here; the real handler folds it into
    // `Match.setAutoYield`, this double only has to prove what was sent.
    socket.on(MATCH_EVENTS.autoYield, (payload) => {
      server.received.push({ event: MATCH_EVENTS.autoYield, payload });
    });
    // Recorded only; the real handler (`Match.setPhaseStop`) echoes the seat's stop, which a test sends itself.
    socket.on(MATCH_EVENTS.phaseStop, (payload) => {
      server.received.push({ event: MATCH_EVENTS.phaseStop, payload });
    });
    // Recorded only; the real handler (`Match.setTriggerDecision`) answers with the list, which a test sends itself.
    socket.on(MATCH_EVENTS.triggerDecision, (payload) => {
      server.received.push({ event: MATCH_EVENTS.triggerDecision, payload });
    });
    // Not a client event: `caughtUp`'s marker, answered and never recorded.
    socket.on(CAUGHT_UP, (id) => {
      markers.get(id as number)?.();
      markers.delete(id as number);
    });
    // Client telemetry: the real handler writes it to the log; this double records what was sent.
    socket.on(CLIENT_EVENT, (payload) => {
      server.received.push({ event: CLIENT_EVENT, payload });
    });
  });

  await new Promise<void>((ready) => http.listen(0, '127.0.0.1', ready));
  server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return server;
}

/**
 * Resolves once `assertion` passes, tried now and again on every change `match`
 * announces — the moment a frame from the socket did what it was waited for.
 * It has no deadline of its own: the test's timeout is the bound, and the
 * assertion's last failure is printed if that runs out. A `waitFor` gave the
 * server-to-client hop RTL's one second, which a loaded host outlasted.
 */
export function untilMatch(match: LiveMatch, assertion: () => void): Promise<void> {
  return settled(() => new Promise<void>((resolve) => {
    let last: unknown = null;
    const passes = (): boolean => {
      try {
        assertion();
        return true;
      } catch (error) {
        last = error;
        return false;
      }
    };
    if (passes()) {
      resolve();
      return;
    }
    onTestFailed(() => {
      if (last !== null) console.error('untilMatch was still waiting on:', last);
    });
    const unsubscribe = subscribe(match, () => {
      if (!passes()) return;
      last = null;
      unsubscribe();
      resolve();
    });
  }));
}

/**
 * Wait as RTL's `waitFor` waits, minus its deadline: through the async wrapper
 * `@testing-library/react` installs, so React has drawn what the awaited change
 * set off by the time the test reads the page.
 */
function settled(wait: () => Promise<void>): Promise<void> {
  return getConfig().asyncWrapper(wait) as Promise<void>;
}

/** Poll until `check` holds, or fail naming what was being waited for. */
export async function until(what: string, check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
