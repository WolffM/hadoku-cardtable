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
 * All fifteen blocking methods have a component — `showConfirmDialog` drawn
 * by `../prompts/ConfirmPrompt.tsx` straight from `LiveBoard.tsx`, the other
 * fourteen dispatched through `../prompts/`'s own table — so an ask is
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
 * ## Clicking the board: Forge's inputs, never our rules
 *
 * Playing a land, casting a spell, choosing a target, declaring an attacker:
 * on Forge's side each is an `Input` (`forge-gui/.../match/input/`) that takes
 * `selectCard` / `selectPlayer` and decides for itself what a click means.
 *
 * **Nothing is offered that Forge did not name.** Until Wave 19 this file
 * offered every card in view whenever `setSelectables` was silent, and the
 * operator hit it at once: *"why are cards clickable when i can't even do
 * anything with them?"* The blue outline was ours, not the rules engine's.
 *
 * Forge names entities through THREE wire methods. The first two were said to
 * cover every input; Wave 22 found the input they do not (below):
 *
 *  - **a selection** — `InputSelectTargets` (`:68`, `:454`) and
 *    `InputSelectEntitiesFromList` (`:57`, `:171`) — calls
 *    `setSelectables(cards, min, max)` when it starts and `clearSelectables()`
 *    when it stops. Exactly those cards, with the count Forge wants.
 *  - **everything else** — priority, mana payment, declaring attackers and
 *    blockers — calls `setWeaklySelectable(cards)` / `clearWeaklySelectable()`
 *    through `PlayerControllerHuman.pushActionableCards`
 *    (`PlayerControllerHuman.java:1543-1601`), computed from
 *    `AvailableActions.collectActionable` at priority and from
 *    `cardHasPlayableManaAbility` during payment, and cleared by every such
 *    input's `onStop` (`InputPassPriority.java:70`, `InputPayMana.java:69`,
 *    `InputAttack.java:101`, `InputBlock.java:96`).
 *  - **a mark** — `setHighlighted(entities, on)`, incremental and signed, for
 *    the entities an input is already tracking: the targets chosen so far
 *    (`InputSelectManyBase.java:127`, `InputSelectTargets.java:409`), the cards
 *    set aside for a London mulligan (`InputLondonMulligan.java:138`). Added by
 *    Wave 22 lane L. A mark is NOT an offer, and `boardInteraction` keeps the
 *    two apart — read its header before touching that.
 *
 * When Forge has named none of them, the board offers **nothing**. We implement
 * no rules: every id `boardInteraction` returns came off one of those frames.
 *
 * ### The input the first two do not cover
 *
 * `InputLondonMulligan` publishes no selectable set and no actionable set —
 * `setSelectables` has exactly two call sites and `setWeaklySelectable` four,
 * and none of the six is that input. It speaks per-card only through
 * `setHighlighted`. So the seat got the prose, the OK/Auto bar and no entity at
 * all, which is what the operator reported: *"mulligan said 'return a card to
 * the bottom' and the cards were not clickable — had to press Auto."*
 *
 * Carrying the mark is what lets that seat UN-mark a card it marked. It does
 * not by itself make the FIRST card clickable, because Forge marks a card only
 * after a click it accepted (`InputLondonMulligan.onCardSelected`, `:112-123`).
 * The signal for that first click is `GameView`'s `Mulligan` flag
 * (`GameView.java:141-146`, set at `InputLondonMulligan.java:60` and cleared at
 * `:105`), which rides the state channel we already fold (`tier-c.ts`,
 * `Mulligan: 'BooleanType'`; the server's projection passes a `GameView` through
 * whole — `visibility.ts`'s `projectObject` redacts cards and card states and
 * nothing else). `mulliganHand` reads it, and its header is where the argument
 * that this transcribes Forge rather than inventing a rule is written down.
 *
 * ### The input the offered set does not cover either: blocking
 *
 * Wave 24 §B.3 found the same shape once more. `InputBlock.onCardSelected`
 * takes a click on any ATTACKING card and makes it the current attacker
 * (`InputBlock.java:112-115`), but `pushBlockerCandidates` publishes only the
 * defender's own creatures (`PlayerControllerHuman.java:1621-1647`) — so the
 * attacker was never in the offered set and every drop on one was silently
 * refused. `blockTargets` transcribes `combat.isAttacking`, which has been on
 * the state channel as the card's `Attacking` property all along, and gates it
 * on the two facts that identify the input rather than on its prose. Its own
 * header carries the argument.
 *
 * The SECOND click is missing the same way: `InputBlock` undoes a block when
 * the click lands on a creature already blocking the current attacker
 * (`InputBlock.java:132-146`, "lblRemoveFromCombat"), but
 * `pushBlockerCandidates` offers only LEGAL blocks for the current attacker
 * and drops a creature once it is already assigned to one — so the undo
 * click had nowhere to land either. `declaredBlockers` offers it back, off
 * the SAME wire fact `gestures/install.ts`'s `blockArrows` draws from: the
 * planned map (`adapter.ts`'s `CombatBand.plannedBlockers`).
 *
 * ### Players
 *
 * Forge publishes no per-player legality signal at all — `setSelectables`
 * carries cards only (IGuiGame.java:272), and `InputSelectTargets` validates a
 * player only once it has been clicked (`:334-360`). What it does say is which
 * INPUT is live, and `selectPlayer` reaches an input that does something with
 * it in exactly one published case: `Input.onPlayerSelected` is a no-op by
 * default (`InputBase.java:116`) and the two inputs that override it and
 * publish a set are the two SELECTION inputs
 * (`InputSelectTargets.java:334`, `InputSelectEntitiesFromList.java:97`). So
 * players are offered while a selection is live and at no other time. (The
 * other two overrides, `InputAttack.java:169` and
 * `InputPayManaOfCostPayment.java:44`, publish `setWeaklySelectable`, which
 * the priority input publishes too — there is nothing on the wire that tells
 * them apart, and inventing one is exactly what this rewrite removes.)
 *
 * What keeps a click from answering the wrong question is the button bar's
 * rule, applied per card: **a click is checked against Forge's state when it
 * is made, and the card it sent is not clickable again until Forge speaks.**
 *
 *  - `inputLive` is set by the frames Forge sends when an input shows itself
 *    (`showPromptMessage`, `updateButtons`, `setSelectables`,
 *    `setWeaklySelectable`) and cleared by `clearSelectables` (the input that
 *    listed the cards has stopped), by a button press, by a snapshot and by an
 *    epoch change. While it is clear, or while a question is open, NO click is
 *    sent.
 *  - A click on an id Forge did not offer — one a cleared or replaced
 *    selection used to hold, one no longer on the board — is not sent.
 *  - A card or player once clicked is `spent` until Forge's next frame of
 *    those kinds, so a double click cannot reach the NEXT input (a land
 *    clicked twice would be played, then tapped for mana).
 *
 * Why a click does not spend the whole input, as a button press does:
 * measured against the real jar (`./board-play.jvm.test.ts`), a click the
 * input ignores gets NO frame back at all (`InputPassPriority.onCardSelected`
 * returns false and shows nothing). A board that locked on every click would
 * lock for good on a misclick, with only "pass priority" left to press.
 *
 * ## Dragging, and the targeter arrow
 *
 * Both are `LiveBoard.tsx`'s, and both end in the SAME two senders as a click.
 * A drag from a source to a legal drop target is `selectCard(source)` then
 * `selectCard`/`selectPlayer` on the target; a drag that ends nowhere legal
 * sends nothing. There is no wire method for a drag, because there is no such
 * thing on Forge's side — a gesture is two clicks or it is nothing.
 *
 * ## The says: `message` frames are display, never input
 *
 * Forge's Tier-A `message` notify is how the server says a thing to this seat
 * with no question attached. Wave 19 lane C made that load-bearing: every stop
 * passed for the player ("auto-passed Upkeep step") and every payment
 * ("paid U — Volcanic Island") arrives as one, because an auto-pass nobody
 * can see is indistinguishable from a board that froze. The client holds the
 * whole game, generously bounded (`SAYS_KEPT`), and `LiveBoard` draws them.
 *
 * The rule that keeps this honest: **a `message` frame changes nothing but the
 * log.** It is not an input frame — it does not set `inputLive`, does not
 * unspend, does not touch a selection, answers nothing. A say never makes a
 * card clickable, which is the whole of §B item 1's discipline.
 *
 * A snapshot CLEARS the log, exactly as it clears asks and selections: the
 * server re-sends its kept says after the snapshot as ordinary frames, so the
 * lines come back — and a line held from before the snapshot is not trusted
 * for the same reason a selection held from before is not.
 *
 * ## Full control
 *
 * The seat's escape hatch (§C.4): `forge:full-control` turns lane C's
 * auto-pass and single-answer shortcuts off for this seat, and back on. It is
 * a preference, not a frame — it goes on its own event, and `setFullControl`
 * is the one sender.
 *
 * **The event travels both ways, and the server has the last word.** After
 * every snapshot the server emits the seat's CURRENT state back on the same
 * event with the same payload (`apps/server/src/play/socket.ts`, right after
 * `resendAfterSnapshot`), and this client adopts it. That is what makes a
 * refresh keep full control: a fresh page starts with the flag off, joins, and
 * is told. It is not in `MatchSnapshot` because the snapshot's schema is
 * mirrored in two packages and this event was already there — see
 * `./transport.ts`.
 *
 * The flag is therefore the server's word where the server has spoken, and
 * this client's own last word in between (the send is optimistic: the server
 * logs a refusal rather than answering one).
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

import type { Placement } from '@hadoku/shared';
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
import { normalizeAvatarId } from '../../room/avatar.ts';
import { toBoardView, type BoardView } from '../adapter.ts';
import { foldPackets, type WireState } from '../fold.ts';
import { expectWirePackets, WireType, type WirePacket } from '../wire.ts';
import {
  abortFrame,
  autoYieldFrame,
  FullControlSchema,
  fullControlFrame,
  MATCH_EVENTS,
  parseMatchAck,
  parseMatchRole,
  parseMatchSeats,
  parseServerEnvelope,
  replyFrame,
  stopPreferenceFrame,
  type ClientEnvelope,
  type MatchSnapshot,
  type TransportIssue,
  type WireCursor,
} from './transport.ts';

/**
 * The title of the server's ending notice (`MATCH_ENDED_TITLE` in
 * `apps/server/src/play/match.ts`, which this mirrors — the two packages share
 * no module).
 */
const MATCH_ENDED_TITLE = 'Match ended';

/** Any blocking ask, as parsed. */
export type LiveAsk = Extract<ServerFrame, { kind: 'ask' }>;

/** The ask `../prompts/ConfirmPrompt.tsx` draws for `LiveBoard.tsx`. */
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

/**
 * How many `message` lines this client holds — a log of the whole game,
 * bounded only so the CLIENT's own memory stays finite over a long one.
 *
 * This used to equal the server's own per-seat cap (`apps/server/src/play/match.ts`'s
 * `SAYS_KEPT`) on purpose, so a snapshot's clear-and-re-send reproduced the log
 * it cleared exactly. That coupling is gone: the two numbers answer different
 * questions now (how much the server re-sends on a resync vs. how much the
 * client keeps once it has it), so this is free to be generous.
 *
 * The server's own cap still governs what a RECONNECT refills with — this
 * constant only bounds what already arrived, never the catch-up a resync
 * sends. A seat that reconnects after a long game sees its history drop to
 * whatever the server resends, which is unrelated to the number here.
 */
export const SAYS_KEPT = 2000;

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

/**
 * Forge's `setSelectables(cards, min, max)`: the cards its current selection
 * will take, and how many it needs. REPLACED by the next set, dropped by
 * `clearSelectables`.
 */
export interface LiveSelectables {
  cards: ReadonlySet<number>;
  min: number;
  max: number;
  /** The players this selection accepts, from the bridge; null when it could not tell (then every player is offered). */
  players: ReadonlySet<number> | null;
}

/** What the board may click right now — `Board`'s `BoardInteraction`, without the callbacks. */
export interface LiveClickables {
  selectable: ReadonlySet<number>;
  selectablePlayers: ReadonlySet<number>;
  /**
   * Forge has an OPEN SELECTION — `setSelectables` without its `clearSelectables`
   * yet. Exactly `match.selectables !== null`, and nothing else.
   *
   * It exists so lane A's arrange gesture (§A.1) can stand down while Forge is
   * asking without `Board.tsx` reasoning about Forge's inputs itself. It is NOT
   * the same question as `selectable.has(id)`: at ordinary priority Forge names
   * most of a player's own permanents through the ACTIONABLE set — *"you could
   * do something with this"* — and standing arranging down for those is what
   * turned `e2e/table-fit.spec.ts` red. An open selection is Forge asking.
   *
   * It is deliberately independent of whether anything is clickable right now:
   * a queued ask or a dropped socket makes `selectable` empty while the
   * selection is still the input Forge is parked on.
   */
  selectionOpen: boolean;
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
  /**
   * The CARD `showPromptMessage` named, or null — Forge's third argument
   * (`IGuiGame.java:77`, `ProtocolMethod.java:39`), on our wire since the bridge
   * was written (`PlayBridge.java:737-742`, and `serializeNulls` there exists
   * precisely so this key survives as a null).
   *
   * We parsed it and threw it away until wave 24. It is the one part of an input's
   * announcement that is FRESH: it arrives with the prompt, in the same frame,
   * whereas Forge's button bar is emitted BEFORE the prompt and so lags it — lane
   * E measured a priority prompt arriving under a stale Yes/No bar against the
   * real jar. `payingMana` is built on that difference.
   */
  promptCard: number | null;
  buttons: LiveButtons | null;
  /** Forge's current selection, from `setSelectables`. Null: none is open. */
  selectables: LiveSelectables | null;
  /**
   * The last few things SAID to this seat — `message` notifies: what was
   * auto-passed, what a cast paid. Display only; see the module header.
   * Newest last, capped at `SAYS_KEPT`.
   */
  says: string[];
  /**
   * Forge's current actionable set, from `setWeaklySelectable` — what the
   * input that is live right now will do something with. Null: Forge has named
   * nothing (it never has, or `clearWeaklySelectable` ended the last set).
   *
   * An EMPTY set is not null and does not mean the same thing: it is Forge
   * saying "nothing on this board is worth clicking", which is the answer at a
   * priority window with no legal action.
   */
  weaklySelectable: ReadonlySet<number> | null;
  /**
   * Wave 53 T: w52 §S's `manaOnly`, carried on the SAME `setWeaklySelectable`
   * frame (`packages/forge-wire/src/tier-b.ts`) — the offered cards whose
   * every playable ability is a mana ability (a land, or a mana rock like a
   * Signet), read by the bridge off Forge's abilities, never card text.
   * `null` the same way `weaklySelectable: null` is: Forge has not said (the
   * field was absent on the frame, or the set was last cleared) — never an
   * empty set standing in for "nothing here is mana-only". Read by
   * `nothingToDecide`, below, folded in alongside the viewer's own
   * battlefield lands.
   */
  weaklySelectableManaOnly: ReadonlySet<number> | null;
  /**
   * The CARDS Forge's current input has marked, from `setHighlighted` — folded,
   * because that frame is incremental: `on: true` adds, `on: false` removes
   * (`AbstractGuiGame.java:322-337`). Null: Forge has never marked anything
   * since the last `clearSelectables`.
   *
   * Cards only. The frame carries players too, and they are dropped here on
   * purpose: the player rule below is Forge's published one — a player is
   * offered while a SELECTION is live and at no other time — and a highlight
   * is not that signal. See `boardInteraction`.
   */
  highlighted: ReadonlySet<number> | null;
  /**
   * The PLAYERS Forge's current input has marked — the other half of the same
   * `setHighlighted` fold. Never a clickability signal (see `highlighted`): it
   * answers only "has Forge applied my click yet", which `afterMarked` needs.
   */
  highlightedPlayers: ReadonlySet<number> | null;
  /**
   * Forge has shown an input since this client last acted. See the module
   * header: without it, no card or player click is sent.
   */
  inputLive: boolean;
  /** Cards and players clicked since Forge last spoke — not clickable again until it does. */
  spent: { cards: Set<number>; players: Set<number> };
  /**
   * The attackers this seat has POINTED AT, and the turn it pointed in.
   *
   * Wave 24 §B.1: the operator wants an attacker marked AT SELECTION rather
   * than after Forge's declaration lands, so the intent is held here. It is an
   * INTENT and nothing more — it never claims Forge's tapped state, and
   * `attackIntents` is the one reader (see its note on the disagreement).
   *
   * Keyed by turn because declare-attackers comes round again: an id from turn
   * 8's combat is not an intent in turn 13's.
   */
  attackIntent: { turn: number; ids: Set<number> } | null;
  /**
   * The card this seat most recently sent a `selectCard` for.
   *
   * §B.4's tail. A drag anchors its arrow to the card it was picked up from;
   * a CLICK has no such anchor, and the thing the player pointed at last is
   * what the arrow should come out of. Cleared by `clearSelectables` — the
   * input that took the click has stopped — and by every snapshot.
   */
  lastSelectedCard: number | null;
  /**
   * This seat's own lands in the order the board showed them tap, oldest
   * first, and only the ones still tapped — what `undoableTap` reads to say
   * which land Forge's Undo would untap. Kept by `noteTaps` on every redraw.
   */
  tapOrder: number[];
  /**
   * Wave 49 §A — the bridge's OWN wire fact for the counterspell arc (X3,
   * wave 46 §B): `fromId → toId`, straight off `PlayBridge.java`'s own
   * `stackTargetSpells` (`../fold.ts`'s `FoldResult.stackTargetSpells`, folded
   * here in {@link foldFrames}). True for EVERY seat, including one that
   * never saw a `getChoices` ask at all (the opponent of the caster) — there
   * is no wire fact for this on the STACK ITEM's own property bag, proven
   * against the real jar
   * (`apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts`,
   * `docs/planning/wave46-evidence/B/README.md`): a target that is ANOTHER
   * spell on the stack is added to Forge's `TargetChoices` as a bare
   * `SpellAbility` (`TargetChoices.java:45-97`), which fails BOTH
   * `getTargetCards()`'s and `getTargetPlayers()`'s runtime-type filter — so
   * the countering stack item's own `TargetCards`/`TargetPlayers` read EMPTY
   * once it is on the stack, even though the ability plainly targeted
   * something. `../adapter.ts`'s `toBoardView` reads it onto each
   * `StackEntry.targetStackItemId`, and `live/placed.ts`'s `.placed__arrow`s
   * draw the arc straight off that field (wave 64/J6 deleted the CASTER's own
   * client-side pairing this once needed unioning with — `stackTargetIntent`/
   * `stackTargetArcs`, claimed from inside `answerAsk` before this wire fact's
   * own frame could land — once `gestures/auto-targets.ts`'s `stackTargetArrows`,
   * its one reader, had none left either).
   */
  stackTargetSpells: ReadonlyMap<number, number>;
  /**
   * This seat's full-control toggle. The server's word after every snapshot,
   * this client's own last word in between. Off by default — and off is also
   * what a page that has not yet been answered a snapshot must draw, because
   * the alternative is drawing a hatch nobody opened.
   */
  fullControl: boolean;
  /**
   * This seat's *"always stop at end step"* preference (item 2/6, wave 30) —
   * this client's own last word, same shape as `fullControl` but with no
   * server echo: `forge:stop-preference` is client → server only
   * (`apps/server/src/play/transport.ts`'s own `StopPreferenceSchema` note),
   * because unlike full control nothing about the ANSWER changes server-side
   * in a way this client needs told back — `Match.setStopPolicy` folds it
   * into the seat's `StopPolicy` and the next stop simply does or does not
   * fire. Off by default, which is also the operator's own default.
   */
  stopAtEndStep: boolean;
  /**
   * The opponent's-turn yield toggle — this client's own last word, no
   * server echo, same reasoning as `stopAtEndStep`. `null` is "never pressed
   * this match"; a real value is the turn it was pressed FOR, so a later
   * turn reads as off on its own, the same lazy compare `attackIntent` uses.
   */
  autoYield: { turn: number; on: boolean } | null;
  /**
   * Every seat's identity, keyed by Forge PLAYER id — item 4 (wave 29 §A.6-8),
   * the render half. `seats[].playerId` is the join key `D-avatar-field.md` §2
   * traced (the same id `BoardPlayer.id` already is), and this map carries only
   * the seats that had a non-blank `avatarId`: a seat with none is simply
   * absent from it, which is what `redraw` turns into `BoardPlayer.avatarId`
   * being absent too (§3's two-state rule, end to end).
   *
   * **`null` until `forge:seats` has landed at least once, and a real (possibly
   * empty) `Map` after.** That is the whole of the three-state rule this field
   * exists to keep: "the seat table has not arrived yet" (`null`) is a
   * different fact from "it arrived, and this seat had no avatar" (a `Map`
   * with no entry for that player), even though both draw the same generated
   * bust — see `PlayerFace`. Reset to `null` on an epoch change
   * (`discardLocal`): a new Forge process can hand its players different ids,
   * and the resync that follows re-sends `forge:seats` for the new epoch.
   */
  avatarByPlayerId: ReadonlyMap<number, string> | null;
  /**
   * The name Forge shows for each seat, keyed by Forge PLAYER id — wave 31 §S,
   * from `forge:seats`' `name`. Same three-state rule as
   * {@link LiveMatch.avatarByPlayerId}: `null` until the seat table has
   * arrived, then a real Map holding only the seats the server named.
   */
  nameByPlayerId: ReadonlyMap<number, string> | null;
  /**
   * Every seat's own open ask or mana payment, keyed by SEAT (0/1, not a
   * Forge player id — unlike {@link LiveMatch.avatarByPlayerId}), from
   * `forge:seats`' `waitingOn`
   * (`apps/server/src/play/match.ts`'s `waitingOnFor`). Same three-state rule
   * as {@link LiveMatch.avatarByPlayerId}: `null` until the seat table has
   * arrived, then a real Map holding only the seats that have one right now.
   * `LiveBoard.tsx`'s banner reads the OTHER seat's entry and owns turning
   * `method` into a verb; `hostCard` is already resolved against what THIS
   * viewer may see (`match.ts`'s own header on `waitingOnFor`), never a hand
   * card of the asking seat's.
   */
  waitingOn: ReadonlyMap<number, { method: string; hostCard: string | null }> | null;
  /**
   * The coin toss while the winner's Play/Draw question is open —
   * `forge:seats`' `coinToss`, the same on every seat's entry. `winner` is a
   * SEAT; `playerId` is that seat's Forge player when the roster already names
   * it (the face and the name are looked up by it). `null` before the toss
   * and after the winner answers.
   */
  coinToss: { winner: number; playerId: number | null; at: number } | null;
  /**
   * This connection is a SPECTATOR of its seat: another connection for the
   * same account controls it, and the server refuses this one's inputs
   * (`forge:role`, wave 31 §S). The server enforces; this only lets the UI say
   * why nothing happens. False until told otherwise — and a refreshed tab is
   * told `spectator` for a moment and then `player` on promotion.
   */
  spectator: boolean;
  /**
   * The match has ended: the server's `ended` notice (`showErrorDialog`
   * titled `Match ended`) has arrived, or Forge's own view says `GameOver`.
   * Sticky until a snapshot replaces the board, which re-sends the notice.
   */
  over: boolean;
  /**
   * Forge's own `finishGame()` has arrived: the game is over for certain, even
   * when the view's `GameOver` property never does (its delta is whatever
   * flush follows the end, and sometimes none does — the loser is drawn as lost
   * and the result screen never comes; 2026-10-08, `w35` R16 twice). Reset by
   * a snapshot, which the server follows with the frame again.
   */
  finished: boolean;
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

/**
 * The table's layout moved with no frame from Forge (wave 51: the stack band
 * hangs from the decision pop-up's measured top, `LiveBoard.tsx`'s
 * `questionTopOf`). Wakes every subscriber WITHOUT a new revision: React's own
 * snapshot is unchanged and redraws nothing, and the gesture layer repaints
 * Forge's arcs against the boxes where they are now — it otherwise paints only
 * on a frame, and an arc drawn before the band moved stayed where the band was.
 */
export function relayout(match: LiveMatch): void {
  for (const listener of match.listeners) listener();
}

/** `useSyncExternalStore`'s subscribe. Returns the unsubscribe. */
export function subscribe(match: LiveMatch, listener: () => void): () => void {
  match.listeners.add(listener);
  return () => {
    match.listeners.delete(listener);
  };
}

function send(match: LiveMatch, frame: ClientEnvelope['frame'], placement?: Placement): void {
  const envelope: ClientEnvelope = { matchId: match.matchId, frame, ...(placement === undefined ? {} : { placement }) };
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
    promptCard: null,
    buttons: null,
    selectables: null,
    weaklySelectable: null,
    weaklySelectableManaOnly: null,
    highlighted: null,
    highlightedPlayers: null,
    says: [],
    inputLive: false,
    spent: { cards: new Set(), players: new Set() },
    attackIntent: null,
    lastSelectedCard: null,
    tapOrder: [],
    stackTargetSpells: new Map(),
    avatarByPlayerId: null,
    nameByPlayerId: null,
    waitingOn: null,
    coinToss: null,
    spectator: false,
    over: false,
    finished: false,
    fullControl: false,
    stopAtEndStep: false,
    autoYield: null,
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

  match.transport.on(MATCH_EVENTS.fullControl, (payload) => {
    adoptFullControl(match, payload);
  });

  match.transport.on(MATCH_EVENTS.seats, (payload) => {
    adoptSeats(match, payload);
  });

  match.transport.on(MATCH_EVENTS.role, (payload) => {
    adoptRole(match, payload);
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
  // Forge's game thread is parked on the open question; a press now would
  // reach whichever input is current once it is answered.
  if (match.asks.length > 0) return false;
  send(match, { kind: 'act', method: which === 'ok' ? 'selectButtonOk' : 'selectButtonCancel' });
  // Forge sends a fresh bar for the next decision; until it does, the bar we
  // just answered must not be pressable twice.
  match.buttons = { ...bar, enable1: false, enable2: false };
  match.inputLive = false;
  match.stats.replies += 1;
  notify(match);
  return true;
}

/**
 * Flip this seat's full-control toggle and tell the server.
 *
 * The ONE sender — the toggle button in `LiveBoard` and nothing else. Sends
 * nothing (and returns false) when the toggle is already where it is asked to
 * be: the server treats that as a no-op anyway, and a click that changes
 * nothing should not cross the wire. Optimistic: the server logs a refusal
 * rather than answering, so the flag is this client's own last word.
 */
export function setFullControl(match: LiveMatch, on: boolean): boolean {
  if (match.fullControl === on) return false;
  match.transport.emit(MATCH_EVENTS.fullControl, fullControlFrame(match.matchId, on));
  match.fullControl = on;
  notify(match);
  return true;
}

/**
 * The yield override, as this client currently holds it: on, and still for
 * the CURRENT turn — the same lazy compare `attackIntents` runs for its own
 * turn-scoped mark.
 */
export function isAutoYieldOn(match: LiveMatch): boolean {
  return match.autoYield !== null && match.autoYield.on && match.autoYield.turn === (match.view?.turn ?? -1);
}

/**
 * Flip the opponent's-turn yield toggle and tell the server. The ONE
 * sender — the control box's own button (`LiveBoard.tsx`). Optimistic, same
 * as `setFullControl`; no echo to adopt back, so what is recorded is the
 * CURRENT turn, and `isAutoYieldOn`'s own compare is what later reads a
 * turn-old press as expired.
 */
export function setAutoYield(match: LiveMatch, on: boolean): boolean {
  if (isAutoYieldOn(match) === on) return false;
  const turn = match.view?.turn ?? 0;
  match.transport.emit(MATCH_EVENTS.autoYield, autoYieldFrame(match.matchId, on));
  match.autoYield = { turn, on };
  notify(match);
  return true;
}

/**
 * Flip this seat's *"always stop at end step"* preference and tell the
 * server (item 2/6, wave 30). The settings panel's own sender, and the only
 * one: `forge:stop-preference` folds into the seat's `StopPolicy`
 * (`apps/server/src/play/socket.ts`'s handler), toggling `END_OF_TURN` in or
 * out of `stopOnTheirTurn` without touching any other field of it.
 *
 * `force` re-sends even when the local flag already agrees — the settings
 * panel's own mount effect uses it to push a PERSISTED preference (read back
 * from `@wolffm/prefs-client` on a returning viewer) into a freshly joined
 * match, whose server-side `StopPolicy` starts from `DEFAULT_STOP_POLICY`
 * and has no memory of a preference set in an earlier match. Without `force`
 * that first sync would no-op, because the client's own `stopAtEndStep`
 * already reads `false` before anything has been sent this match — the same
 * shape `false === false` would refuse in `setFullControl` above, except
 * there the server's OWN default agrees with the client's, so the omission
 * never mattered there.
 */
export function sendStopPreference(match: LiveMatch, stopAtEndStep: boolean, force = false): boolean {
  if (!force && match.stopAtEndStep === stopAtEndStep) return false;
  match.transport.emit(MATCH_EVENTS.stopPreference, stopPreferenceFrame(match.matchId, stopAtEndStep));
  match.stopAtEndStep = stopAtEndStep;
  notify(match);
  return true;
}

/**
 * `forge:full-control` arriving FROM the server: the seat's state as the server
 * holds it, sent to this socket after every snapshot. Adopting it is what makes
 * a refresh keep full control.
 *
 * The same schema the sender uses, strictly — an unknown field or a missing
 * `on` is recorded in `lastInvalid` and changes nothing, exactly as a malformed
 * envelope does. A payload for another match is ignored for the same reason a
 * snapshot for another match is refused: this handle speaks for one match only.
 *
 * It never sends anything. The server is telling us, not asking; answering it
 * would be a loop.
 */
function adoptFullControl(match: LiveMatch, payload: unknown): void {
  const parsed = FullControlSchema.safeParse(payload);
  if (!parsed.success) {
    match.lastInvalid = parsed.error.issues.map((i) => ({
      path: `$${i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('')}`,
      message: i.message,
    }));
    match.stats.invalid += 1;
    notify(match);
    return;
  }
  if (parsed.data.matchId !== match.matchId) {
    match.lastInvalid = [
      { path: '$.matchId', message: `full control for match ${parsed.data.matchId}, not ${match.matchId}` },
    ];
    match.stats.invalid += 1;
    notify(match);
    return;
  }
  if (match.fullControl === parsed.data.on) return;
  match.fullControl = parsed.data.on;
  notify(match);
}

/**
 * `forge:seats` arriving FROM the server — item 4, wave 29 §B's own event
 * (see `MATCH_EVENTS.seats`'s note). Sent on every join and every resync, and —
 * since wave 32 (Q6) — to every socket in the match whenever a seat's avatar
 * changes mid-game (`Match.setSeatAvatar`), so this is the one place
 * `avatarByPlayerId` is ever written and a later event simply replaces the map.
 *
 * A malformed payload or one for another match is recorded and changes
 * nothing, exactly as `adoptFullControl` treats the same two failures — the
 * server is telling us, not asking, so there is nothing to answer either way.
 * `redraw` runs on success (not merely `notify`): this is the fact
 * `toBoardView` turns into `BoardPlayer.avatarId`, so the view itself is stale
 * until it is rebuilt.
 */
function adoptSeats(match: LiveMatch, payload: unknown): void {
  const parsed = parseMatchSeats(payload);
  if (!parsed.ok) {
    match.lastInvalid = parsed.errors;
    match.stats.invalid += 1;
    notify(match);
    return;
  }
  if (parsed.value.matchId !== match.matchId) {
    match.lastInvalid = [
      { path: '$.matchId', message: `seats for match ${parsed.value.matchId}, not ${match.matchId}` },
    ];
    match.stats.invalid += 1;
    notify(match);
    return;
  }
  const byPlayerId = new Map<number, string>();
  for (const seat of parsed.value.seats) {
    if (seat.playerId === null) continue;
    const id = normalizeAvatarId(seat.avatarId);
    if (id !== null) byPlayerId.set(seat.playerId, id);
  }
  // A real Map even when it holds nothing: "arrived, nobody has one" is still
  // arrived — see the field's own note on the three states.
  match.avatarByPlayerId = byPlayerId;
  const names = new Map<number, string>();
  for (const seat of parsed.value.seats) {
    if (seat.playerId !== null && seat.name !== undefined) names.set(seat.playerId, seat.name);
  }
  match.nameByPlayerId = names;
  // Keyed by SEAT, not player id — a seat can hold an open
  // ask before `openView` has named its Forge player (an early mulligan
  // confirm, for one), and the fact must still reach the viewer then.
  const waitingOn = new Map<number, { method: string; hostCard: string | null }>();
  for (const seat of parsed.value.seats) {
    if (seat.waitingOn !== undefined) waitingOn.set(seat.seat, seat.waitingOn);
  }
  match.waitingOn = waitingOn;
  const tossed = parsed.value.seats.find((seat) => seat.coinToss !== undefined)?.coinToss;
  match.coinToss =
    tossed === undefined
      ? null
      : {
          winner: tossed.winner,
          playerId: parsed.value.seats.find((seat) => seat.seat === tossed.winner)?.playerId ?? null,
          at: typeof tossed.at === 'number' ? tossed.at : Date.now(),
        };
  redraw(match);
  notify(match);
}

/**
 * `forge:role` arriving FROM the server (wave 31 §S): whether THIS socket
 * controls the seat or only watches it. Malformed or for another match is
 * recorded and changes nothing, like `adoptSeats`.
 */
function adoptRole(match: LiveMatch, payload: unknown): void {
  const parsed = parseMatchRole(payload);
  if (!parsed.ok) {
    match.lastInvalid = parsed.errors;
    match.stats.invalid += 1;
    notify(match);
    return;
  }
  if (parsed.value.matchId !== match.matchId) {
    match.lastInvalid = [{ path: '$.matchId', message: `role for match ${parsed.value.matchId}, not ${match.matchId}` }];
    match.stats.invalid += 1;
    notify(match);
    return;
  }
  const spectator = parsed.value.role === 'spectator';
  if (match.spectator === spectator) return;
  match.spectator = spectator;
  notify(match);
}

const NOTHING = { selectable: new Set<number>(), selectablePlayers: new Set<number>() };

/** Nothing is clickable — but `selectionOpen` is about Forge's input, not about us. */
function nothingClickable(match: LiveMatch): LiveClickables {
  return { ...NOTHING, selectionOpen: match.selectables !== null };
}

/**
 * What the board may click now — see the module header. Exactly what Forge
 * named, and nothing else:
 *
 *  - a selection is open (`setSelectables`) → those cards, and the players a
 *    selection input will take;
 *  - otherwise Forge's actionable set (`setWeaklySelectable`) union the cards
 *    it has MARKED (`setHighlighted`) union — while `GameView.Mulligan` is up —
 *    this seat's OWN hand → those cards, and no player;
 *  - Forge has named none of the four → nothing.
 *
 * ## Why `highlighted` sits BESIDE `selectables` and is not folded into it
 *
 * Wave 22 lane L. The two are different claims. `setSelectables` is an OFFER:
 * "my selection will take a click on exactly these, and it wants between min
 * and max of them". `setHighlighted` is a MARK: "my input is tracking this
 * entity" — `InputSelectManyBase.java:127` uses it for the entities already
 * chosen, `InputLondonMulligan.java:138` for the cards already set aside.
 * Nothing in Forge says a marked entity is a legal click.
 *
 * So the mark is never allowed to widen the offer. When a selection is open,
 * its card list is the whole of what this function returns and a highlight adds
 * NOTHING — otherwise a target already chosen would go back on the block, and
 * `min`/`max` would be counted against a set Forge never published. Outside a
 * selection there is no offer to widen: the highlight joins the actionable set,
 * which is what lets a seat un-mark what it marked (the only click the London
 * mulligan has, and every one of those marks came from a click Forge accepted).
 *
 * The one thing that would collapse the two is Forge publishing a selection and
 * a highlight that disagree. It does — and the offer wins, by this rule.
 *
 * A card the seat cannot see is dropped whichever list held it: the view is
 * the hidden-information boundary, and an id that survived a zone change is
 * not an affordance. That applies to a highlight too, so a mark cannot reveal
 * a card this seat was not already sent.
 */
export function boardInteraction(match: LiveMatch): LiveClickables {
  const view = match.view;
  if (view === null || !match.inputLive || !match.connected || match.asks.length > 0) return nothingClickable(match);
  const selection = match.selectables;
  const named =
    selection === null
      ? union(
          match.weaklySelectable,
          match.highlighted,
          mulliganHand(match.state, view),
          blockTargets(match, view),
          declaredBlockers(match, view),
          undoableTap(match, view),
          declaredAttackers(match, view),
          attackDefenders(match, view),
        )
      : selection.cards;
  if (named === null) return nothingClickable(match);
  const drawn = cardIdsInView(view);
  const offered = new Set<number>();
  for (const id of named) if (drawn.has(id) && !match.spent.cards.has(id)) offered.add(id);
  const players = new Set<number>();
  if (selection !== null) {
    for (const p of view.players) {
      if (match.spent.players.has(p.id)) continue;
      if (selection.players !== null && !selection.players.has(p.id)) continue;
      players.add(p.id);
    }
  } else if (declaringAttackers(match) && attackWindowLive(match)) {
    // `InputAttack.onPlayerSelected` makes an opponent the current defender.
    for (const p of view.players) if (!p.isViewer && !p.hasLost && !match.spent.players.has(p.id)) players.add(p.id);
  }
  return { selectable: offered, selectablePlayers: players, selectionOpen: selection !== null };
}

/**
 * Forge's label on button 2 at the live declare-attackers window BEFORE
 * anything has been declared (`InputAttack.updatePrompt` → `lblAlphaStrike`,
 * `en-US.properties`) — {@link CALL_BACK_LABEL} is the same button once at
 * least one attacker is. A button LABEL, not a regex over prompt prose — the
 * same practice as {@link AUTO_PAY_LABEL} and {@link CALL_BACK_LABEL}.
 */
const ALPHA_STRIKE_LABEL = 'Alpha Strike';

/**
 * Whether Forge's own bar, exactly as it stands on this seat's screen right
 * now, is specifically the LIVE declare-attackers window — not merely A live
 * bar while the phase happens to read `COMBAT_DECLARE_ATTACKERS`.
 *
 * `declaringAttackers` is read off the state channel ONLY — the phase and
 * whose turn it is — on purpose (its own note says why: never off Forge's
 * prompt text). But the phase can read `COMBAT_DECLARE_ATTACKERS` for the
 * active seat while nothing about attacking is open: after End Turn, Forge's
 * own yield skips the step without ever running `InputAttack` for this seat,
 * yet the state update and a `setWeaklySelectable` for the seat's OWN
 * creatures still arrive — and those alone used to light every opponent.
 *
 * A bare "some button is enabled" is not enough either, confirmed against a
 * real jar: Forge's own yield-suggestion prompt (`InputPassPriority
 * .showYieldSuggestionPrompt`, `maybeDeclineYieldSuggestion`'s own window) is
 * a genuinely live, forwarded bar that can land on this seat's screen DURING
 * the very `COMBAT_DECLARE_ATTACKERS` phase End Turn is skipping — a real
 * question, just not this one. `InputAttack`'s own button 2 is Forge's own
 * sign of which input is actually running ({@link CALL_BACK_LABEL}'s own
 * note draws the same conclusion for the viewer's own card offer), so
 * checking it is reading Forge's fixed UI vocabulary, not its prose.
 */
function attackWindowLive(match: LiveMatch): boolean {
  const bar = match.buttons;
  if (bar === null || !(bar.enable1 || bar.enable2)) return false;
  return bar.label2 === CALL_BACK_LABEL || bar.label2 === ALPHA_STRIKE_LABEL;
}

/**
 * Id sets Forge may each have left unsaid, as one. Null only when EVERY one is
 * null: an empty set means "Forge named nothing", which is not the same answer.
 */
function union(...sets: ReadonlyArray<ReadonlySet<number> | null>): ReadonlySet<number> | null {
  const said = sets.filter((s): s is ReadonlySet<number> => s !== null);
  if (said.length === 0) return null;
  if (said.length === 1) return said[0]!;
  const all = new Set<number>();
  for (const s of said) for (const id of s) all.add(id);
  return all;
}

/**
 * The seat's OWN hand while Forge is waiting for a London mulligan return, and
 * null at every other moment.
 *
 * ## Why this exists, and why it is not "we invented an affordance"
 *
 * Wave 22 lane L, second pass. `InputLondonMulligan` publishes no selection and
 * no actionable set, and it marks a card only AFTER a click it already accepted
 * (`InputLondonMulligan.java:112-123`) — so the mark alone cannot start the
 * loop, and the seat was stuck with prose and an OK/Auto bar. That is the
 * operator's report: *"the cards were not clickable — had to press Auto."*
 *
 * Forge does publish the state this input is in, just not through an entity
 * frame: `GameView.updateIsMulligan(true)` at `InputLondonMulligan.java:60`,
 * cleared at `:105` when the input is done (`GameView.java:141-146`). It is a
 * `TrackableProperty` on the one `GameView` object, so it rides the state
 * channel we already fold, and it is the same flag Forge's own mobile client
 * reads (`MatchScreen.java:381`).
 *
 * The set of cards that input accepts is not a guess either: `onCardSelected`
 * takes a click only when `player.getZone(ZoneType.Hand).contains(c0)`
 * (`:113`), and `player` is the seat's own player. So "this seat's hand, while
 * that flag is up" is Forge's condition transcribed, not a rule of ours. Which
 * of those cards Forge will actually act on stays Forge's to decide — a click
 * past `toReturn` is a no-op on its side (`:117-119`), and we do not count.
 *
 * ## The hidden-information line, twice over
 *
 * Only `isViewer`'s hand is read, and `BoardPlayer.hand` is `null` for every
 * other seat by construction (`adapter.ts` fills it `isViewer ? … : null`), so
 * an opponent's hand is not merely skipped here — it is not in the projection
 * this function can see. `boardInteraction` then intersects with
 * `cardIdsInView`, which also takes `p.hand ?? []` and so contributes nothing
 * for anyone else. An opponent's hand card cannot reach the offered set by
 * either path.
 */
function mulliganHand(state: WireState, view: BoardView): ReadonlySet<number> | null {
  if (!readGameBool(state, 'Mulligan')) return null;
  const me = view.players.find((p) => p.isViewer);
  // `hand` is null for a seat whose hand this viewer may not see. That can only
  // be another seat, and it is the reason this reads the view and not the state.
  if (me === undefined || me.hand === null) return null;
  return new Set(me.hand.map((c) => c.id));
}

/**
 * One boolean off the single `GameView` in the folded state.
 *
 * Absent is FALSE, and that is Forge's own encoding rather than a convenience:
 * `TrackableObject.set` drops a property whose value is null or equals the
 * type's default (`wire.ts`'s header), so `updateIsMulligan(false)` reaches us
 * as a delta that DELETES the key, which `fold.ts` rule 3 honours.
 */
function readGameBool(state: WireState, property: string): boolean {
  for (const obj of state.values()) {
    if (obj._type !== WireType.Game) continue;
    const value = obj[property];
    return typeof value === 'object' && value !== null && value.t === 'bool' && value.v === true;
  }
  return false;
}

/** Every card id the seat was sent: all its zones, and the stack's sources. */
function cardIdsInView(view: BoardView): Set<number> {
  const ids = new Set<number>();
  for (const p of view.players) {
    for (const zone of [p.hand ?? [], p.battlefield, p.graveyard, p.exile]) for (const c of zone) ids.add(c.id);
  }
  for (const item of view.stack) if (item.sourceCardId !== null) ids.add(item.sourceCardId);
  return ids;
}

/**
 * Click a card: Forge's `selectCard`. Sends nothing, and returns false, when
 * the card is not clickable NOW (`boardInteraction`) — a stale click would be
 * taken by whatever Forge asks next. `triggerEvent` is null, as it is for
 * every click that is not a mouse event in Forge's own Swing UI: with null,
 * a card with several abilities comes back as a `getAbilityToPlay` ask
 * (`CMatchUI.getAbilityToPlay`), which `../prompts/` answers.
 */
export function selectCard(match: LiveMatch, cardId: number, placement?: Placement): boolean {
  if (!boardInteraction(match).selectable.has(cardId)) return false;
  // The land just tapped, which Forge itself is not offering: the click is its Undo.
  if (match.view !== null && match.weaklySelectable?.has(cardId) !== true && undoableTap(match, match.view)?.has(cardId) === true) {
    return pressButton(match, 'cancel');
  }
  match.spent.cards.add(cardId);
  match.lastSelectedCard = cardId;
  noteAttackIntent(match, cardId);
  return sendAct(
    match,
    {
      kind: 'act',
      method: 'selectCard',
      card: { kind: 'card', id: cardId },
      otherCardViewsToSelect: [],
      triggerEvent: null,
    },
    placement,
  );
}

/** Click a player: Forge's `selectPlayer`. Same rule as `selectCard`. */
export function selectPlayer(match: LiveMatch, playerId: number): boolean {
  if (!boardInteraction(match).selectablePlayers.has(playerId)) return false;
  match.spent.players.add(playerId);
  return sendAct(match, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: playerId }, triggerEvent: null });
}

function sendAct(match: LiveMatch, frame: Extract<ClientEnvelope['frame'], { kind: 'act' }>, placement?: Placement): boolean {
  send(match, frame, placement);
  match.stats.replies += 1;
  notify(match);
  return true;
}

/**
 * Give up. `IGameController.concede` — the wire has carried it since the
 * beginning (`forge-wire/src/tier-a.ts:52,199-202`, `IGameController.java:22`)
 * and until now had no sender.
 *
 * NOT gated on `boardInteraction`: conceding is not an answer to anything Forge
 * is waiting on, so — like `setFullControl` — it is legal whenever the match is
 * live, including at a moment when nothing on the board is clickable. That is
 * the whole point of a concede button. The confirmation belongs to whoever
 * draws the button (lane C); this is only the send.
 */
export function concede(match: LiveMatch): boolean {
  return sendAct(match, { kind: 'act', method: 'concede' });
}

/* ── Combat, read off Forge's own state ──────────────────────────────── */

/**
 * `PhaseType.COMBAT_DECLARE_ATTACKERS` and this seat is the one declaring.
 *
 * Read off the state channel (`GameView.Phase`, `PlayerTurn` — `adapter.ts`
 * surfaces them as `view.phase` / `view.activePlayerId`), never off Forge's
 * prompt text: the wave's rule §0b forbids a regex over prose, and a phase is
 * a structured fact that has been on the wire all along.
 */
export function declaringAttackers(match: LiveMatch): boolean {
  const view = match.view;
  return view !== null && view.phase === 'COMBAT_DECLARE_ATTACKERS' && view.activePlayerId === viewerIdOf(view);
}

/** `COMBAT_DECLARE_BLOCKERS`, and this seat is NOT the attacker — so it blocks. */
export function declaringBlockers(match: LiveMatch): boolean {
  const view = match.view;
  return view !== null && view.phase === 'COMBAT_DECLARE_BLOCKERS' && view.activePlayerId !== viewerIdOf(view);
}

/**
 * This seat's player id, off the view. `BoardView` carries no `viewerPlayerId`
 * — the projection marks the seat with `isViewer`, which is the same fact and
 * the one every other reader here uses (`mulliganHand`).
 */
function viewerIdOf(view: BoardView): number | null {
  return view.players.find((p) => p.isViewer)?.id ?? null;
}

/**
 * `InputPayMana`'s label for button 1 (`lblAuto`). Lane E's `auto.ts` keys
 * `autoPayReason` on the same string; this is the repo's existing practice for
 * this exact fact, and it is a BUTTON LABEL rather than a regex over prompt
 * prose — §0b's rule forbids the latter, not the former.
 */
export const AUTO_PAY_LABEL = 'Auto';

/**
 * Forge is parked on a MANA PAYMENT — so a press on one of this seat's own
 * battlefield cards is "tap this to pay", not "tidy the battlefield".
 *
 * ## Why this exists
 *
 * `e2e/play.spec.ts:970-972` pays for a spell it just cast by dragging a land
 * that is ALREADY on the battlefield, and `e2e/table-fit.spec.ts` drags an
 * equally-offered land between rows to ARRANGE it. Both cards are in Forge's
 * actionable set, so "is it offered" cannot separate them. What separates them is
 * which input Forge is parked on — the same axis `declaringCombat` uses.
 *
 * ## Four facts, and why each one is here
 *
 *  - **`promptCard !== null`** is the load-bearing one, and it is the FRESH one.
 *    `InputPayMana.updateMessage` announces itself with the ability being paid
 *    for — `showMessage(getMessage(), saPaidFor.getView())`, `InputPayMana.java:410`
 *    — while `InputPassPriority` passes no card at all. Lane E measured that
 *    Forge's button bar is emitted BEFORE the prompt and therefore LAGS it
 *    (`InputConfirm.java:107-121`), so a lingering `Auto` bar can outlive its
 *    input; the prompt cannot, because the next input overwrites `promptCard`
 *    with its own value in the same frame that carries its message. **This is the
 *    guard against the stale bar**, and its test says so.
 *  - **`buttons.label1 === AUTO_PAY_LABEL`** identifies the input. Both of
 *    `InputPayMana`'s bars carry it — `:391` at the start and `:405` once a
 *    payment exists — and no other input puts it in label 1
 *    (`InputLondonMulligan.java:65` puts `lblAuto` in label TWO).
 *  - **`selectables === null`.** `InputPayMana` is not one of `setSelectables`'
 *    two call sites, so a payment never opens a selection. This is what excludes
 *    the other inputs that announce themselves WITH a card —
 *    `InputSelectTargets.java:129`, `InputSelectManyBase.java:92-94` — and
 *    `InputSelectManyBase` matters because its `updateButtons`
 *    (`InputSelectManyBase.java:98`) is the enablement-only overload and leaves
 *    whatever labels were there before.
 *  - **an input is live and nothing is queued in front of it**, the same gate
 *    `boardInteraction` uses, so this can never contradict what is clickable.
 *
 * `enable1` is deliberately NOT required. It means *"auto-pay is possible"*
 * (`:405` fires only when `autoPayManaSources != null`), not *"the payment input
 * is running"* — and a cost that CANNOT be auto-paid is exactly the case where
 * the player must tap sources by hand, which is the gesture this predicate
 * exists to allow. Freshness is carried by `promptCard`, not by enablement.
 */
export function payingMana(match: LiveMatch): boolean {
  if (!match.inputLive || match.asks.length > 0) return false;
  if (match.selectables !== null) return false;
  if (match.promptCard === null) return false;
  return match.buttons !== null && match.buttons.label1 === AUTO_PAY_LABEL;
}

/**
 * `id` is one of the viewer's OWN battlefield permanents, and it is a land —
 * `nothingToDecide`'s one approximation, added once lane F's land-tapping fix
 * put every untapped land with a mana ability into `weaklySelectable` at
 * ordinary priority (wave 35, follow-up to shape 3): without this, End Turn
 * would almost never highlight on the viewer's own turn, since an untapped
 * land is the common case, not the exception.
 *
 * "Land" is read off the CURRENT type line (`card.typeLine`, live off the
 * wire's `Type` — the same field `changedFrom` already reads), never the
 * printed card, so an effect that turns a permanent into a land (or out of
 * one) is honoured exactly as Forge currently sees it.
 */
function isOwnBattlefieldLand(view: BoardView, id: number): boolean {
  const me = view.players.find((p) => p.isViewer);
  const card = me?.battlefield.find((c) => c.id === id);
  return card !== undefined && card.card.typeLine.includes('Land');
}

/**
 * The viewer's own untapped lands that Forge will take a click on for their
 * mana right now, in battlefield order: what a box drawn over the lands may
 * tap. Empty whenever a click on a land would mean anything else — a selection
 * or an ask is open (the land is then an answer to a question), or combat is
 * being declared.
 *
 * Lands only, by the card's CURRENT type line, the same reading
 * `isOwnBattlefieldLand` gives `nothingToDecide`: a creature Forge offers for
 * an ability is a decision, and a sweep must not make it.
 */
export function landsToTap(match: LiveMatch): number[] {
  const view = match.view;
  if (view === null || match.selectables !== null || match.asks.length > 0 || declaringCombat(match)) return [];
  const offered = boardInteraction(match).selectable;
  const me = view.players.find((p) => p.isViewer);
  return (me?.battlefield ?? []).filter((c) => !c.tapped && offered.has(c.id) && c.card.typeLine.includes('Land')).map((c) => c.id);
}

/**
 * Forge is running the London mulligan's bottom pick for this seat
 * (`GameView.Mulligan`, `InputLondonMulligan.java:60`, cleared at `:105`): a
 * click on one of the seat's own hand cards sets it aside or takes it back.
 * `mulliganHand` is what puts the hand in the offer; this is the same flag for
 * a reader that needs the INPUT, not the cards — the gesture layer, which must
 * not aim an arrow from a card the player is merely choosing (ledger Z3).
 */
export function choosingMulligan(match: LiveMatch): boolean {
  return readGameBool(match.state, 'Mulligan');
}

/** The steps of the viewer's own turn in which attackers are still to come. */
const BEFORE_ATTACKERS: ReadonlySet<string> = new Set(['UNTAP', 'UPKEEP', 'DRAW', 'MAIN1', 'COMBAT_BEGIN']);

/**
 * It is the viewer's turn, combat has not reached attackers yet, and the viewer
 * controls a creature that could attack: untapped, not summoning sick (the
 * adapter already lets haste through), no Defender. Forge never offers an
 * attacker at a priority window — attacking is declared later, in its own
 * step — so the actionable set alone would call this "nothing to decide", and
 * End Turn there would skip combat.
 *
 * Approximation: an effect that stops a creature attacking without the
 * Defender keyword (a Pacifism, say) still counts it as able.
 */
export function attackersLeft(view: BoardView): boolean {
  const me = view.players.find((p) => p.isViewer);
  if (me === undefined || !me.isActive) return false;
  if (view.phase === null || !BEFORE_ATTACKERS.has(view.phase)) return false;
  return me.battlefield.some(
    (c) =>
      c.card.typeLine.includes('Creature') &&
      !c.tapped &&
      !c.summoningSick &&
      !(c.keywords ?? []).includes('Defender'),
  );
}

/**
 * Nothing is left for this seat to decide right now — wave 35 §S shape 3, the
 * seam L's End Turn highlight (R5) reads.
 *
 * Three facts, all Forge's own:
 *
 *  - **no open ask** (`asks.length === 0`) — nothing is waiting on a reply;
 *  - **no open selection** (`selectables === null`) — `InputSelectTargets` and
 *    `InputSelectEntitiesFromList` are the only two inputs that publish one
 *    (see the module header), and neither is "nothing to decide";
 *  - **Forge's own actionable set, minus the viewer's own battlefield lands,
 *    is empty.** `weaklySelectable` carries three states, not two — see that
 *    field's own note — and only a published (non-null) set answers this
 *    question at all. `null` means Forge has not published an actionable set
 *    AT ALL since the last `clearWeaklySelectable` (a payment input
 *    mid-flight, the London mulligan, the gap between priority ending and the
 *    next input starting): there may still be something to decide, Forge
 *    simply has not said.
 *
 *    A published set that names only the viewer's OWN lands is Forge's
 *    "tap one of these for mana" offer — true at nearly every ordinary
 *    priority window since lane F's land-tapping fix, and not a decision this
 *    highlight should chase: tapping a land for mana is never, by itself, the
 *    reason to hold priority. **Approximation, on purpose**: a MANLAND (a
 *    land with its own non-mana activated ability — an animate effect, say)
 *    is filtered out exactly the same as a plain one, so `nothingToDecide`
 *    can read `true` while that ability is technically still available. This
 *    predicate only ever feeds a HIGHLIGHT (a hint that End Turn is a
 *    reasonable next click), never a gate on an action, so an occasional
 *    false "nothing to decide" costs nothing it could not already cost
 *    before Forge offered any actionable set at all.
 *
 *    **Wave 53 T**: a card that is NOT one of the viewer's own battlefield
 *    lands clears the same way when `weaklySelectableManaOnly` names it — w52
 *    §S's own fact, "every playable ability here is a mana ability", which
 *    covers a mana ROCK (a Signet) the same way the land check covers a
 *    land. Without this, a seat whose only offer was a Signet never got the
 *    End Turn highlight at all (the operator, Playtest 9, after w52 shipped
 *    the Signet click itself). `manaOnly` only ever excuses a card that is
 *    ALSO in `weaklySelectable` — it is never read on its own, and it is
 *    `null` (not an empty set) exactly when Forge's bridge could not tell,
 *    the same non-claim `weaklySelectable: null` already makes.
 *
 * `view !== null` guards the moment before any state has folded at all, when
 * every field above still reads its unset default and would otherwise agree
 * for the wrong reason.
 */
export function nothingToDecide(match: LiveMatch): boolean {
  const view = match.view;
  if (view === null) return false;
  if (match.asks.length > 0) return false;
  if (match.selectables !== null) return false;
  if (match.weaklySelectable === null) return false;
  for (const id of match.weaklySelectable) {
    if (isOwnBattlefieldLand(view, id)) continue;
    if (match.weaklySelectableManaOnly?.has(id) === true) continue;
    return false;
  }
  return !attackersLeft(view);
}

/** Forge's own yield window after End Turn (`lblYieldingUntil*`) — moved here from `LiveBoard.tsx` (T9), the one other reader of this fact. */
export const YIELDING = /^Yielding until /;

/**
 * This seat genuinely has something to decide right now, rather than Forge's
 * raw per-frame `hasPriority` ping-ponging through an auto-passed exchange
 * (T9, from wave 63 lane F's own finding: *"the rail, the control bar and End
 * Turn's highlight never move during an auto-passed UNTAP/UPKEEP/DRAW. What
 * moves is `Board.tsx`'s own `.seat__flag`"*). `LiveBoard.tsx`'s priority-flag
 * gate is the one caller; `ownDecisionOpen` and `waitingForOpponent` are its
 * own `myOwnDecisionOpen`/`isWaitingForOpponent(match)` — both already
 * computed there for the pop-ups themselves, so this is the one place that
 * COMBINES them into the flag's fact, replacing the inline combining step
 * ("F's seam filter") that used to live beside `withGatedPriority`'s call.
 * `withGatedPriority` itself (the view transform) is unchanged.
 *
 * `'you'`: that own-decision set, or the bare case neither covers — Forge's
 * bar simply live with nothing else open (an ordinary "your move, nothing on
 * the stack" priority pass). `'them'`: the viewer's own is false AND the
 * server's own `waitingForOpponent` fact is true — never both at once
 * (`isWaitingForOpponent`'s own note on staleness).
 */
export function genuinelyAsked(
  match: LiveMatch,
  seat: 'you' | 'them',
  open: { ownDecisionOpen: boolean; waitingForOpponent: boolean },
): boolean {
  const yielding = YIELDING.test(match.prompt ?? '');
  const bar = match.buttons;
  const viewerOpen = open.ownDecisionOpen || (!yielding && bar !== null && (bar.enable1 || bar.enable2));
  return seat === 'you' ? viewerOpen : open.waitingForOpponent && !viewerOpen;
}

/**
 * This seat is declaring attackers or blockers — the two moments when a press on
 * one of its OWN battlefield cards is an answer to Forge rather than a tidy-up.
 *
 * This is the predicate that partitions the press with lane A's arrange gesture
 * (§A.1), and it is deliberately NOT `selectionOpen`: **Forge publishes no
 * selection during combat declaration.** `setSelectables` has exactly two
 * game-side call sites — `InputSelectTargets.java:68` and
 * `InputSelectEntitiesFromList.java:57` — and `InputAttack`
 * (`InputAttack.java:52`, `extends InputSyncronizedBase`) is neither: it
 * publishes `pushAttackerCandidates` → `setWeaklySelectable` and
 * `setHighlighted` and nothing more (`:99`, `:292-328`, `:356`). `InputBlock` is
 * the same (`InputBlock.java:73`). So `match.selectables` is null throughout
 * both, and a rule that only stood arranging down for an open selection would
 * leave the attacker and the blocker natively draggable — see
 * `gestures/install.ts`'s `onDragStart`.
 */
export function declaringCombat(match: LiveMatch): boolean {
  return declaringAttackers(match) || declaringBlockers(match);
}

/**
 * The attackers `InputBlock` will take a click on, or null when nothing is
 * being blocked right now.
 *
 * ## Why this is Forge's condition and not a rule of ours
 *
 * `InputBlock.onCardSelected` accepts any card with `combat.isAttacking(card)`
 * and makes it the *current attacker* — the one the next blocker click is
 * assigned to (`InputBlock.java:112-115`). But `pushBlockerCandidates`
 * (`PlayerControllerHuman.java:1621-1647`) puts only the DEFENDER's own
 * creatures in `setWeaklySelectable`, so an attacker never reaches
 * `boardInteraction` through the offered set and every drop on one was refused
 * — the gap `./combat-drag.jvm.test.ts` records rather than works around.
 *
 * So this transcribes `isAttacking`, which rides the state channel as the
 * card's own `Attacking` property (`adapter.ts:351`), and gates it on the two
 * facts that say `InputBlock` is the input running:
 *
 *  - the phase is declare-blockers and this seat is not the attacker, and
 *  - Forge has HIGHLIGHTED something — `setCurrentAttacker` is the only thing
 *    that highlights in this phase (`InputBlock.java:190-197`), so a non-empty
 *    mark is that input's signature. At the defender's ordinary priority in the
 *    same step nothing is highlighted, and nothing here is offered.
 *
 * Hidden information is untouched: an attacking creature is on a battlefield
 * this seat was already sent, and `boardInteraction` still intersects with
 * `cardIdsInView`.
 */
function blockTargets(match: LiveMatch, view: BoardView): ReadonlySet<number> | null {
  if (!declaringBlockers(match)) return null;
  if (match.highlighted === null || match.highlighted.size === 0) return null;
  const attackers = new Set<number>();
  for (const p of view.players) {
    if (p.isViewer) continue;
    for (const c of p.battlefield) if (c.attacking) attackers.add(c.id);
  }
  return attackers;
}

/**
 * This seat's own creatures already assigned to block, offered while
 * `InputBlock` is running — or null when it is not.
 *
 * ## Why this is Forge's condition and not a rule of ours
 *
 * `InputBlock.onCardSelected` UNDOES a block when the click lands on a
 * creature `combat.isBlocking(card, currentAttacker)` — the current
 * attacker, not merely "blocking something" — and calls
 * `combat.removeBlockAssignment` (`InputBlock.java:132-146`,
 * "lblRemoveFromCombat"). But `pushBlockerCandidates`
 * (`PlayerControllerHuman.java:1621-1647`) names only LEGAL blocks for the
 * current attacker and drops a creature the moment it is already assigned to
 * one, so that click never reached `boardInteraction` and `selectCard`
 * refused it — the same shape {@link declaredAttackers} found for the undo on
 * an attacker.
 *
 * So this offers every creature the viewer's own that the wire already says
 * is blocking SOMETHING, read off `view.combat`'s planned map
 * (`adapter.ts`'s `CombatBand.plannedBlockers`, which rides
 * `AttackersWithPlannedBlockers` the whole time `InputBlock` runs — see that
 * field's own doc for why the CONFIRMED map would read empty here instead). A
 * click Forge actually refuses (it is blocking a different attacker than the
 * current one) costs nothing: `selectCard` only ever offers the click, Forge
 * still decides what it means.
 *
 * Hidden information is untouched: the cards are on this seat's own
 * battlefield, and `boardInteraction` still intersects with `cardIdsInView`.
 */
function declaredBlockers(match: LiveMatch, view: BoardView): ReadonlySet<number> | null {
  if (!declaringBlockers(match)) return null;
  const me = view.players.find((p) => p.isViewer);
  if (me === undefined) return null;
  const mine = new Set(me.battlefield.map((c) => c.id));
  const out = new Set<number>();
  for (const band of view.combat ?? []) {
    for (const id of band.plannedBlockers ?? []) if (mine.has(id)) out.add(id);
  }
  return out;
}

/**
 * Forge's own word for button 2 of `InputAttack` once an attacker has been
 * declared (`InputAttack.updatePrompt` → `lblCallBack`, `en-US.properties`).
 * Before one is, the same button reads `lblAlphaStrike`. A button LABEL, not a
 * regex over prompt prose — the same practice as {@link AUTO_PAY_LABEL}.
 */
export const CALL_BACK_LABEL = 'Call Back';

/**
 * The viewer's own already-declared attackers, offered while `InputAttack` is
 * running — or null when it is not.
 *
 * ## Why this exists (wave 32, Q14)
 *
 * `InputAttack.onCardSelected` UNDECLARES an attacker the seat clicks again
 * (`InputAttack.java:208-218`: `combat.isAttacking(card, currentDefender)` →
 * `undeclareAttacker`), but `pushAttackerCandidates` drops every declared attacker
 * from the actionable set (`PlayerControllerHuman.java:1613-1614`), so such a click
 * never reached `boardInteraction` and `selectCard` refused it. The same shape as
 * {@link blockTargets}: Forge accepts a click its own offer does not name, and the
 * condition it accepts it under is on the wire.
 *
 * ## Two facts say `InputAttack` is the input running
 *
 *  - the phase is declare-attackers and this seat is the active player
 *    ({@link declaringAttackers}); and
 *  - button 2 reads `Call Back` ({@link CALL_BACK_LABEL}) — Forge's own sign that
 *    at least one attacker is declared. The declare-attackers PRIORITY window that
 *    follows reads `End Turn`, and offering an attacker there would send a click to
 *    an input that has no such meaning.
 *
 * Hidden information is untouched: the cards are on this seat's own battlefield,
 * and `boardInteraction` still intersects with `cardIdsInView`.
 */
/**
 * Forge's label on the second button at priority while its last action can be
 * undone: `lblUndo` and the size of its undo stack, "Undo (2)"
 * (`InputPassPriority.java:170-171`). At every other moment that button is End
 * Turn, or another input's Cancel.
 */
export const UNDO_LABEL = /^Undo \(\d+\)$/;

/**
 * The permanent this seat tapped last (a land, or a creature tapped for mana),
 * offered for a click while Forge offers Undo — or null when it does not.
 *
 * The operator, twice (2026-10-04 and 2026-10-06): clicking a land just tapped
 * for mana should untap it, without reaching for the Undo button. Forge has no
 * click for that: a tapped land is not in its actionable set, and its undo is
 * last-in-first-out (`MagicStack.undo()`). So the ONE land a click may untap is
 * the one its Undo would: the last to tap, by the board's own record
 * (`LiveMatch.tapOrder`). `selectCard` sends that click as the Undo button.
 * Untapping an earlier land out of order would need a change in the fork.
 *
 * `UNDO_LABEL` on an enabled button is what says the undo exists: Forge clears
 * its undo stack at every phase change and when anything that cannot be undone
 * goes on the stack, and the label goes with it.
 *
 * Not checked, because the wire does not say it: that the last undoable action
 * WAS that tap. An undoable ability that taps nothing, played after the land,
 * is what Undo would take back first.
 */
function undoableTap(match: LiveMatch, view: BoardView): ReadonlySet<number> | null {
  const bar = match.buttons;
  if (bar === null || !bar.enable2 || !UNDO_LABEL.test(bar.label2)) return null;
  const last = match.tapOrder[match.tapOrder.length - 1];
  if (last === undefined) return null;
  const me = view.players.find((p) => p.isViewer);
  return me?.battlefield.some((c) => c.id === last && c.tapped) === true ? new Set([last]) : null;
}

/**
 * Keep {@link LiveMatch.tapOrder} against the view just drawn: a permanent that
 * tapped since `before` goes on the end, and one no longer tapped (or no longer
 * there) comes out. Two permanents tapping in one update have no order the wire
 * gives (a payment Forge made), so the record starts again from nothing.
 *
 * Every own permanent, not only a land. The operator, three times (2026-10-04,
 * 2026-10-06, 2026-10-08: "i should be able to untap llanowar elves if i
 * haven't done anything with the mana"): Forge undoes a creature's mana ability
 * exactly as a land's (`ManaEffect.java` marks it undoable; measured against
 * the jar, `w65-elves.jvm.test.ts`), and the only thing that kept the Elves off
 * the click was this record reading "Land". Whether the tap WAS the last
 * undoable action is already not something the wire says (see `undoableTap`),
 * for a creature as for a land.
 */
function noteTaps(match: LiveMatch, before: BoardView | null): void {
  const permanents = (view: BoardView | null): Map<number, boolean> =>
    new Map((view?.players.find((p) => p.isViewer)?.battlefield ?? []).map((c) => [c.id, c.tapped]));
  const now = permanents(match.view);
  if (before === null) {
    match.tapOrder = [];
    return;
  }
  const was = permanents(before);
  const tapped = [...now].filter(([id, isTapped]) => isTapped && was.get(id) === false).map(([id]) => id);
  const kept = match.tapOrder.filter((id) => now.get(id) === true);
  match.tapOrder = tapped.length > 1 ? [] : [...kept, ...tapped];
}

function declaredAttackers(match: LiveMatch, view: BoardView): ReadonlySet<number> | null {
  if (!declaringAttackers(match)) return null;
  if (match.buttons === null || match.buttons.label2 !== CALL_BACK_LABEL) return null;
  const me = view.players.find((p) => p.isViewer);
  if (me === undefined) return null;
  return new Set(me.battlefield.filter((c) => c.attacking).map((c) => c.id));
}

/**
 * The planeswalkers and battles this seat could attack, offered while
 * `InputAttack` is running — or null when it is not.
 *
 * Forge publishes no actionable set for them, yet a click on one is how its own
 * UI picks what the next attacker attacks: `InputAttack.onCardSelected` makes a
 * card in `combat.getDefenders()` the current defender (`InputAttack.java:230-235`)
 * and highlights it. Without the offer, a drag onto a planeswalker found no
 * target and fell back to attacking the player (playtest 7 W14, playtest 8 X1).
 * Opponents' planeswalkers and every battle: a battle sits on its CASTER's
 * battlefield and is attacked by them, and Forge refuses a click on one this
 * seat protects (`:237-258` returns false), so the over-offer costs nothing.
 */
function attackDefenders(match: LiveMatch, view: BoardView): ReadonlySet<number> | null {
  if (!declaringAttackers(match)) return null;
  const out = new Set<number>();
  for (const p of view.players) {
    for (const c of p.battlefield) {
      const type = c.card.typeLine;
      if (type.includes('Battle') || (!p.isViewer && type.includes('Planeswalker'))) out.add(c.id);
    }
  }
  return out;
}

/** What a drop of `attacker` on `target` sends while attacks are declared. */
export type AttackAssignment = 'assign' | 'already' | null;

/**
 * Whether dropping `attacker` on `target` assigns it to that defender — and so
 * whether the frames go out DEFENDER FIRST.
 *
 * `InputAttack` has no "attack that" click: a click on a defender sets
 * `currentDefender`, and the next click on a creature declares it against
 * whichever defender is current (`InputAttack.java:237-252`). `already` is the
 * drop that would TOGGLE: re-clicking an attacker already attacking the current
 * defender undeclares it (`:192-224`), so a drop on the defender it is already
 * attacking sends nothing. Read off Forge's own `CombatView`.
 */
export function attackAssignment(match: LiveMatch, attacker: number, target: { kind: 'card' | 'player'; id: number }): AttackAssignment {
  const view = match.view;
  if (view === null || !declaringAttackers(match)) return null;
  const me = view.players.find((p) => p.isViewer);
  if (me === undefined || !me.battlefield.some((c) => c.id === attacker)) return null;
  const isDefender =
    target.kind === 'player'
      ? view.players.some((p) => p.id === target.id && !p.isViewer)
      : (attackDefenders(match, view)?.has(target.id) ?? false);
  if (!isDefender) return null;
  const band = (view.combat ?? []).find((b) => b.attackers.includes(attacker));
  if (band !== undefined && band.defender.kind === target.kind && band.defender.id === target.id) return 'already';
  return 'assign';
}

/** Forge has marked `target` (a card or a player) as its input's current one. */
export function isMarked(match: LiveMatch, target: { kind: 'card' | 'player'; id: number }): boolean {
  const set = target.kind === 'card' ? match.highlighted : match.highlightedPlayers;
  return set?.has(target.id) === true;
}

/**
 * Run `then` once Forge has marked `target` — the proof it APPLIED the click that
 * made it current — and not before.
 *
 * Two clicks sent back to back can be applied in either order: Forge's server
 * runs every incoming client message on a thread of its own
 * (`GameProtocolHandler.channelRead` → `FThreads.invokeInBackgroundThread`, a
 * `new Thread` per message). A planeswalker drag is defender-then-attacker and a
 * block is attacker-then-blocker; when the second thread won, the attack went to
 * the player or the block to the wrong attacker (playtest 8 X1, one drag in five
 * against real Forge). Forge marks the new current defender or attacker
 * (`InputAttack.setCurrentDefender`, `InputBlock.setCurrentAttacker`), so the
 * second click waits for that mark. If the mark never comes, Forge refused the
 * first click, and the second is not sent: sending it would act on whatever was
 * current before.
 */
export function afterMarked(match: LiveMatch, target: { kind: 'card' | 'player'; id: number }, then: () => void, timeoutMs = 2000): void {
  if (isMarked(match, target)) { then(); return; }
  let done = false;
  const finish = (go: boolean): void => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    if (go) then();
  };
  const unsubscribe = subscribe(match, () => { if (isMarked(match, target)) finish(true); });
  const timer = setTimeout(() => finish(false), timeoutMs);
}

/**
 * Whether dragging `blocker` onto `attacker` is a block assignment — and so
 * whether the two `selectCard`s go out ATTACKER FIRST (§B.3).
 *
 * The order is `InputBlock`'s, not a preference: a click on an attacker sets
 * `currentAttacker`, and only the click AFTER that becomes its blocker
 * (`InputBlock.java:112-160`). Sending the blocker first would assign it to
 * whichever attacker Forge had auto-selected and then move the cursor to the
 * one the player actually pointed at — two right frames in the wrong order,
 * which is a wrong block.
 */
export function isBlockAssignment(match: LiveMatch, blocker: number, attacker: number): boolean {
  const view = match.view;
  if (view === null) return false;
  const targets = blockTargets(match, view);
  if (targets === null || !targets.has(attacker)) return false;
  const me = view.players.find((p) => p.isViewer);
  return me !== undefined && me.battlefield.some((c) => c.id === blocker);
}

/** What `attackIntents` can say about a card this seat pointed at. */
export type AttackIntent = 'sent' | 'declared' | 'refused';

/**
 * Remember that this seat pointed at a card as an attacker. Called from
 * `selectCard`, so a CLICK marks exactly as a box-draw does.
 */
function noteAttackIntent(match: LiveMatch, cardId: number): void {
  if (!declaringAttackers(match)) return;
  // A click on a defender picks what to attack; only the seat's own cards attack.
  if (!match.view!.players.some((p) => p.isViewer && p.battlefield.some((c) => c.id === cardId))) return;
  const turn = match.view!.turn;
  if (match.attackIntent === null || match.attackIntent.turn !== turn) match.attackIntent = { turn, ids: new Set() };
  match.attackIntent.ids.add(cardId);
}

/**
 * The intent marks to draw, keyed by card id — §B.1, and the place the
 * disagreement is kept visible rather than papered over.
 *
 * Three answers, and the third is the point:
 *
 *  - `declared` — Forge's own `Attacking` says so. Its truth, and it has caught
 *    up with the intent.
 *  - `sent` — the click is out and Forge has not answered yet (`spent` still
 *    holds the id; every input frame clears it).
 *  - `refused` — Forge answered and the card is still NOT attacking. That is a
 *    disagreement between what the player pointed at and what the engine did,
 *    and it is SHOWN. `pushAttackerCandidates` drops already-declared attackers
 *    (`PlayerControllerHuman.java:1613-1614`), so an id Forge re-offers after
 *    taking our click is an id it did not declare.
 *
 * **Nothing here is Forge's tapped state.** `BoardCard.tapped` stays the only
 * source for that, and an intent mark on an untapped card leaves it untapped.
 * Forge taps an attacker when the declaration lands; until then the mark says
 * "you pointed at this", which is a different claim.
 */
export function attackIntents(match: LiveMatch): ReadonlyMap<number, AttackIntent> {
  const out = new Map<number, AttackIntent>();
  const view = match.view;
  if (view === null || !declaringAttackers(match)) return out;
  const held = match.attackIntent;
  if (held === null || held.turn !== view.turn) return out;
  const me = view.players.find((p) => p.isViewer);
  if (me === undefined) return out;
  for (const card of me.battlefield) {
    if (!held.ids.has(card.id)) continue;
    out.set(card.id, card.attacking ? 'declared' : match.spent.cards.has(card.id) ? 'sent' : 'refused');
  }
  return out;
}

/**
 * Say that a question answered itself — wave 20 §B, the client half of w19's
 * rule that no shortcut is silent.
 *
 * The line goes in the same log the server's own `message` notifies feed
 * (`says`, display only, capped at `SAYS_KEPT`), because to the player there is
 * no difference between "the server passed a stop for me" and "my click cast
 * the spell without asking which ability". It is not sent anywhere and does not
 * survive a snapshot; the frames that DO survive — `paid …` — are the server's.
 */
export function noteAutoAnswered(match: LiveMatch, what: string): void {
  match.says.push(`played ${what}`);
  if (match.says.length > SAYS_KEPT) match.says.shift();
  notify(match);
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
  // The server re-sends the open selection, the marks and the actionable set
  // after the snapshot (wave 31 §S: `resendAfterSnapshot` keeps them per
  // seat), as normal frames. What this client held from before is replaced by
  // those, so it is dropped here rather than trusted.
  match.selectables = null;
  match.weaklySelectable = null;
  match.weaklySelectableManaOnly = null;
  match.highlighted = null;
  match.highlightedPlayers = null;
  // The log, like the asks: the server re-sends its kept says after the
  // snapshot, so a line that survives from before is not trusted.
  match.says = [];
  match.inputLive = false;
  match.over = false;
  match.finished = false;
  unspend(match);
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
function statePacket(match: LiveMatch): WirePacket & { stackTargetSpells: readonly (readonly [number, number])[] } {
  return {
    seq: match.forgeSeq,
    checksum: 0,
    checksumProperties: [],
    newObjects: Object.fromEntries(match.state),
    objectDeltas: {},
    events: [],
    // Carried forward exactly like the rest of this re-seed packet (wave 49
    // §A): `foldPackets` only REPLACES `stackTargetSpells` when a later
    // packet names it, so without this a batch whose frames happen not to
    // (there are none today — every live `applyDelta`/`setGameView` carries
    // it — but a historical replay might) would wipe what was already known.
    stackTargetSpells: [...match.stackTargetSpells],
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
      const { gameView, sequenceNumber, stackTargetSpells } = frame.payload;
      packets = [
        {
          seq: sequenceNumber,
          checksum: 0,
          checksumProperties: [],
          newObjects: gameView,
          objectDeltas: {},
          events: [],
          stackTargetSpells,
        },
      ];
      changed = true;
    } else if (frame.method === 'applyDelta') {
      packets.push({ ...frame.payload.packet, stackTargetSpells: frame.payload.stackTargetSpells });
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
  match.stackTargetSpells = folded.stackTargetSpells;
  redraw(match);
}

function redraw(match: LiveMatch): void {
  const before = match.view;
  match.view =
    match.playerId === null || match.state.size === 0
      ? null
      : toBoardView(match.state, match.forgeSeq, {
          viewerPlayerId: match.playerId,
          // `null` (seats never arrived) and an empty `Map` (they arrived, and
          // named no avatars) both mean "pass nothing" to the adapter — see the
          // field's own note on why the two are still kept apart in STATE.
          avatarByPlayerId: match.avatarByPlayerId ?? undefined,
          nameByPlayerId: match.nameByPlayerId ?? undefined,
          stackTargetSpells: match.stackTargetSpells,
        });
  if (match.view?.gameOver === true) match.over = true;
  noteTaps(match, before);
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
    unspend(match);
    return;
  }
  if (INPUT_FRAMES.has(frame.method)) unspend(match);
  if (frame.kind === 'notify' && frame.method === 'showPromptMessage') {
    match.prompt = typeof frame.message === 'string' ? frame.message : null;
    // Overwritten by EVERY prompt, including with null. That is what makes it
    // fresh: see the field's note, and `payingMana`.
    match.promptCard = frame.card === null ? null : frame.card.id;
    match.inputLive = true;
  } else if (frame.kind === 'notify' && frame.method === 'updateButtons') {
    match.buttons = {
      label1: typeof frame.label1 === 'string' ? frame.label1 : 'OK',
      label2: typeof frame.label2 === 'string' ? frame.label2 : 'Cancel',
      enable1: frame.enable1 === true,
      enable2: frame.enable2 === true,
    };
    match.inputLive = true;
  } else if (frame.kind === 'notify' && frame.method === 'setSelectables') {
    match.selectables = {
      cards: new Set(frame.cards.map((c) => c.id)),
      min: frame.min,
      max: frame.max,
      players: frame.players === undefined ? null : new Set(frame.players.map((p) => p.id)),
    };
    match.inputLive = true;
  } else if (frame.kind === 'notify' && frame.method === 'clearSelectables') {
    match.selectables = null;
    // The marks belonged to the input that has just stopped. Forge unmarks them
    // itself (`InputSelectManyBase.resetUsedToPay`, `InputLondonMulligan.done`),
    // but the order of the two frames is that input's business, not ours, and a
    // mark that outlived its input is an affordance nothing would take.
    match.highlighted = null;
    match.highlightedPlayers = null;
    match.inputLive = false;
    match.lastSelectedCard = null;
  } else if (frame.kind === 'notify' && frame.method === 'setHighlighted') {
    // INCREMENTAL, unlike the two frames either side of it: fold, never
    // replace. Cards only — see the field's note on why a marked player is not
    // a clickable one. An empty result stays a set: Forge has spoken.
    const next = new Set(match.highlighted ?? []);
    const players = new Set(match.highlightedPlayers ?? []);
    for (const entity of frame.entities) {
      const into = entity.kind === 'card' ? next : players;
      if (frame.on) into.add(entity.id);
      else into.delete(entity.id);
    }
    match.highlighted = next;
    match.highlightedPlayers = players;
    match.inputLive = true;
  } else if (frame.kind === 'notify' && frame.method === 'setWeaklySelectable') {
    // Forge's list is WEIGHTED (a card twice when the auto-tap preview names
    // it too); membership is the whole of what a board needs.
    match.weaklySelectable = new Set(frame.cards.map((c) => c.id));
    // Wave 53 T: the SAME frame's `manaOnly` (w52 §S), read alongside it.
    // `undefined` (the bridge could not classify) stays `null`, never an
    // empty set — see the field's own note on `LiveMatch`.
    match.weaklySelectableManaOnly = frame.manaOnly === undefined ? null : new Set(frame.manaOnly.map((c) => c.id));
    match.inputLive = true;
  } else if (frame.kind === 'notify' && frame.method === 'finishGame') {
    match.finished = true;
  } else if (frame.kind === 'notify' && frame.method === 'showErrorDialog' && frame.title === MATCH_ENDED_TITLE) {
    // The server's own ending notice (`Match.endNotice`): the match cannot
    // continue, whatever the board still shows.
    match.over = true;
  } else if (frame.kind === 'notify' && frame.method === 'message') {
    // Display only — see the module header. Not an input frame, not an answer:
    // nothing below this line reads it back, on purpose.
    if (frame.message !== '') {
      match.says.push(frame.message);
      if (match.says.length > SAYS_KEPT) match.says.shift();
    }
  } else if (frame.kind === 'notify' && frame.method === 'clearWeaklySelectable') {
    // The input that offered them has stopped. `inputLive` is NOT cleared
    // here: Forge clears the set at the END of priority and again at the start
    // of payment, with the prompt and bar for the next input still standing.
    // With nothing named, nothing is offered either way.
    match.weaklySelectable = null;
    match.weaklySelectableManaOnly = null;
  }
  foldFrames(match, [frame]);
}

/** The frames Forge sends when an input shows, refreshes or stops: "Forge spoke". */
const INPUT_FRAMES: ReadonlySet<string> = new Set([
  'showPromptMessage',
  'updateButtons',
  'setSelectables',
  'clearSelectables',
  'setHighlighted',
  'setWeaklySelectable',
  'clearWeaklySelectable',
]);

function unspend(match: LiveMatch): void {
  match.spent = { cards: new Set(), players: new Set() };
}

function discardLocal(match: LiveMatch): void {
  match.cursor = null;
  match.state = new Map();
  match.forgeSeq = 0;
  match.skippedDeltas = 0;
  match.view = null;
  match.asks = [];
  match.prompt = null;
  match.promptCard = null;
  match.buttons = null;
  match.selectables = null;
  match.weaklySelectable = null;
  match.weaklySelectableManaOnly = null;
  match.highlighted = null;
  match.highlightedPlayers = null;
  match.says = [];
  match.inputLive = false;
  match.attackIntent = null;
  match.lastSelectedCard = null;
  match.tapOrder = [];
  match.stackTargetSpells = new Map();
  match.avatarByPlayerId = null;
  match.nameByPlayerId = null;
  match.waitingOn = null;
  match.coinToss = null;
  match.over = false;
  match.finished = false;
  unspend(match);
}
