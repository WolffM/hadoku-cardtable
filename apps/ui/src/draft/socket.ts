/*
 * A draft driven by a server, over socket.io.
 *
 * This is the third source, beside `fixtures.ts` and `live.ts`, and it is
 * deliberately shaped like `live.ts`: `startDraft`, `applyPick`, `isComplete`,
 * `myPool`. `DraftScreen` cannot tell which one is driving it, which is the
 * property the fixture lane was built to preserve and the reason this file is
 * ~300 lines instead of a rewrite of the UI.
 *
 * **`live.ts` stays.** It is how a draft is testable without a server, and it
 * is how a rendering regression gets bisected against a source that cannot
 * have a network bug. Nothing here replaces it.
 *
 * ## The one thing that is genuinely different: time
 *
 * `live.ts` is synchronous — `applyPick` returns the next view. Here the next
 * view arrives later, or not at all, and `applyPick` only emits. That
 * difference is absorbed in `App.tsx`, not in `DraftScreen`'s props: the screen
 * still takes a `TableState` and an `onPick`, and the harness decides when it
 * has one to give.
 *
 * ## The base path, which is the failure nobody can read
 *
 * The browser is at `hadoku.me/cardtable/`. The edge strips `/cardtable` before
 * the server sees anything, so the server's socket.io endpoint is the default
 * `/socket.io/` — but the CLIENT must ask for `/cardtable/socket.io/` or the
 * edge routes the handshake somewhere that is not this app. A wrong path here
 * is a blank page and a 404 in a console nobody is looking at, which is exactly
 * what `apps/server/src/base-path.ts` was written about. `socketPath()` derives
 * it from `import.meta.env.BASE_URL`, which `vite.config.ts` sets to
 * `/cardtable/`, so the prefix is declared once.
 *
 * ## Sequencing: `classifySeq`, and the duplicate rule in particular
 *
 * Every inbound envelope is classified against the last one applied. `ok`
 * applies, `gap` asks for a resync, `epoch-change` discards local state and
 * refetches — and `duplicate` DROPS, silently, without asking for anything.
 * That last one is not an optimisation. Retransmits arrive in bursts, so a
 * client that resynced on "anything that isn't ok" would answer a burst with a
 * request storm, aimed at the server that is already struggling enough to be
 * retransmitting. `needsResync(verdict)` is the helper that gets this right;
 * `verdict !== 'ok'` is the bug it exists to prevent, and it is never spelled
 * that way in this file.
 *
 * ## A gap is only a loss in a delta stream
 *
 * `classifySeq` models a delta stream, where a skipped seq is missing
 * information. An update marked `carries: 'full-state'` is not a delta: it is
 * the whole table, and the seqs it skipped are superseded by it. So a `gap`
 * verdict on one is still counted — `classifySeq` is not overruled about what
 * happened — but the envelope is applied rather than dropped for a resync.
 * The room sends exactly that after every pick, because the bots behind a
 * human pick move `seq` by several in one step; before this the recovery path
 * was the normal path, one resync per round.
 *
 * `epoch-change` is NOT bridged, whatever the envelope says: a different room
 * incarnation still discards everything local and refetches. And an unmarked
 * (or `delta`) update with a gap still resyncs exactly as before.
 */

import {
  DRAFT_CHANNEL,
  asSeqCursor,
  carriesView,
  cursorOf,
  joinDraft,
  leaveDraft,
  pickCard,
  resyncRequest,
  safeParseServerMessage,
  type CubeMeta,
  type DraftCard,
  type DraftStateMessage,
  type DraftUpdateMessage,
  type DraftView,
  type ValidationFailure,
  type WireCursor,
  type WireError,
} from '@hadoku/shared';
import { classifySeq, needsResync, type SeqVerdict } from '@wolffm/rooms-protocol';
import { io } from 'socket.io-client';

import type { ConnectionFacts } from './connection.ts';

/**
 * The transport seam.
 *
 * Three methods, which is all socket.io is used for here. The driver is tested
 * against a stub implementing exactly this — there is no server to talk to
 * while this is being written, and testing socket.io is not our job anyway.
 * What is our job is the dispatch, and the dispatch is above this line.
 */
export interface DraftTransport {
  on(event: string, handler: (payload: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  disconnect(): void;
}

/** Counters, so the sequencing rules can be asserted rather than believed. */
export interface SocketStats {
  /** Envelopes whose payload was applied. */
  applied: number;
  /** Dropped as already-seen. These must NEVER produce a resync. */
  duplicatesDropped: number;
  /** `gap` verdicts, whether or not they cost a resync. */
  gaps: number;
  /** Of those, the ones a full-state envelope carried across with no request. */
  gapsBridged: number;
  epochChanges: number;
  /** Resync requests actually put on the wire. The number the tests assert. */
  resyncsRequested: number;
  /** Rejections received from the server. */
  rejected: number;
  /** Envelopes that did not parse. Counted, never applied. */
  invalid: number;
  /** Join messages sent, including re-joins after a reconnect. */
  joins: number;
}

export interface SocketDraft {
  readonly draftId: string;
  /** The last payload applied, or null before the first snapshot. */
  view: DraftView | null;
  /** Where we are in the stream. Null means "nothing applied yet". */
  cursor: WireCursor | null;
  /** What the server said this draft is being drafted from, if it said. */
  cube: CubeMeta | null;
  /** The most recent rejection. Cleared when a payload applies. */
  lastError: WireError | null;
  /** Why the most recent malformed envelope was refused. */
  lastInvalid: ValidationFailure[] | null;
  /** The verdict on the most recent envelope. Diagnostic. */
  lastVerdict: SeqVerdict | null;
  connected: boolean;
  stats: SocketStats;
  /** Bumped on every observable change, so React has something to key on. */
  revision: number;
  /* Internals. Not part of the surface `live.ts` shares. */
  transport: DraftTransport;
  resyncPending: boolean;
  onChange: ((draft: SocketDraft) => void) | null;
  everConnected: boolean;
  /**
   * `stats.applied` as it stood when the most recent RE-join went out.
   *
   * The one piece of state added for the connection banner, and it is a
   * sample rather than a new fact: `stats.applied - appliedAtLastJoin` is
   * "has anything arrived since we came back", which no single existing
   * counter answers and which is the difference between telling a player
   * "reconnected, waiting" and "reconnected, you are back". See
   * `connection.ts`. Zero until a reconnect happens.
   */
  appliedAtLastJoin: number;
}

export interface SocketDraftOptions {
  draftId: string;
  /** Defaults to a real socket.io connection. Tests pass a stub. */
  transport?: DraftTransport;
  /** Called after every observable change. */
  onChange?: (draft: SocketDraft) => void;
}

/* ── The socket.io path ──────────────────────────────────────────────── */

/**
 * `/cardtable/` → `/cardtable/socket.io/`.
 *
 * Pure, and tested as such, because the value it produces is only observable
 * in a browser against a live edge — which is the definition of a thing that
 * gets shipped wrong.
 */
export function socketPath(base: string): string {
  const prefix = base === '' ? '/' : base;
  return `${prefix.endsWith('/') ? prefix : `${prefix}/`}socket.io/`;
}

/** The path for THIS bundle, from the base Vite was built with. */
export function defaultSocketPath(): string {
  const base = import.meta.env?.BASE_URL;
  return socketPath(typeof base === 'string' ? base : '/');
}

/**
 * A real socket.io connection, same origin.
 *
 * Same origin on purpose: the app is served by the very server it talks to,
 * behind the friend gate, and a cross-origin socket would need the gate's
 * headers carried by hand.
 */
export function socketIoTransport(path: string = defaultSocketPath()): DraftTransport {
  // Default transports (long-polling, upgrading to websocket) rather than
  // websocket-only: the edge in front of this app is not ours to assume about,
  // and a failed upgrade degrades instead of failing to connect at all.
  const socket = io({ path });

  // socket.io's event map is typed for apps that declare their events to it.
  // Ours are declared in `@hadoku/shared` and validated with Zod on arrival, so
  // the honest static type for a payload here is `unknown`.
  const raw = socket as unknown as {
    on(event: string, handler: (payload?: unknown) => void): void;
    emit(event: string, payload: unknown): void;
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
    disconnect: () => {
      raw.disconnect();
    },
  };
}

/* ── The driver ──────────────────────────────────────────────────────── */

function emptyStats(): SocketStats {
  return {
    applied: 0,
    duplicatesDropped: 0,
    gaps: 0,
    gapsBridged: 0,
    epochChanges: 0,
    resyncsRequested: 0,
    rejected: 0,
    invalid: 0,
    joins: 0,
  };
}

function notify(draft: SocketDraft): void {
  draft.revision += 1;
  draft.onChange?.(draft);
}

function send(draft: SocketDraft, message: unknown): void {
  draft.transport.emit(DRAFT_CHANNEL.clientToServer, message);
}

/**
 * Connect, join, and start listening.
 *
 * The join goes out immediately — socket.io buffers an emit made before the
 * handshake completes — and again on any RECONNECT, which is what returns a
 * refreshed browser to its seat. The first `connect` event is not a re-join:
 * the buffered one already covered it, and joining twice would have the server
 * answer with two snapshots for no reason.
 */
export function startDraft(options: SocketDraftOptions): SocketDraft {
  const draft: SocketDraft = {
    draftId: options.draftId,
    view: null,
    cursor: null,
    cube: null,
    lastError: null,
    lastInvalid: null,
    lastVerdict: null,
    connected: false,
    stats: emptyStats(),
    revision: 0,
    transport: options.transport ?? socketIoTransport(),
    resyncPending: false,
    onChange: options.onChange ?? null,
    everConnected: false,
    appliedAtLastJoin: 0,
  };

  draft.transport.on(DRAFT_CHANNEL.serverToClient, (payload) => {
    ingest(draft, payload);
  });

  draft.transport.on('connect', () => {
    const rejoin = draft.everConnected;
    draft.connected = true;
    draft.everConnected = true;
    if (rejoin) {
      // A reconnect means the server may have missed our whole session. Ask to
      // be seated again; its answer is a full snapshot, which re-baselines the
      // cursor without a resync request.
      draft.resyncPending = false;
      draft.stats.joins += 1;
      // Sampled BEFORE the join goes out, so the snapshot that answers it is
      // counted as "arrived since we came back".
      draft.appliedAtLastJoin = draft.stats.applied;
      send(draft, joinDraft(draft.draftId));
    }
    notify(draft);
  });

  draft.transport.on('disconnect', () => {
    draft.connected = false;
    notify(draft);
  });

  draft.stats.joins += 1;
  send(draft, joinDraft(draft.draftId));
  return draft;
}

/**
 * Take a card.
 *
 * Emits and returns; the new state arrives as an envelope. `DraftScreen`
 * already shows the pick as pending until a payload lands (see `table.ts`), so
 * the round trip is visible rather than papered over with a guess about what
 * the next pack will be.
 *
 * Returns the same handle so the call site reads like `live.ts`'s.
 */
export function applyPick(draft: SocketDraft, cardId: string): SocketDraft {
  send(draft, pickCard(draft.draftId, cardId));
  return draft;
}

/**
 * Whether the draft has run out of picks.
 *
 * Derived rather than carried: the envelope describes a draft's position, and
 * a seat that has taken every card there is to take is done. `packCount *
 * packSize` is the whole draft — 3 × 15 = 45 for a standard pod. A spectator
 * cannot answer this and gets `false`.
 */
export function isComplete(draft: SocketDraft): boolean {
  const view = draft.view;
  if (view === null || view.viewer.kind !== 'seat') return false;
  return view.viewer.pool.length >= view.packCount * view.packSize;
}

/** Every card this client has taken, in pick order. Empty before the snapshot. */
export function myPool(draft: SocketDraft): DraftCard[] {
  const view = draft.view;
  if (view === null || view.viewer.kind !== 'seat') return [];
  return view.viewer.pool;
}

/** Which cube, if the server named one. `live.ts`'s `CUBE_NAME`, over a wire. */
export function cubeName(draft: SocketDraft): string | null {
  return draft.cube?.name ?? null;
}

/** How big that cube is, if the server named one. `live.ts`'s `CUBE_SIZE`. */
export function cubeSize(draft: SocketDraft): number | null {
  return draft.cube?.size ?? null;
}

/** The seat this client is sitting in, or null while spectating or waiting. */
export function mySeat(draft: SocketDraft): number | null {
  const view = draft.view;
  if (view === null || view.viewer.kind !== 'seat') return null;
  return view.viewer.seatId;
}

/**
 * The driver's own account of what its connection is doing.
 *
 * Every field is read straight off the handle — this adds no state, it only
 * puts the ones `connection.ts` needs in one place so a component never has to
 * reach into `stats` itself.
 */
export function connectionFacts(draft: SocketDraft): ConnectionFacts {
  return {
    connected: draft.connected,
    everConnected: draft.everConnected,
    joins: draft.stats.joins,
    applied: draft.stats.applied,
    appliedAtLastJoin: draft.appliedAtLastJoin,
    resyncPending: draft.resyncPending,
    seatId: mySeat(draft),
    lastVerdict: draft.lastVerdict,
  };
}

/** Leave the draft and hang up. The seat reservation TTL decides the rest. */
export function closeDraft(draft: SocketDraft): void {
  send(draft, leaveDraft(draft.draftId));
  draft.transport.disconnect();
  draft.connected = false;
  notify(draft);
}

/* ── Inbound ─────────────────────────────────────────────────────────── */

function adopt(draft: SocketDraft, msg: DraftStateMessage | DraftUpdateMessage): void {
  draft.view = msg.view;
  draft.cursor = cursorOf(msg.view);
  draft.lastError = null;
  draft.lastInvalid = null;
  draft.resyncPending = false;
  if (msg.type === 'state' && msg.cube !== undefined) draft.cube = msg.cube;
  draft.stats.applied += 1;
}

/** Throw away everything local. Only an epoch change justifies this. */
function discardLocal(draft: SocketDraft): void {
  draft.view = null;
  draft.cursor = null;
  draft.cube = null;
}

/**
 * Ask for the whole state, at most once per outstanding request.
 *
 * The in-flight guard is a second line of defence behind the duplicate rule: a
 * long gap can produce several out-of-order envelopes in a row, and one resync
 * answers all of them. It clears when a payload applies, so a lost request is
 * retried by the next envelope rather than never.
 */
function requestResync(draft: SocketDraft): void {
  if (draft.resyncPending) return;
  draft.resyncPending = true;
  draft.stats.resyncsRequested += 1;
  send(draft, resyncRequest(draft.draftId, draft.cursor));
}

/**
 * One inbound envelope.
 *
 * Exported because this, not socket.io, is the thing worth testing: hand it
 * envelopes in any order and the driver has to behave.
 */
export function ingest(draft: SocketDraft, raw: unknown): void {
  const parsed = safeParseServerMessage(raw);
  if (!parsed.ok) {
    // Junk, or a payload that broke a payload rule — a leaked seat, an image
    // URL. Counted and kept for display, never applied. The server is not
    // trusted more than a fixture is.
    draft.stats.invalid += 1;
    draft.lastInvalid = parsed.errors;
    notify(draft);
    return;
  }

  const msg = parsed.value;
  const verdict = classifySeq(draft.cursor, asSeqCursor(msg.cursor));
  draft.lastVerdict = verdict;

  if (!carriesView(msg)) {
    // A rejection carries a cursor so one handler can classify every envelope,
    // but it does not ADVANCE the stream — it is stamped with the state it was
    // evaluated against. So it is surfaced and the stream is left alone. In
    // particular it never asks for a resync: an error that did would let a
    // rate-limited client answer its own rate limit with more traffic.
    draft.lastError = msg.error;
    draft.stats.rejected += 1;
    notify(draft);
    return;
  }

  if (verdict === 'duplicate') {
    // Drop. No resync, and no clobbering newer state with an older snapshot.
    draft.stats.duplicatesDropped += 1;
    notify(draft);
    return;
  }

  if (verdict === 'epoch-change') {
    // A different draft incarnation. Everything local is about a draft that no
    // longer exists, including the cursor, so comparing sequence numbers to it
    // is meaningless — discard first, then refetch.
    draft.stats.epochChanges += 1;
    discardLocal(draft);
  } else if (verdict === 'gap') {
    draft.stats.gaps += 1;
  }

  if (msg.type === 'state') {
    // A snapshot IS the baseline, whatever the verdict said — see
    // `resync.d.ts`: a client that has missed everything is established by its
    // snapshot, not by another request. Answering a snapshot with a resync is
    // how a loop starts.
    adopt(draft, msg);
    notify(draft);
    return;
  }

  if (verdict === 'gap' && msg.carries === 'full-state') {
    // The whole table, so the skipped seqs are superseded, not lost. Only a
    // gap is bridged this way — an epoch change fell through to the resync
    // below, because a restarted room is not made safe by a complete payload.
    draft.stats.gapsBridged += 1;
    adopt(draft, msg);
    notify(draft);
    return;
  }

  if (needsResync(verdict)) {
    requestResync(draft);
    notify(draft);
    return;
  }

  adopt(draft, msg);
  notify(draft);
}
