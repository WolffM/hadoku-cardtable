/*
 * TEST SUPPORT — this client against a REAL Forge match in a real child JVM.
 * Never imported by the app.
 *
 * `./replay-server.ts` replays a captured match; this runs one. It starts a
 * match through the server's own exported API (`createMatchRegistry` over
 * `jvmHostFactory`, exactly as `apps/server/src/play/match.jvm.test.ts` does), and
 * connects one `LiveMatch` per seat to it. Everything on the client side is
 * the product path: `ingest`, the fold, `LiveBoard`, the prompt components,
 * `answerAsk`. Every answer a component gives travels `answerAsk` →
 * `replyFrame` → `forge:c2s` → `Match.fromClient` → the bridge → Forge's
 * `sendAndWait`, and every outcome of `fromClient` is recorded so a refused
 * reply fails the test rather than going quiet.
 *
 * ## What it replaces: the socket.io hop, and only that
 *
 * The transport is `MatchTransport` (four methods, `./match.ts`) implemented
 * over the registry in-process instead of over socket.io. The events and
 * payloads are the contract's (`forge:join` → `Match.snapshot` then
 * `resendAfterSnapshot`, in `socket.ts`'s order; `forge:c2s` →
 * `safeParseClientFrame` → `Match.fromClient`), and delivery is asynchronous
 * in both directions, one macrotask per message, as a socket's would be. The
 * socket hop itself is proven elsewhere: `./match.test.ts` (client over a real
 * socket.io server) and `apps/server/src/play/socket.test.ts` (server over
 * real clients). Going through `attachPlay` here would need the edge-auth
 * environment `CONFIG` reads at import time, which a test cannot set per case.
 *
 * ## Acts
 *
 * The board does not send acts yet (`Board.tsx` has no buttons). The driver
 * here sends them on the same `forge:c2s` event, through the same transport,
 * so a scenario can steer a game to the point where Forge asks something.
 * `notes` keeps what the state channel does not carry and a driver needs —
 * each seat's latest prompt message, buttons and selectables.
 */

import { expect } from 'vitest';

import { isTierC, safeParseClientFrame, type ClientFrame, type ServerFrame } from '@hadoku/forge-wire';
import { ARRANGEMENT_EVENT, CLIENT_EVENT, PLACED_EVENT, PRESENCE_EVENT } from '@hadoku/shared';

import { join } from 'node:path';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type MatchSpec } from '../../../../server/src/play/host.ts';
import { withEndStepStop } from '../../../../server/src/play/auto.ts';
import { WATCHER_SEAT, createMatchRegistry, type Match } from '../../../../server/src/play/match.ts';
import { dumpTimeoutReport, scenarioText, summarizeFrame } from '../../../../server/src/play/scenario.ts';
import { closeMatch, startMatch, type LiveMatch, type MatchTransport } from './match.ts';
import { MATCH_EVENTS, type MatchSnapshot, type ServerEnvelope, type WireCursor } from './transport.ts';

export type { BridgeLine, MatchSpec };
export { liveJvmCount };

/** Is a Forge build configured? The same check the server's JVM test skips on. Warm spare off: one JVM per test match, nothing left behind. */
export function forgeAvailability() {
  return jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_SPARE: '0' });
}

type Notify<M extends string> = Extract<ServerFrame, { method: M }>;

/** What a seat was last told that the fold does not keep. */
export interface SeatNotes {
  prompt: Notify<'showPromptMessage'> | null;
  buttons: Notify<'updateButtons'> | null;
  selectables: Notify<'setSelectables'> | null;
  /** Bumped on every prompt/buttons/selectables frame: "the game said something new". */
  version: number;
}

/** One ask as the harness saw it, and what became of it. */
export interface AskRecord {
  seat: number;
  callId: string;
  method: string;
  ask: ServerFrame;
  /** The frame this client sent back, when it did. */
  answer: ClientFrame | null;
  /** `Match.fromClient`'s verdict on that frame. */
  outcome: { ok: true } | { ok: false; error: string } | null;
  /** Frames this seat was sent after the answer — "the game moved on". */
  framesAfter: number;
  /** State frames this seat was sent while the ask was open, unanswered. */
  stateWhileOpen: number;
}

/**
 * Put a reply on its ask's record. The record keeps the reply Forge took: a
 * refused reply after an accepted one (a second answer, `stale-reply`) never
 * overwrites it — that refusal is in {@link LiveHarness.refused} — while an
 * accepted reply replaces a refused one before it.
 */
export function recordReply(asks: AskRecord[], frame: Exclude<ClientFrame, { kind: 'act' }>, outcome: NonNullable<AskRecord['outcome']>): void {
  const record = asks.find((a) => a.callId === frame.callId);
  if (record === undefined || record.outcome?.ok === true) return;
  record.answer = frame;
  record.outcome = outcome;
}

export interface SeatClient {
  seat: number;
  live: LiveMatch;
  notes: SeatNotes;
  /** Send an act on `forge:c2s`, the way the board will. */
  act(frame: Extract<ClientFrame, { kind: 'act' }>): void;
}

/**
 * What a timed-out `waitUntil` needs to dump (S11, wave 64) — a structural
 * subset of {@link LiveHarness}, so the one internal wait before a
 * `LiveHarness` exists yet (below) can pass the pieces it already has in
 * scope without constructing the whole thing early.
 */
export interface DumpSource {
  match: Match;
  emitted: { seat: number; envelope: ServerEnvelope }[];
  serverLog: Record<string, unknown>[];
  /** `JvmHostConfig.workDir` this match's JVM ran under — where its `bridge.stderr.txt` lives. */
  workDir: string;
}

export interface LiveHarness extends DumpSource {
  seats: [SeatClient, SeatClient];
  asks: AskRecord[];
  /** Every `fromClient` that was refused, reply or act. Should stay empty. */
  refused: { seat: number; frame: ClientFrame; error: string }[];
  /** Every line the bridge wrote, unprojected — the leak oracle's source of secrets. */
  raw: BridgeLine[];
  /** Close both seats (aborting what they hold open) and stop the match and its JVM. Idempotent. */
  stop(): void;
}

/** One message crossing, on the next macrotask — never synchronously. */
function later(fn: () => void): void {
  setTimeout(fn, 0);
}

/**
 * `dump`, when given, is captured on a timeout — `apps/server/src/play/
 * scenario.ts`'s `dumpTimeoutReport`, the ONE function both jvm harnesses
 * call (S11, wave 64): before this fold this file kept no bridge stderr and
 * removed the run dir on `stop()`, so a timeout here had nothing to
 * diagnose from (`flow.jvm.test.ts`'s three reds of 2026-10-08). Call this
 * BEFORE `stop()` — same rule `scenario.ts`'s own `waitUntil` follows,
 * because `stop()` is what removes the run dir `bridge.stderr.txt` lives in.
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number, dump?: DumpSource): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      const detail = dump === undefined ? '' : ` (${dumpOnTimeout(dump, label)})`;
      throw new Error(`timed out waiting for ${label}${detail}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** This file's own call into the shared dump: a `DumpSource`'s frames, decisions and stderr path. */
function dumpOnTimeout(dump: DumpSource, label: string): string {
  return dumpTimeoutReport({
    label,
    frames: dump.emitted.slice(-80).map((e) => summarizeFrame(e.seat, e.envelope.frame)),
    decisions: dump.serverLog.filter((l) => l.evt === 'stop-decided' || l.evt === 'auto-passed'),
    stderrPath: join(dump.workDir, dump.match.id, 'bridge.stderr.txt'),
  });
}

export { waitUntil };

/** What {@link expectNoDesync} reads: the server's match, every envelope it sent, and each seat's client. */
export interface DesyncSource {
  match: Pick<Match, 'id' | 'snapshot'>;
  emitted: readonly { seat: number; envelope: ServerEnvelope }[];
  seats: readonly Pick<SeatClient, 'seat' | 'live'>[];
}

/**
 * The snapshot the server would have answered `seat` with when that seat's
 * cursor was `cursor`: its history cut to the frames it had sent by then.
 * Throws when the server never sent that seat that cursor.
 *
 * `Match` pushes a history frame and sends that same object in one step
 * (`sendState`, `learnShown`, `openView`), so the history frames sent by
 * `cursor` are exactly the history's prefix whose objects are among the
 * envelopes `emitted` holds for the seat at or below it.
 */
function snapshotAt(h: DesyncSource, seat: number, cursor: WireCursor): MatchSnapshot {
  const now = h.match.snapshot(seat);
  if (!('frames' in now)) throw new Error(`no snapshot for seat ${seat}: ${now.error}`);
  const sent = h.emitted.filter((e) => e.seat === seat && e.envelope.cursor.epoch === cursor.epoch && e.envelope.cursor.seq <= cursor.seq);
  if (!sent.some((e) => e.envelope.cursor.seq === cursor.seq)) {
    throw new Error(`seat ${seat} is at ${JSON.stringify(cursor)}, a cursor the server never sent it`);
  }
  const sentFrames = new Set<unknown>(sent.map((e) => e.envelope.frame));
  const cut = now.frames.findIndex((f) => !sentFrames.has(f));
  const frames = cut === -1 ? now.frames : now.frames.slice(0, cut);
  if (now.frames.slice(frames.length).some((f) => sentFrames.has(f))) {
    throw new Error(`seat ${seat}'s history is not in the order it was sent`);
  }
  return { ...now, cursor, frames };
}

/** A late joiner: a fresh client whose whole board comes from `snapshot`. */
async function freshFold(snapshot: MatchSnapshot): Promise<LiveMatch> {
  const transport: MatchTransport = {
    on: () => {},
    emit: () => {},
    request: (_e, _p, onAck) => setTimeout(() => onAck(null, snapshot), 0),
    disconnect: () => {},
  };
  const fresh = startMatch({ matchId: snapshot.matchId, transport });
  await waitUntil(() => fresh.stats.snapshots === 1, `a fresh snapshot of seat ${snapshot.seat}`, 5000);
  return fresh;
}

function sameCursor(a: WireCursor | null, b: WireCursor | null): boolean {
  return a?.epoch === b?.epoch && a?.seq === b?.seq;
}

/**
 * Each seat caught up with the server, and its board — folded incrementally
 * through everything it was sent — equals a fresh fold of the server's own
 * history for that seat AT THE SEAT'S CURSOR.
 *
 * The server keeps talking after a driver's plan is done (every auto-pass is
 * a frame), so the seat and the server's latest are never compared: a frame
 * that lands between two reads is the next fold, not a desync. What the seat
 * holds is read once, synchronously, together with the server's history cut
 * to that seat's cursor, so nothing can cross between them.
 */
export async function expectNoDesync(h: DesyncSource): Promise<void> {
  // Not stuck behind: at one moment every seat had folded all it was sent.
  await waitUntil(
    () =>
      h.seats.every((s) => {
        const now = h.match.snapshot(s.seat);
        return 'frames' in now && sameCursor(s.live.cursor, now.cursor);
      }),
    'each seat to fold every frame the server sent it',
    10_000,
  );
  for (const s of h.seats) {
    const { cursor, state, view, lastError } = s.live;
    const stats = { ...s.live.stats };
    if (cursor === null) throw new Error(`seat ${s.seat} holds no cursor`);
    const server = snapshotAt(h, s.seat, cursor);
    expect(stats).toMatchObject({ gaps: 0, epochChanges: 0, resyncsRequested: 0, invalid: 0 });
    expect(lastError).toBeNull();
    const fresh = await freshFold(server);
    expect(Object.fromEntries(state)).toEqual(Object.fromEntries(fresh.state));
    expect(view).toEqual(fresh.view);
  }
}

/**
 * A match that starts where a question is asked: `apps/server/src/play/
 * scenarios/<name>.state` applied after the mulligan, both seats human.
 * `human…` keys are seat 0's, `ai…` keys seat 1's.
 *
 * The scenario scripts every zone, so a deck only matters for what happens
 * BEFORE it applies — the opening hands, the mulligan — and is forty
 * Mountains unless a caller needs that part (`decks`).
 *
 * This is how a driver reaches an ask. A seeded game played until Forge
 * happened to raise one was the biggest red on main (`prompts.jvm`'s combat
 * case: 24 of 129 runs, docs/planning/test-audit-2026-10-12.md M1); a
 * scenario reaches its ask every run, in one turn.
 */
export function startLiveScenario(name: string, decks: [string, string] = ['40 Mountain', '40 Mountain']): Promise<LiveHarness> {
  const deck = (seat: number) => `[metadata]\nName=Scenario ${seat}\n[main]\n${decks[seat]}\n`;
  return startLiveMatch({
    seed: 7,
    seats: [
      { name: 'A', ai: false, deck: deck(0) },
      { name: 'B', ai: false, deck: deck(1) },
    ],
    scenario: scenarioText(name),
  });
}

export async function startLiveMatch(spec: MatchSpec): Promise<LiveHarness> {
  const available = forgeAvailability();
  if (!available.ok) throw new Error(available.reason);
  const host = jvmHostFactory(available.config);

  const handlers: Map<string, (payload: unknown) => void>[] = [new Map(), new Map()];
  const notes: SeatNotes[] = [0, 1].map(() => ({ prompt: null, buttons: null, selectables: null, version: 0 }));
  const asks: AskRecord[] = [];
  const refused: LiveHarness['refused'] = [];
  const emitted: LiveHarness['emitted'] = [];
  const raw: BridgeLine[] = [];
  const serverLog: Record<string, unknown>[] = [];

  const registry = createMatchRegistry({
    host: (id, matchSpec, events) =>
      host(id, matchSpec, {
        ...events,
        line: (l) => {
          raw.push(l);
          events.line(l);
        },
      }),
    log: (entry) => serverLog.push(entry),
    overGraceMs: 60_000,
    emit: (_m, seat, envelope) => {
      emitted.push({ seat, envelope });
      // The watcher channel: `socket.ts` sends it to the sockets that joined with no seat, and
      // these two clients are both seated — kept in `emitted`, delivered to nobody.
      if (seat === WATCHER_SEAT) return;
      const frame = envelope.frame;
      const n = notes[seat]!;
      if (frame.method === 'showPromptMessage') n.prompt = frame;
      else if (frame.method === 'updateButtons') n.buttons = frame;
      else if (frame.method === 'setSelectables') n.selectables = frame;
      else if (frame.method === 'clearSelectables') n.selectables = null;
      if (
        frame.method === 'showPromptMessage' ||
        frame.method === 'updateButtons' ||
        frame.method === 'setSelectables' ||
        frame.method === 'clearSelectables'
      ) {
        n.version += 1;
      }
      if (frame.kind === 'ask' && !asks.some((a) => a.callId === frame.callId)) {
        asks.push({ seat, callId: frame.callId, method: frame.method, ask: frame, answer: null, outcome: null, framesAfter: 0, stateWhileOpen: 0 });
      }
      for (const a of asks) {
        if (a.seat !== seat) continue;
        if (a.answer !== null) a.framesAfter += 1;
        else if (isTierC(frame.method)) a.stateWhileOpen += 1;
      }
      const deliver = handlers[seat]!.get(MATCH_EVENTS.serverToClient);
      if (deliver !== undefined) later(() => deliver(envelope));
    },
  });
  const match = registry.create(spec);
  const running = await match.whenRunning(120_000);
  if (!running.ok) {
    match.stop();
    throw new Error(`the match did not start: ${running.error}`);
  }

  function fromClient(seat: number, raw: unknown): void {
    const parsed = safeParseClientFrame((raw as { frame?: unknown }).frame);
    if (!parsed.ok) throw new Error(`seat ${seat} sent a frame forge-wire refuses: ${JSON.stringify(parsed.errors)}`);
    const frame = parsed.value;
    const outcome = match.fromClient(seat, frame);
    if (frame.kind !== 'act') recordReply(asks, frame, outcome);
    if (!outcome.ok) refused.push({ seat, frame, error: outcome.error });
  }

  function transport(seat: number): MatchTransport {
    return {
      on: (event, handler) => {
        handlers[seat]!.set(event, handler);
        // An in-process "socket" is connected as soon as someone listens.
        if (event === 'connect') later(() => handler(undefined));
      },
      emit: (event, payload) => {
        // The two events a client emits, as `socket.ts` routes them: answers and
        // acts on `forge:c2s`, and the full-control preference on its own event
        // (`socket.ts:401-415`, where the seat is the one `claim` bound, never
        // the payload's — so this passes `seat`, not anything read from it).
        if (event === MATCH_EVENTS.fullControl) {
          const on = (payload as { on?: unknown }).on === true;
          later(() => {
            const outcome = match.setFullControl(seat, on);
            if (!outcome.ok) throw new Error(`seat ${seat} could not set full control: ${outcome.error}`);
          });
          return;
        }
        /*
         * The settings' End step checkbox, routed the same way full control
         * is above and `socket.ts`'s own handler is — `withEndStepStop` on the
         * CURRENT `StopPolicy`, the rest of the policy left untouched.
         * `LiveBoard.tsx`'s join/resync effect sends this on EVERY mount that
         * reaches a snapshot (not only when the settings panel is opened), so
         * every jar-gated scenario that mounts `LiveBoard` emits it once —
         * this case existing is what keeps that from being "unexpected emit
         * forge:stop-preference" the way it was before this lane added it.
         */
        if (event === MATCH_EVENTS.stopPreference) {
          const stopAtEndStep = (payload as { stopAtEndStep?: unknown }).stopAtEndStep === true;
          later(() => {
            const current = match.stopPolicy(seat);
            const next = withEndStepStop(current, stopAtEndStep);
            if (next === current) return;
            const outcome = match.setStopPolicy(seat, next);
            if (!outcome.ok) throw new Error(`seat ${seat} could not set stop preference: ${outcome.error}`);
          });
          return;
        }
        /*
         * The other seat's pointer and hands (`presence.ts`), never a game frame and not routed
         * through `fromClient` — Forge never hears it and no scenario here reads it back, so a
         * real drag's `pointerup`/`pointercancel` (sent at once, outside the throttle) emitting
         * this mid-scenario is not "unexpected emit forge:presence".
         */
        // Presence, the placement sync, a placed spell's own move, and client telemetry are the
        // seat's own side-channels: none is a Forge act.
        if (event === PRESENCE_EVENT || event === ARRANGEMENT_EVENT || event === CLIENT_EVENT || event === PLACED_EVENT) return;
        if (event !== MATCH_EVENTS.clientToServer) throw new Error(`unexpected emit ${event}`);
        later(() => fromClient(seat, payload));
      },
      // `forge:join` and `forge:resync` are answered alike once a seat is bound.
      request: (_event, _payload, onAck) => {
        later(() => {
          const snapshot = match.snapshot(seat);
          onAck(null, snapshot);
          // socket.ts's order: after the ack, so the client holds the cursor first.
          if ('frames' in snapshot) later(() => match.resendAfterSnapshot(seat));
        });
      },
      disconnect: () => {
        handlers[seat]!.clear();
      },
    };
  }

  const seats = [0, 1].map((seat): SeatClient => {
    const t = transport(seat);
    const live = startMatch({ matchId: match.id, transport: t });
    return {
      seat,
      live,
      notes: notes[seat]!,
      act: (frame) => t.emit(MATCH_EVENTS.clientToServer, { matchId: match.id, frame }),
    };
  }) as [SeatClient, SeatClient];

  await waitUntil(
    () => seats.every((s) => s.live.stats.snapshots >= 1 && s.live.view !== null),
    'both seats to hold a board',
    30_000,
    { match, emitted, serverLog, workDir: available.config.workDir },
  );

  return {
    match,
    seats,
    asks,
    refused,
    emitted,
    raw,
    serverLog,
    workDir: available.config.workDir,
    stop: () => {
      for (const s of seats) if (s.live.connected) closeMatch(s.live);
      match.stop();
      // Killed, not waited out — see `scenario.ts`'s `stop()` for the measurement.
      host.reapOnExit();
    },
  };
}
