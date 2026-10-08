/*
 * TEST SUPPORT — this client against a REAL Forge match in a real child JVM.
 * Never imported by the app.
 *
 * `./replay-server.ts` replays a captured match; this runs one. It starts a
 * match through the server's own exported API (`createMatchRegistry` over
 * `jvmHostFactory`, exactly as `apps/server/src/play/jvm.test.ts` does), and
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

import { isTierC, safeParseClientFrame, type ClientFrame, type ServerFrame } from '@hadoku/forge-wire';
import { ARRANGEMENT_EVENT, CLIENT_EVENT, PLACED_EVENT, PRESENCE_EVENT } from '@hadoku/shared';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type MatchSpec } from '../../../../server/src/play/host.ts';
import { createMatchRegistry, type Match } from '../../../../server/src/play/match.ts';
import { closeMatch, startMatch, type LiveMatch, type MatchTransport } from './match.ts';
import { MATCH_EVENTS, type ServerEnvelope } from './transport.ts';

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

export interface SeatClient {
  seat: number;
  live: LiveMatch;
  notes: SeatNotes;
  /** Send an act on `forge:c2s`, the way the board will. */
  act(frame: Extract<ClientFrame, { kind: 'act' }>): void;
}

export interface LiveHarness {
  match: Match;
  seats: [SeatClient, SeatClient];
  asks: AskRecord[];
  /** Every `fromClient` that was refused, reply or act. Should stay empty. */
  refused: { seat: number; frame: ClientFrame; error: string }[];
  /** Envelopes the server emitted, per seat — for the leak check. */
  emitted: { seat: number; envelope: ServerEnvelope }[];
  /** Every line the bridge wrote, unprojected — the leak oracle's source of secrets. */
  raw: BridgeLine[];
  /** The match server's own log entries (`ask-answered`, `ask-aborted`, …). */
  serverLog: Record<string, unknown>[];
  /** Close both seats (aborting what they hold open) and stop the match and its JVM. Idempotent. */
  stop(): void;
}

/** One message crossing, on the next macrotask — never synchronously. */
function later(fn: () => void): void {
  setTimeout(fn, 0);
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export { waitUntil };

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
    askTimeoutMs: 120_000,
    overGraceMs: 60_000,
    emit: (_m, seat, envelope) => {
      emitted.push({ seat, envelope });
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
    if (frame.kind !== 'act') {
      const record = asks.find((a) => a.callId === frame.callId);
      if (record !== undefined) {
        record.answer = frame;
        record.outcome = outcome;
      }
    }
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
         * Item 2/6 (wave 30): the settings panel's own preference, routed the
         * same way full control is above and `socket.ts`'s own handler is —
         * the CURRENT `StopPolicy` read back, `END_OF_TURN` toggled in or out
         * of `stopOnTheirTurn`, and the rest of the policy left untouched.
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
            const has = current.stopOnTheirTurn.includes('END_OF_TURN');
            if (stopAtEndStep === has) return;
            const stopOnTheirTurn = stopAtEndStep
              ? [...current.stopOnTheirTurn, 'END_OF_TURN' as const]
              : current.stopOnTheirTurn.filter((p) => p !== 'END_OF_TURN');
            const outcome = match.setStopPolicy(seat, { ...current, stopOnTheirTurn });
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

  await waitUntil(() => seats.every((s) => s.live.stats.snapshots >= 1 && s.live.view !== null), 'both seats to hold a board', 30_000);

  return {
    match,
    seats,
    asks,
    refused,
    emitted,
    raw,
    serverLog,
    stop: () => {
      for (const s of seats) if (s.live.connected) closeMatch(s.live);
      match.stop();
      // Killed, not waited out — see `scenario.ts`'s `stop()` for the measurement.
      host.reapOnExit();
    },
  };
}
