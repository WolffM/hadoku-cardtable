/*
 * A Forge match driven by a server, over socket.io — the live source for the
 * board.
 *
 * The board already has one source, the committed fixture
 * (`../fixtures.ts` → `../fold.ts` → `../adapter.ts` → `../Board.tsx`). This is
 * the second, and it ends in exactly the same two calls: `foldPackets` makes
 * the state, `toBoardView` makes the view. `Board.tsx` cannot tell which
 * source drew it, which is the property that lets a rendering regression be
 * bisected against the fixture without a server. `./parity.test.ts` proves the
 * two paths produce byte-identical markup.
 *
 * It is shaped on purpose like the draft's socket driver
 * (`apps/ui/src/draft/socket.ts`): a transport seam of a few methods, a mutable
 * handle with counters, `ingest` as the one entry point for inbound frames,
 * and the same sequencing rules. The transport contract itself is
 * `./transport.ts`.
 *
 * ## Sequencing: `classifySeq`, the same four answers as the draft
 *
 *  - `ok` — the next frame. Apply it and advance the cursor.
 *  - `duplicate` — already seen. DROP, and ask for nothing. Retransmits come in
 *    bursts; a client that resynced on "anything that isn't ok" answers a burst
 *    with a request storm. `needsResync` is what gets this right, and
 *    `verdict !== 'ok'` is never spelled in this file.
 *  - `gap` — frames were missed. The state channel is a delta stream, so this
 *    frame cannot be folded onto what we hold. Drop it and resync.
 *  - `epoch-change` — the match process restarted. Everything local is about a
 *    process that no longer exists: discard it, then refetch.
 *
 * While a snapshot is in flight (the join, or a resync) inbound frames are
 * BUFFERED, not classified: the cursor they would be compared against is about
 * to be replaced. When the snapshot lands the buffer is replayed through the
 * same rules, so a frame the snapshot already covers comes out `duplicate` and
 * is dropped, and one that follows it comes out `ok`.
 *
 * ## Every ask is rendered, and every ask is answered exactly once
 *
 * All fifteen blocking methods have a component — `showConfirmDialog` here in
 * `./ConfirmDialog.tsx`, the other fourteen in `../prompts/` — so an ask is
 * never refused for its method. Two rules keep Forge's thread from parking,
 * because `ReplyPool.get` is an untimed wait (`@hadoku/forge-wire`'s
 * `envelope.ts` header):
 *
 *  - **Open asks are a queue, keyed by `callId`, never a single slot.** The
 *    server holds a seat's asks by `callId` (`apps/server/src/play/match.ts`)
 *    because a diagnostic probe can open one beside the game's. A second ask
 *    that REPLACED the first would leave the first waiting on an answer
 *    nobody can give any more. `LiveBoard` draws the oldest; the rest wait
 *    their turn, still open.
 *  - **An ask that cannot be read is aborted** (`unsupported`), and so is one
 *    whose component fails to draw (`LiveBoard`'s boundary calls `abortAsk`).
 *    Closing the match with questions still open sends `cancelled` for each.
 *
 * Every answer leaves by ONE path: `answerAsk` → `replyFrame` → `forge:c2s`,
 * the seam Wave 9 proved with `showConfirmDialog`. `answerConfirm` is that
 * call with the method filled in.
 *
 * ## An open prompt never holds the board back
 *
 * A prompt arrives mid-priority, with the state channel still moving (the
 * opponent's triggers, a zone change the ask itself caused). Asks do not stop
 * or buffer anything: a state frame that lands while a prompt is open is
 * folded exactly as it would be with none, and the cursor advances. The
 * prompt reads names from the CURRENT state (`lookupFromState`), and is keyed
 * by `callId` so a redraw under it never resets a half-made choice.
 *
 * ## Which player is "me"
 *
 * `MatchSnapshot.playerId`, from the server — never a guess from the state.
 * Until a snapshot has said so there is no viewer, and `view` stays null, so no
 * hand can be drawn before the client knows whose hand it is.
 */

import { asSeqCursor } from '@hadoku/shared';
import {
  REPLY_SCHEMAS,
  safeParseServerFrame,
  type BlockingMethod,
  type ClientAbort,
  type ServerFrame,
} from '@hadoku/forge-wire';
import { classifySeq, needsResync, type SeqVerdict } from '@wolffm/rooms-protocol';
import { io } from 'socket.io-client';

import { defaultSocketPath } from '../../draft/socket.ts';
import { toBoardView, type BoardView } from '../adapter.ts';
import { foldPackets, type WireState } from '../fold.ts';
import { expectWirePackets, type WirePacket } from '../wire.ts';
import {
  abortFrame,
  MATCH_EVENTS,
  parseMatchAck,
  parseServerEnvelope,
  replyFrame,
  type ClientEnvelope,
  type MatchSnapshot,
  type TransportIssue,
  type WireCursor,
} from './transport.ts';

/** Any blocking ask, as parsed. */
export type LiveAsk = Extract<ServerFrame, { kind: 'ask' }>;

/** The ask `./ConfirmDialog.tsx` draws. */
export type ConfirmAsk = Extract<LiveAsk, { method: 'showConfirmDialog' }>;

/* ── The transport seam ──────────────────────────────────────────────── */

/**
 * Four methods — the draft's three, plus a request with an ack, because
 * `forge:join` and `forge:resync` are answered by acknowledgement rather than
 * by a frame on the stream.
 */
export interface MatchTransport {
  on(event: string, handler: (payload: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  /** Emit and wait for the ack. `err` is set when none came in time. */
  request(event: string, payload: unknown, onAck: (err: Error | null, response: unknown) => void): void;
  disconnect(): void;
}

export interface SocketIoMatchOptions {
  /**
   * The server's origin, e.g. `http://localhost:9008`. Omitted: same origin,
   * which is production — the app is served by the server it talks to.
   */
  url?: string;
  /** socket.io path. Defaults to the bundle's `/cardtable/socket.io/`. */
  path?: string;
  /**
   * `['websocket']` for a cross-origin dev server: a websocket is not subject
   * to CORS, where the long-polling handshake would be.
   */
  transports?: ('websocket' | 'polling')[];
  /** How long a join or resync may go unanswered. */
  ackTimeoutMs?: number;
}

export const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/**
 * How long a hang-up waits so the frames emitted just before it arrive.
 *
 * Measured, not assumed: a socket.io SERVER dispatches an inbound event on the
 * next tick and drops it if the socket disconnected in between ("ignore packet
 * received after disconnection"). An abort emitted and immediately followed by
 * `disconnect()` travels in the same flush as the DISCONNECT packet and is
 * lost — `match.test.ts`'s "closing the board" case failed exactly that way
 * before this grace existed. It is best effort by nature: a tab that is
 * killed sends nothing at all, which is why the server must also treat a
 * disconnect with a question open as an abort (`disconnected`).
 */
export const DISCONNECT_GRACE_MS = 100;

export function socketIoMatchTransport(options: SocketIoMatchOptions = {}): MatchTransport {
  const path = options.path ?? defaultSocketPath();
  const settings = options.transports === undefined ? { path } : { path, transports: options.transports };
  const socket = options.url === undefined ? io(settings) : io(options.url, settings);
  const timeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  // Same reasoning as the draft's transport: our events are declared and
  // Zod-validated in this repo, not declared to socket.io, so the honest type
  // of a payload at this boundary is `unknown`.
  const raw = socket as unknown as {
    on(event: string, handler: (payload?: unknown) => void): void;
    emit(event: string, payload: unknown): void;
    timeout(ms: number): {
      emit(event: string, payload: unknown, ack: (err: Error | null, response?: unknown) => void): void;
    };
    disconnect(): void;
  };

  return {
    on: (event, handler) => {
      raw.on(event, (payload) => {
        handler(payload);
      });
    },
    emit: (event, payload) => {
      raw.emit(event, payload);
    },
    request: (event, payload, onAck) => {
      raw.timeout(timeoutMs).emit(event, payload, (err, response) => {
        onAck(err, response);
      });
    },
    disconnect: () => {
      setTimeout(() => raw.disconnect(), DISCONNECT_GRACE_MS);
    },
  };
}

/* ── The handle ──────────────────────────────────────────────────────── */

/** Counters, so the sequencing rules can be asserted rather than believed. */
export interface MatchStats {
  /** Frames applied from the stream (not counting snapshots). */
  applied: number;
  /** Dropped as already seen. These must NEVER produce a resync. */
  duplicatesDropped: number;
  gaps: number;
  epochChanges: number;
  /** `forge:resync` requests actually put on the wire. */
  resyncsRequested: number;
  /** Snapshots adopted — the join's and every resync's. */
  snapshots: number;
  /** Envelopes or frames that did not parse. Counted, never applied. */
  invalid: number;
  /** `forge:join` requests sent, including re-joins after a reconnect. */
  joins: number;
  /** Frames held while a snapshot was in flight, then replayed. */
  buffered: number;
  /** Answers sent. */
  replies: number;
  /** `ClientAbort`s sent. */
  aborts: number;
}

/** Forge's two-button bar. `label1` is OK/Play, `label2` is Cancel/Draw. */
export interface LiveButtons {
  label1: string;
  label2: string;
  enable1: boolean;
  enable2: boolean;
}

export interface LiveMatch {
  readonly matchId: string;
  /** From the snapshot. Null until one lands. */
  seat: number | null;
  /** This seat's Forge player id, from the snapshot. Null until one lands. */
  playerId: number | null;
  /** Where we are in OUR stream (per recipient). Null: nothing applied yet. */
  cursor: WireCursor | null;
  /** The folded state channel. */
  state: WireState;
  /** Forge's own `DeltaPacket.seq` of the last packet folded. */
  forgeSeq: number;
  /** Deltas addressed to objects never created (fold rule 4), cumulative. */
  skippedDeltas: number;
  /** What `Board` draws. Null until there is a state AND a viewer. */
  view: BoardView | null;
  /**
   * Every question open for this player, oldest first. See the module header:
   * a queue, because the server may hold more than one.
   */
  asks: LiveAsk[];
  /**
   * Forge's current prompt line and button bar, from the `notify` frames
   * `showPromptMessage` and `updateButtons`.
   *
   * These are NOT a blocking ask — no `callId`, nothing to reply to — and that
   * is why the board ignored them until now. But the coin toss, the mulligan
   * and every "pass priority?" come through here, so a board that draws only
   * `asks` shows an empty table and the match never starts. The server already
   * stores and replays both on join (`match.ts`'s `resendAfterSnapshot`).
   */
  prompt: string | null;
  buttons: LiveButtons | null;
  /** The most recent failure worth showing. Cleared when a snapshot lands. */
  lastError: string | null;
  /** Why the most recent malformed envelope or frame was refused. */
  lastInvalid: TransportIssue[] | null;
  lastVerdict: SeqVerdict | null;
  connected: boolean;
  everConnected: boolean;
  /** A join or resync is in flight; inbound frames are being buffered. */
  awaitingSnapshot: boolean;
  /** Resyncs since a frame last applied. See `MAX_RESYNCS_WITHOUT_PROGRESS`. */
  resyncsWithoutProgress: number;
  stats: MatchStats;
  /** Bumped on every observable change — what React subscribes to. */
  revision: number;
  /* Internals. */
  transport: MatchTransport;
  buffer: unknown[];
  listeners: Set<() => void>;
}

export interface LiveMatchOptions {
  matchId: string;
  /** Defaults to a same-origin socket.io connection. */
  transport?: MatchTransport;
}

function emptyStats(): MatchStats {
  return {
    applied: 0,
    duplicatesDropped: 0,
    gaps: 0,
    epochChanges: 0,
    resyncsRequested: 0,
    snapshots: 0,
    invalid: 0,
    joins: 0,
    buffered: 0,
    replies: 0,
    aborts: 0,
  };
}

function notify(match: LiveMatch): void {
  match.revision += 1;
  for (const listener of match.listeners) listener();
}

/** `useSyncExternalStore`'s subscribe. Returns the unsubscribe. */
export function subscribe(match: LiveMatch, listener: () => void): () => void {
  match.listeners.add(listener);
  return () => {
    match.listeners.delete(listener);
  };
}

function send(match: LiveMatch, frame: ClientEnvelope['frame']): void {
  const envelope: ClientEnvelope = { matchId: match.matchId, frame };
  match.transport.emit(MATCH_EVENTS.clientToServer, envelope);
}

/**
 * Connect, join, listen.
 *
 * The join goes out at once (socket.io buffers an emit made before the
 * handshake) and again on every RE-connect, which is what returns a refreshed
 * browser to its seat. The first `connect` is not a re-join — joining twice
 * would fetch two snapshots for nothing. Same rule as the draft's driver.
 */
export function startMatch(options: LiveMatchOptions): LiveMatch {
  const match: LiveMatch = {
    matchId: options.matchId,
    seat: null,
    playerId: null,
    cursor: null,
    state: new Map(),
    forgeSeq: 0,
    skippedDeltas: 0,
    view: null,
    asks: [],
    prompt: null,
    buttons: null,
    lastError: null,
    lastInvalid: null,
    lastVerdict: null,
    connected: false,
    everConnected: false,
    awaitingSnapshot: false,
    resyncsWithoutProgress: 0,
    stats: emptyStats(),
    revision: 0,
    transport: options.transport ?? socketIoMatchTransport(),
    buffer: [],
    listeners: new Set(),
  };

  match.transport.on(MATCH_EVENTS.serverToClient, (payload) => {
    ingest(match, payload);
  });

  match.transport.on('connect', () => {
    const rejoin = match.everConnected;
    match.connected = true;
    match.everConnected = true;
    if (rejoin) fetchSnapshot(match, 'join');
    notify(match);
  });

  match.transport.on('disconnect', () => {
    match.connected = false;
    notify(match);
  });

  fetchSnapshot(match, 'join');
  return match;
}

/** The ask to draw now: the oldest one open. */
export function currentAsk(match: LiveMatch): LiveAsk | null {
  return match.asks[0] ?? null;
}

/** Take `callId` off the open list. False when it was not on it. */
function closeAsk(match: LiveMatch, callId: string): boolean {
  const i = match.asks.findIndex((a) => a.callId === callId);
  if (i < 0) return false;
  match.asks.splice(i, 1);
  return true;
}

/**
 * Answer an open ask — the ONE way an answer leaves this client.
 *
 * Returns false, and sends nothing, when `callId` is not open (a double click,
 * or a click on a prompt that a snapshot or an epoch change has since
 * replaced), when `method` is not the method it was asked with, or when
 * `result` fails `REPLY_SCHEMAS[method]`. The components already parse their
 * answer through that schema (`../prompts/types.ts` `checkedReply`); checking
 * again here keeps the seam honest for any caller that is not a component.
 * One ask gets one answer.
 */
export function answerAsk(match: LiveMatch, callId: string, method: BlockingMethod, result: unknown): boolean {
  const ask = match.asks.find((a) => a.callId === callId);
  if (ask === undefined || ask.method !== method) return false;
  const parsed = REPLY_SCHEMAS[method].safeParse(result);
  if (!parsed.success) {
    match.lastError = `refused to send an answer to ${method} that fails its wire schema`;
    notify(match);
    return false;
  }
  closeAsk(match, callId);
  send(match, replyFrame(callId, method, parsed.data));
  match.stats.replies += 1;
  notify(match);
  return true;
}

/**
 * Press one of Forge's two buttons.
 *
 * Unlike `answerAsk` there is no `callId` and no reply schema: the button bar
 * is a notify, and the answer is an unsolicited `act`. The server forwards it
 * to Forge's `selectButtonOk` / `selectButtonCancel`.
 *
 * Refuses when that button is disabled, so a stale bar cannot send an act the
 * game is not waiting for — the frame that disabled it is the authority, and
 * Forge would otherwise take the click as an answer to whatever it asks next.
 */
export function pressButton(match: LiveMatch, which: 'ok' | 'cancel'): boolean {
  const bar = match.buttons;
  if (bar === null) return false;
  if (which === 'ok' ? !bar.enable1 : !bar.enable2) return false;
  send(match, { kind: 'act', method: which === 'ok' ? 'selectButtonOk' : 'selectButtonCancel' });
  // Forge sends a fresh bar for the next decision; until it does, the bar we
  // just answered must not be pressable twice.
  match.buttons = { ...bar, enable1: false, enable2: false };
  match.stats.replies += 1;
  notify(match);
  return true;
}

/** `showConfirmDialog`'s answer: `answerAsk` with the method filled in. */
export function answerConfirm(match: LiveMatch, callId: string, yes: boolean): boolean {
  return answerAsk(match, callId, 'showConfirmDialog', yes);
}

/**
 * Give up on an open ask: Forge gets its own answer to a null reply. For a
 * prompt that cannot be drawn (`LiveBoard`'s boundary) — never a way to
 * answer. False when `callId` is not open.
 */
export function abortAsk(match: LiveMatch, callId: string, reason: ClientAbort['reason'], detail: string): boolean {
  if (!closeAsk(match, callId)) return false;
  sendAbort(match, callId, reason, detail);
  notify(match);
  return true;
}

/**
 * Leave. Every open question is ABORTED first (`cancelled`), so Forge's reply
 * pool is not left waiting on a tab that has gone.
 */
export function closeMatch(match: LiveMatch): void {
  for (const ask of match.asks) sendAbort(match, ask.callId, 'cancelled', 'the player closed the board');
  match.asks = [];
  match.transport.disconnect();
  match.connected = false;
  notify(match);
}

function sendAbort(match: LiveMatch, callId: string, reason: ClientAbort['reason'], detail: string): void {
  send(match, abortFrame(callId, reason, detail));
  match.stats.aborts += 1;
}

/* ── Snapshots ───────────────────────────────────────────────────────── */

/**
 * How many resyncs in a row may go by with no frame applied between them.
 *
 * A healthy server needs one: the snapshot re-baselines the cursor and the
 * next frame is `ok`. A server whose snapshot cursor lags its own stream would
 * answer every resync with a state that the very next frame gaps from again —
 * a loop paced by round trips that never ends and never shows the player
 * anything. This stops it after a few, and says why on screen.
 */
export const MAX_RESYNCS_WITHOUT_PROGRESS = 3;

/**
 * `forge:join` or `forge:resync`, at most one in flight.
 *
 * The in-flight guard is the second line of defence behind the duplicate rule:
 * a long gap produces several out-of-order frames in a row, and one snapshot
 * answers all of them.
 */
function fetchSnapshot(match: LiveMatch, kind: 'join' | 'resync'): void {
  if (match.awaitingSnapshot) return;
  if (kind === 'resync') {
    if (match.resyncsWithoutProgress >= MAX_RESYNCS_WITHOUT_PROGRESS) {
      match.lastError = `stopped after ${MAX_RESYNCS_WITHOUT_PROGRESS} resyncs in a row that did not catch up — the server's snapshot cursor is behind its own stream`;
      return;
    }
    match.resyncsWithoutProgress += 1;
    match.stats.resyncsRequested += 1;
  } else {
    // A join starts over, so it also clears a tripped resync guard.
    match.resyncsWithoutProgress = 0;
    match.stats.joins += 1;
  }
  match.awaitingSnapshot = true;

  const event = kind === 'join' ? MATCH_EVENTS.join : MATCH_EVENTS.resync;
  match.transport.request(event, { matchId: match.matchId }, (err, response) => {
    match.awaitingSnapshot = false;
    if (err !== null) {
      snapshotFailed(match, `${event} was not answered: ${err.message}`);
      return;
    }
    const ack = parseMatchAck(response);
    if (!ack.ok) {
      match.stats.invalid += 1;
      match.lastInvalid = ack.errors;
      snapshotFailed(match, `${event} was answered with something that is not a snapshot`);
      return;
    }
    if ('error' in ack.value) {
      snapshotFailed(match, `${event} was refused: ${ack.value.error}`);
      return;
    }
    adoptSnapshot(match, ack.value);
  });
}

/**
 * A failed snapshot drops the buffer rather than replaying it: replaying would
 * re-trigger the resync that just failed, in a loop paced by the server's own
 * errors. The next live frame is what tries again.
 */
function snapshotFailed(match: LiveMatch, why: string): void {
  match.lastError = why;
  match.buffer = [];
  notify(match);
}

function adoptSnapshot(match: LiveMatch, snapshot: MatchSnapshot): void {
  if (snapshot.matchId !== match.matchId) {
    snapshotFailed(match, `asked for match ${match.matchId}, was sent a snapshot of ${snapshot.matchId}`);
    return;
  }
  match.seat = snapshot.seat;
  match.playerId = snapshot.playerId;
  match.cursor = snapshot.cursor;
  match.state = new Map();
  match.forgeSeq = 0;
  match.skippedDeltas = 0;
  // The server re-sends every open ask after the snapshot, as normal frames.
  match.asks = [];
  match.lastError = null;
  match.lastInvalid = null;
  foldFrames(match, snapshot.frames);
  match.stats.snapshots += 1;

  const held = match.buffer;
  match.buffer = [];
  notify(match);
  for (const raw of held) ingest(match, raw);
}

/* ── The state channel ───────────────────────────────────────────────── */

/**
 * The current state, as one packet of `newObjects`.
 *
 * `foldPackets` starts from nothing, and the fold's rules are `fold.ts`'s to
 * own — so rather than re-implementing them incrementally here, the state we
 * hold goes back in as the first packet and the new one is folded on top.
 * Rule 1 ("newObjects replace") makes that exact: every object is re-created
 * as it stands, in the order it stands.
 */
function statePacket(match: LiveMatch): WirePacket {
  return {
    seq: match.forgeSeq,
    checksum: 0,
    checksumProperties: [],
    newObjects: Object.fromEntries(match.state),
    objectDeltas: {},
    events: [],
  };
}

/**
 * Fold the state-channel frames among `frames` into `match`, and redraw.
 *
 * `setGameView` is a full baseline and REPLACES what came before it;
 * `applyDelta` folds on top. `openView` names the seats this client controls,
 * which the snapshot already said — a disagreement is an identity bug on the
 * server, and is surfaced rather than silently resolved either way.
 */
function foldFrames(match: LiveMatch, frames: readonly ServerFrame[]): void {
  let packets: unknown[] = match.state.size > 0 ? [statePacket(match)] : [];
  let changed = false;
  for (const frame of frames) {
    if (frame.method === 'setGameView') {
      const { gameView, sequenceNumber } = frame.payload;
      packets = [
        { seq: sequenceNumber, checksum: 0, checksumProperties: [], newObjects: gameView, objectDeltas: {}, events: [] },
      ];
      changed = true;
    } else if (frame.method === 'applyDelta') {
      packets.push(frame.payload.packet);
      changed = true;
    } else if (frame.method === 'openView') {
      const mine = frame.payload.myPlayers;
      if (match.playerId !== null && !mine.includes(match.playerId)) {
        match.lastError = `openView names players ${mine.join(', ')}, but the snapshot seated this client as player ${match.playerId}`;
      }
    }
  }
  if (!changed) {
    redraw(match);
    return;
  }
  // The boundary check the fixture path uses, on the live path too: the fold
  // is handed the same structure whichever source produced it.
  const folded = foldPackets(expectWirePackets(packets, `match ${match.matchId}`));
  match.state = folded.state;
  match.forgeSeq = folded.seq;
  match.skippedDeltas += folded.skippedDeltas;
  redraw(match);
}

function redraw(match: LiveMatch): void {
  match.view =
    match.playerId === null || match.state.size === 0
      ? null
      : toBoardView(match.state, match.forgeSeq, { viewerPlayerId: match.playerId });
}

/* ── Inbound ─────────────────────────────────────────────────────────── */

/** An ask that failed to parse still has to be answered, if it can be addressed. */
function callIdOf(frame: unknown): string | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const f = frame as { kind?: unknown; callId?: unknown };
  return f.kind === 'ask' && typeof f.callId === 'string' && f.callId !== '' ? f.callId : null;
}

/**
 * One inbound `forge:s2c` payload.
 *
 * Exported because this, not socket.io, is the thing worth testing: hand it
 * frames in any order and the driver has to behave.
 */
export function ingest(match: LiveMatch, raw: unknown): void {
  if (match.awaitingSnapshot) {
    match.buffer.push(raw);
    match.stats.buffered += 1;
    return;
  }

  const envelope = parseServerEnvelope(raw);
  if (!envelope.ok) {
    // No cursor we can trust, so no position in the stream: counted, dropped.
    match.stats.invalid += 1;
    match.lastInvalid = envelope.errors;
    notify(match);
    return;
  }
  const { matchId, cursor, frame: rawFrame } = envelope.value;
  if (matchId !== match.matchId) {
    match.stats.invalid += 1;
    match.lastInvalid = [{ path: '$.matchId', message: `a frame for match ${matchId} reached match ${match.matchId}` }];
    notify(match);
    return;
  }

  const verdict = classifySeq(match.cursor === null ? null : asSeqCursor(match.cursor), asSeqCursor(cursor));
  match.lastVerdict = verdict;

  if (verdict === 'duplicate') {
    // Drop. No resync, and no re-applying a delta we already folded.
    match.stats.duplicatesDropped += 1;
    notify(match);
    return;
  }
  if (verdict === 'epoch-change') {
    // A different match process. The cursor is meaningless across epochs, and
    // so is every object we hold — discard first, then refetch.
    match.stats.epochChanges += 1;
    discardLocal(match);
  } else if (verdict === 'gap') {
    match.stats.gaps += 1;
  }
  if (needsResync(verdict)) {
    fetchSnapshot(match, 'resync');
    notify(match);
    return;
  }

  const parsed = safeParseServerFrame(rawFrame);
  if (!parsed.ok) {
    // Its position is known and its content is not, so the state we hold is
    // now behind the server's. Do NOT advance the cursor; resync. An ask that
    // cannot be read is still answered, or Forge waits on it forever.
    match.stats.invalid += 1;
    match.lastInvalid = parsed.errors;
    const callId = callIdOf(rawFrame);
    if (callId !== null) sendAbort(match, callId, 'unsupported', 'the ask did not parse on this client');
    fetchSnapshot(match, 'resync');
    notify(match);
    return;
  }

  match.cursor = cursor;
  match.stats.applied += 1;
  match.resyncsWithoutProgress = 0;
  applyFrame(match, parsed.value);
  notify(match);
}

function applyFrame(match: LiveMatch, frame: ServerFrame): void {
  if (frame.kind === 'ask') {
    // Queued, never replacing another: see the module header. The same callId
    // twice (a re-send) updates its entry in place rather than queueing twice.
    const i = match.asks.findIndex((a) => a.callId === frame.callId);
    if (i < 0) match.asks.push(frame);
    else match.asks[i] = frame;
    return;
  }
  if (frame.kind === 'notify' && frame.method === 'showPromptMessage') {
    match.prompt = typeof frame.message === 'string' ? frame.message : null;
  } else if (frame.kind === 'notify' && frame.method === 'updateButtons') {
    match.buttons = {
      label1: typeof frame.label1 === 'string' ? frame.label1 : 'OK',
      label2: typeof frame.label2 === 'string' ? frame.label2 : 'Cancel',
      enable1: frame.enable1 === true,
      enable2: frame.enable2 === true,
    };
  }
  foldFrames(match, [frame]);
}

function discardLocal(match: LiveMatch): void {
  match.cursor = null;
  match.state = new Map();
  match.forgeSeq = 0;
  match.skippedDeltas = 0;
  match.view = null;
  match.asks = [];
  match.prompt = null;
  match.buttons = null;
}
