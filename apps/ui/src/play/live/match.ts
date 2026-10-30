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

import { POOL_COLORS } from '@hadoku/deck';
import type { ClientEvent, ManaColor, Placement, RememberedTrigger } from '@hadoku/shared';
import { ART_EVENT, asSeqCursor, CLIENT_EVENT, DECK_COLORS_EVENT, DeckColorsSchema, LIFE_PAYMENT, LIFE_PER_CLICK, selfAnswer } from '@hadoku/shared';
import {
  REPLY_SCHEMAS,
  safeParseServerFrame,
  type BlockingMethod,
  type CardRef,
  type ClientAbort,
  type EndedBy,
  type GameEntityRef,
  type GameLogLine,
  type Loss,
  type ServerFrame,
  YIELDING,
  DELTA_TYPE,
  deltaKey,
  intOf,
  strOf,
} from '@hadoku/forge-wire';
import { classifySeq, needsResync, type SeqVerdict } from '@wolffm/rooms-protocol';
import { io } from 'socket.io-client';

import { defaultSocketPath } from '../../draft/socket.ts';
import { normalizeAvatarId } from '../../room/avatar.ts';
import { attackLockedIn, drawsFaceUp, manaCostTokens, toBoardView, viewerOf, type BoardCard, type BoardView, type DamageHit, type DeathCause, type FaceHit, type PoolColor } from '../adapter.ts';
import type { Revealed } from './numbers.ts';
import { shownFlip, shownRoll, type ShownFlip, type ShownRoll } from './shown.ts';
import { preloadMatchArt } from './art-preload.ts';
import { pressableBar, type BarHold } from './bar-hold.ts';
import { drawnOfferOf, dropMarked, resolvedByAnother, type OfferHold, type Pressed } from './offer-hold.ts';
import { holdStands, lapseHold } from './timed-hold.ts';
import { mistakeOfAutoCancel, mistakeOfClick, type MistakeKey } from './mistakes.ts';
import { SELF_ANSWERING } from '../prompts/answer-table.ts';
import type { PromptParts } from '../prompts/lookup.ts';
import { foldPackets, type FoldablePacket, type FoldResult, type WireState } from '../fold.ts';
import { expectWirePackets } from '../wire.ts';
import { timed } from './work-meter.ts';
import { pageTabId } from './tab-id.ts';
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
  PhaseStopSchema,
  phaseStopFrame,
  replyFrame,
  stopPreferenceFrame,
  triggerDecisionFrame,
  TriggerDecisionsSchema,
  type ClientEnvelope,
  type MatchRequest,
  type MatchSnapshot,
  type StopPhase,
  type TransportIssue,
  type WireCursor,
} from './transport.ts';

/** Any blocking ask, as parsed. */
export type LiveAsk = Extract<ServerFrame, { kind: 'ask' }>;
export type RevealAsk = Extract<LiveAsk, { method: 'getChoices' }>;

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

const DEFAULT_ACK_TIMEOUT_MS = 10_000;

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
/** The rolls, and the flips, a match keeps for the table to draw: more than one view can bring at once. */
export const ROLLS_KEPT = 8;

/**
 * One line of the log: its words, and — for a line of Forge's own game log —
 * its entry type and the cards it names that this seat may see, by id.
 */
export interface Say {
  text: string;
  log: GameLogLine | null;
}

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
  /** Asks re-sent after this client had already answered them, dropped ({@link LiveMatch.settled}). */
  reasksDropped: number;
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
  /** Why Forge would refuse button one now (the wire's `refusal1`): a press is not sent while it is set. */
  refusal1?: string;
}

/** Why a held card may not be cast: the card whose effect forbids it, and for how long (Forge's `Duration`, counted from `durationPlayer`). */
export interface CastForbidden {
  readonly source: string;
  readonly duration?: string;
  readonly durationPlayer?: number;
}

/** What continuous effects change about a held card (the bridge's `heldChanges`): its cost now, by whom, and a granted flash. */
export interface HeldChange {
  /** The cost now and as printed, as cost tokens (`adapter.ts`'s `manaCostTokens`), with the cards that changed it. Absent when unchanged. */
  readonly cost?: {
    readonly now: readonly string[];
    readonly printed: readonly string[];
    readonly by: readonly string[];
    /** Whether its mana value went down or up (`same` for a change of colour alone). */
    readonly change: 'less' | 'more' | 'same';
  };
  /** The card that lets it be cast as though it had flash. */
  readonly flashBy?: string;
}

/** Its folded state and the bridge's state facts beside it (`../fold.ts`), which `../adapter.ts`'s `toBoardView` draws. */
export interface LiveMatch extends Omit<FoldResult, 'seq'> {
  readonly matchId: string;
  /** From the snapshot. Null until one lands. */
  seat: number | null;
  /** This seat's Forge player id, from the snapshot. Null until one lands. */
  playerId: number | null;
  /** Where we are in OUR stream (per recipient). Null: nothing applied yet. */
  cursor: WireCursor | null;
  /** Forge's own `DeltaPacket.seq` of the last packet folded. */
  forgeSeq: number;
  /** What `Board` draws. Null until there is a state AND a viewer. */
  view: BoardView | null;
  /**
   * Every question open for this player, oldest first. See the module header:
   * a queue, because the server may hold more than one.
   */
  asks: LiveAsk[];
  /**
   * Every callId this client has replied to or aborted, on this connection to
   * this match process. A snapshot's re-send of the open asks can leave the
   * server after an answer did but before the server read it; the ask it
   * re-sends is one this client has settled, and drawing it again would offer
   * a second answer the server refuses (`stale-reply`). Kept across a resync
   * (one live connection delivers the answer in order), emptied by a join (an
   * answer sent around a reconnect may never have arrived, and the server's
   * re-send is then the question still open) and by an epoch change (a new
   * process numbers its asks afresh).
   */
  settled: Set<string>;
  /**
   * The last reveal Forge was already answered for (an envelope marked
   * `displayOnly`, `@hadoku/shared`'s `ServerEnvelope`) that shows a card the
   * board does not draw: the notice's (`../prompts/RevealNotice.tsx`). Cards to
   * show, never a question, so never in {@link LiveMatch.asks}. Cleared by the
   * next real question ({@link applyFrame}), by {@link dismissReveal}, and by
   * anything that drops local state.
   */
  reveal: RevealAsk | null;
  /**
   * The last reveal of any kind — on the board or in the notice — its cards and
   * when it arrived, handed to the board for its beat (`numbers.ts`). Not
   * cleared by a question: what it resolves into comes after it. Not part of
   * the view: a fresh fold of the stream holds no reveal.
   */
  revealed: (Revealed & { readonly ask: RevealAsk }) | null;
  /**
   * The damage an open `assignCombatDamage` window assigns as it stands, by
   * card id, keyed to that ask's call — the board echoes it on the cards
   * ({@link damagePreviewOf}). Stale the moment its ask is no longer open.
   */
  damagePreview: { callId: string; amounts: ReadonlyMap<number, number> } | null;
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
  /**
   * The optional trigger the current prompt asks about — its Forge storage key
   * and host card's name — or null. From the same frame as {@link prompt}
   * (`confirmAbility.trigger`), so it is exactly as fresh.
   */
  promptTrigger: { key: string; name: string } | null;
  /** {@link prompt} split into its decision and the ability text before it (`promptLines`), or null. From the same frame. */
  promptParts: PromptParts | null;
  /**
   * The floating pool's colours a press pays part of the open payment with (`PlayBridge.java`'s
   * `poolPays`), or null. From the same frame as {@link prompt}; spent ({@link payFromPool}) until
   * Forge's next one.
   */
  promptPoolPays: readonly PoolColor[] | null;
  /** The pool pays the open payment more than one way (`PlayBridge.java`'s `poolHasChoice`), from the same frame. */
  promptPoolChoice: boolean;
  /** The optional triggers Forge answers for this seat, from the server's `forge:trigger-decisions`. */
  triggerDecisions: readonly RememberedTrigger[];
  /**
   * Your deck's colours, from the server's `forge:deck-colors`: what the match's
   * music is picked from (`../../sound/match-music.ts`). `undefined` until the
   * server has said; `null` when you hold no deck it knows (a watcher).
   */
  deckColors: readonly ManaColor[] | null | undefined;
  buttons: LiveButtons | null;
  /**
   * The one client-side hold on {@link LiveMatch.buttons} (`./bar-hold.ts`): set by
   * {@link pressButton}, cleared by the next `updateButtons`, and never standing longer than
   * `HOLD_MAX_MS`. Read the bar a seat may press through {@link liveBar}, never by
   * editing `buttons`.
   */
  barHold: BarHold | null;
  /**
   * The first half of a Forge window — a `showPromptMessage` or an `updateButtons` the server
   * marked `pairsWithNext` — held until its partner, the next frame, arrives, so the two are
   * applied together and {@link prompt} and {@link buttons} always belong to the same input.
   * Forge sends the halves in each input's own order (a confirm's Yes/No before its question,
   * a selection's question before its bar), so applying each as it came drew one input's line
   * under another's buttons for a frame.
   */
  windowHalf: ServerFrame | null;
  /** Forge's current selection, from `setSelectables`. Null: none is open. */
  selectables: LiveSelectables | null;
  /**
   * What was SAID to this seat — `message` notifies: Forge's own game log as
   * this seat may read it, and whether full control is on. Display only; see
   * the module header. Newest last, capped at `SAYS_KEPT`.
   */
  says: Say[];
  /**
   * The die rolls this seat was told of as they came (`message`'s `roll`), each numbered once for the
   * page's life (`./dice.ts` draws a number it has not drawn), newest last, capped at `ROLLS_KEPT`. A
   * snapshot starts it empty: a roll it would bring back is history, read in the log.
   */
  rolls: ShownRoll[];
  /** The coin flips this seat was told of (`message`'s `flip`), kept as `rolls` are, for the table to draw (`./coin-flip.ts`). */
  flips: ShownFlip[];
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
   * frame (`packages/forge-wire/src/tier-b.ts`) — the offered cards with no
   * non-mana play the seat can make now (a land, a mana rock like a Signet, a
   * man-land whose animation it cannot pay for), read by the bridge off Forge's
   * abilities and its affordability test, never card text.
   * `null` the same way `weaklySelectable: null` is: Forge has not said (the
   * field was absent on the frame, or the set was last cleared) — never an
   * empty set standing in for "nothing here is mana-only". Read by
   * `nothingToDecide`, below, folded in alongside the viewer's own
   * battlefield lands.
   */
  weaklySelectableManaOnly: ReadonlySet<number> | null;
  /**
   * The cards this seat holds that an effect forbids it to cast, by id, from
   * the bridge's `castForbidden` on the last `setWeaklySelectable` that carried
   * it. Kept through `clearWeaklySelectable`: the effect outlasts the window,
   * and the next set replaces it. Null when the bridge has not said.
   */
  castForbidden: ReadonlyMap<number, CastForbidden> | null;
  /**
   * What continuous effects change about the cards this seat holds, by id, from
   * the bridge's `heldChanges` on the last `setWeaklySelectable` that carried
   * it — kept, and replaced, exactly as `castForbidden` is. Null when the
   * bridge has not said.
   */
  heldChanges: ReadonlyMap<number, HeldChange> | null;
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
   * The offer the board keeps DRAWING through Forge's silences (`./offer-hold.ts`): taken by
   * {@link selectCard}, {@link selectPlayer}, {@link pressButton} and Forge's `clearWeaklySelectable`,
   * read only by {@link drawnOffer}. Never a clickability signal — that is {@link boardInteraction},
   * always.
   */
  offerHold: OfferHold | null;
  /**
   * A press on a card only the held offer draws ({@link drawnOffer}): the outline said it could be
   * played, so the press is not refused — it is sent the moment Forge offers that card again
   * ({@link sendDeferredSelect}), and dropped if the hold ends without it or a selection opens.
   */
  deferredSelect: { cardId: number; placement: Placement | undefined } | null;
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
   * The card whose click began this seat's current act: a click with no
   * selection open and no payment running, so never a target or a land tapped
   * to pay. The card a refusal ({@link LiveMatch.refused}) marks.
   */
  actCard: number | null;
  /**
   * The card Forge just turned away (`flashIncorrectAction`: a click it would
   * refuse, or a payment the server cancelled because nothing can pay it),
   * for {@link REFUSED_MS}. `seq` tells a second refusal of the same card from
   * the first, so the mark is drawn again.
   */
  refused: { card: number; seq: number } | null;
  /**
   * the line the seat's own mistake bubble (`./MistakeBubble.tsx`) should say now, or null.
   * Set beside {@link refused} by one classifier (`./mistakes.ts`'s `mistakeOfClick` /
   * `mistakeOfAutoCancel`), never guessed twice: this seat's own `reportRefusedClick` for a board
   * click Forge never saw, and `refuse` for the one `flashIncorrectAction` cause that classifier can
   * tell apart from the other two. `seq` is its own counter — see {@link MISTAKE_MS} — so a second
   * mistake of the same kind still restarts the bubble's timer. Cleared on its own clock, never by
   * {@link dropOpenInput}: the game moves on to the next input well before {@link MISTAKE_MS} is up,
   * and the bubble must not vanish the instant it does.
   */
  mistake: { key: MistakeKey; seq: number } | null;
  /**
   * The latest damage hits each `applyDelta` carried (`PlayBridge.java`'s `damage`), numbered as they
   * came (`DamageHit.seq`) and kept to the last {@link HITS_KEPT}: an event, never folded into state,
   * so a view drawn after several frames at once still holds every one of their hits.
   */
  hits: readonly DamageHit[];
  /** The same for the damage dealt to players (`PlayBridge.java`'s `faceDamage`), numbered with `hits`. */
  faceHits: readonly FaceHit[];
  /** The `seq` the next hit gets. */
  nextHitSeq: number;
  /** Why each permanent that died lately died (`PlayBridge.java`'s `deaths`), by card id, the last {@link HITS_KEPT}. */
  deathCauses: ReadonlyMap<number, DeathCause>;
  /**
   * AE27 — stack item ids that left the stack lately not by resolving cleanly (`PlayBridge.java`'s
   * `counteredStackItems`): a direct counter, or a fizzle (its own target gone when its turn to
   * resolve came). An event, never folded into state, kept to the last {@link HITS_KEPT} — the same
   * shape as {@link deathCauses}, since `live/placed.ts` only ever needs to know this ONCE, the
   * render where the item departs the stack.
   */
  counteredStackItems: ReadonlySet<number>;
  /**
   * How many identical triggers or copies of one spell still wait for their targets behind the open target question
   * (`showPromptMessage.targetAbility.more`), 0 for any other prompt. Above 0 the question offers
   * "same target for all".
   */
  promptTargetMore: number;
  /**
   * What the open selection is choosing (`showPromptMessage.selection`): `targets` true for a target choice,
   * false for any other pick — a cost's sacrifice or discard. `aimed` is what the ability that pick pays for
   * is already aimed at. Null for a prompt with no selection, or a bridge that could not tell.
   *
   * `sacrifice`, `offBattlefield` and `keepOne` are AF397's own fields (`PlayBridge.java`'s
   * `openSelection`) — see {@link doomAskOf}, the one place this client reads any of them.
   */
  promptSelection: {
    targets: boolean;
    aimed: readonly GameEntityRef[];
    sacrifice?: { cards: readonly CardRef[]; min: number; max: number };
    offBattlefield?: { cards: readonly CardRef[] };
    keepOne?: { cards: readonly CardRef[] };
  } | null;
  /** "Same target for all" ticked on the open target question: the seat's pick goes out with `sameTarget`. */
  sameTarget: boolean;
  /**
   * This seat's full-control toggle. The server's word after every snapshot,
   * this client's own last word in between. Off by default — and off is also
   * what a page that has not yet been answered a snapshot must draw, because
   * the alternative is drawing a hatch nobody opened.
   */
  fullControl: boolean;
  /**
   * This seat's End step checkbox — the opponent's End step held for a real play —
   * this client's own last word, same shape as `fullControl` but with no
   * server echo: `forge:stop-preference` is client → server only
   * (`apps/server/src/play/transport.ts`'s own `StopPreferenceSchema` note),
   * because unlike full control nothing about the ANSWER changes server-side
   * in a way this client needs told back — `Match.setStopPolicy` folds it
   * into the seat's `StopPolicy` and the next stop simply does or does not
   * fire. On by default, which is also the server's own default
   * (`DEFAULT_STOP_POLICY.stopWithPlayOnTheirTurn`).
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
   * This seat's one-shot stop at a phase, or null. The server holds it and
   * clears it once spent: its word after every snapshot and every change, this
   * client's own last word in between.
   */
  phaseStop: StopPhase | null;
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
   * The face of the seat nobody holds — Forge's AI, playing as one of the room's
   * characters (2026-10-19). It never opens a view, so `forge:seats` never names
   * its Forge player: the board gives it to the player no seat has named.
   */
  unclaimedAvatar: string | null;
  /**
   * The name Forge shows for each seat, keyed by Forge PLAYER id — wave 31 §S,
   * from `forge:seats`' `name`. Same three-state rule as
   * {@link LiveMatch.avatarByPlayerId}: `null` until the seat table has
   * arrived, then a real Map holding only the seats the server named.
   */
  nameByPlayerId: ReadonlyMap<number, string> | null;
  /**
   * Each SEAT's Forge player id, from `forge:seats`' `playerId` (2026-10-12).
   * The join key for anything the server stamps with a seat and the board
   * keeps by player — an arrangement or a placement echo
   * (`arrangement-sync.ts`, `presence.ts`). A player's own window could read
   * "the other seat" off `isViewer`; a watcher cannot, because every echo is
   * someone else's and its bottom side follows the turn. Same three-state
   * rule as {@link LiveMatch.avatarByPlayerId}: `null` until the seat table
   * has arrived, then a real Map holding only the seats Forge has named.
   */
  playerIdBySeat: ReadonlyMap<number, number> | null;
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
  /** The seats whose player left, past the server's grace — `forge:seats`' `away`. */
  awaySeats: ReadonlySet<number>;
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
   * why nothing happens. False until told otherwise. The same tab coming back
   * (a reconnect, a reload) is not another connection: its join carries
   * {@link tabId} and the server hands it the seat at once.
   */
  spectator: boolean;
  /**
   * This connection holds NO seat: it was sent the watchers' projection
   * (`forge:role` `watcher`, 2026-10-12), which sees every hand (2026-10-28).
   * No prompt ever arrives, and nothing it does is sent. A watcher is also a
   * `spectator` (every gate that keeps a spectator's hands off the table holds
   * for it); this flag is what the board reads for the differences — the
   * controls are not drawn at all, both hands are face up, and whoever's turn
   * it is is drawn at the bottom ({@link viewerPlayerIdOf}).
   */
  watcher: boolean;
  /**
   * This screen has seen the current Declare Attackers step's attack locked in (`attackLockedIn`), kept
   * until the step ends: once the attacker passes, a vigilant attack looks on the wire as it did mid-pick.
   */
  attackLocked: boolean;
  /**
   * The match has ended: the server's `ended` notice (`showErrorDialog`
   * marked `matchEnded`) or its `finishGame` has arrived, or Forge's own view says `GameOver`.
   * Sticky until a snapshot replaces the board, which re-sends the notice.
   */
  over: boolean;
  /**
   * The server's `finishGame` has arrived: the game is over for certain, even
   * when the view's `GameOver` property never does (its delta is whatever
   * flush follows the end, and sometimes none does). The server sends it to
   * every seat the moment Forge's game is over. Reset by a snapshot, which the
   * server follows with the frame again.
   */
  finished: boolean;
  /**
   * The server's ending notice (`showErrorDialog` marked `matchEnded`), in its words: the match
   * cannot go on, and no game result is coming — the JVM died, the server is stopping. `null` until
   * one arrives; reset by a snapshot, which the server follows with the notice again.
   */
  ended: { title: string; message: string } | null;
  /**
   * Who lost, by player id, as the end notice told it: the game's result even when this screen's
   * view never caught up with the end. `null` until a notice that carries it arrives; reset with
   * `finished`.
   */
  losers: ReadonlySet<number> | null;
  /** Why each loser lost, by player id, as Forge decided it (`finishGame`'s `lost`). `null` like `losers`. */
  lost: ReadonlyMap<number, Loss> | null;
  /** The server ended the game itself (`finishGame`'s `endedBy`): a game called a draw after eight hours. `null` like `losers`. */
  endedBy: EndedBy | null;
  /** The most recent failure worth showing. Cleared when a snapshot lands. */
  lastError: string | null;
  /** Why the most recent malformed envelope or frame was refused. */
  lastInvalid: TransportIssue[] | null;
  lastVerdict: SeqVerdict | null;
  connected: boolean;
  everConnected: boolean;
  /** This browser tab's id (`tab-id.ts`), sent with every join so a reconnect is known for the same tab. */
  tabId: string;
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
  /** Defaults to this page's ({@link pageTabId}); a test that plays two tabs in one process passes its own. */
  tabId?: string;
  /**
   * Trouble before the board has a snapshot, told somewhere other than the socket — which is the
   * thing in trouble. A watcher's page sat on "Connecting…" and the server had no line about it
   * (the operator, 2026-10-20: *"we absolutely need logging"*).
   */
  report?: (what: MatchTrouble, detail: Record<string, unknown>) => void;
}

export type MatchTrouble = 'connect-error' | 'disconnected' | 'snapshot-failed' | 'no-snapshot';

/** How long a board may go without its first snapshot before it says so. */
export const NO_SNAPSHOT_REPORT_MS = 10_000;
/** A socket that cannot connect retries for good: its first few errors are the story. */
const CONNECT_ERRORS_REPORTED = 3;

/** Each board's watchdog, so `closeMatch` can stop it. */
const watchdogs = new WeakMap<LiveMatch, ReturnType<typeof setTimeout>>();
/** Each board's reporter: `snapshotFailed` reports through it. */
const reporters = new WeakMap<LiveMatch, NonNullable<LiveMatchOptions['report']>>();
/**
 * A board's last lost connection — socket.io's reason, when it was lost and, once the socket is
 * back, when — until its rejoin is answered and the board says so in the match log (`connection`).
 */
const drops = new WeakMap<LiveMatch, { reason: string; at: number; back: number | null }>();

/** What the board knows about its connection, for a report. */
function connectionFacts(match: LiveMatch): Record<string, unknown> {
  return {
    connected: match.connected,
    everConnected: match.everConnected,
    awaitingSnapshot: match.awaitingSnapshot,
    seat: match.seat,
    joins: match.stats.joins,
    snapshots: match.stats.snapshots,
    lastError: match.lastError,
  };
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
    reasksDropped: 0,
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
  // A reply or an abort settles its ask: one answer per callId leaves this client.
  if (frame.kind !== 'act') match.settled.add(frame.callId);
  const envelope: ClientEnvelope = { matchId: match.matchId, frame, ...(placement === undefined ? {} : { placement }) };
  match.transport.emit(MATCH_EVENTS.clientToServer, envelope);
}

/** A board with nothing in it yet, on `options`' transport. */
function newMatch(options: LiveMatchOptions): LiveMatch {
  const { seq: forgeSeq, ...folded } = foldPackets([]);
  return {
    matchId: options.matchId,
    seat: null,
    playerId: null,
    cursor: null,
    ...folded,
    forgeSeq,
    view: null,
    asks: [],
    settled: new Set(),
    reveal: null,
    revealed: null,
    damagePreview: null,
    prompt: null,
    promptCard: null,
    promptTrigger: null,
    promptParts: null,
    promptPoolPays: null,
    promptPoolChoice: false,
    triggerDecisions: [],
    deckColors: undefined,
    buttons: null,
    barHold: null,
    windowHalf: null,
    selectables: null,
    weaklySelectable: null,
    weaklySelectableManaOnly: null,
    castForbidden: null,
    heldChanges: null,
    highlighted: null,
    highlightedPlayers: null,
    says: [],
    rolls: [],
    flips: [],
    inputLive: false,
    spent: { cards: new Set(), players: new Set() },
    offerHold: null,
    deferredSelect: null,
    attackIntent: null,
    lastSelectedCard: null,
    actCard: null,
    refused: null,
    mistake: null,
    hits: [],
    faceHits: [],
    nextHitSeq: 1,
    deathCauses: new Map(),
    counteredStackItems: new Set(),
    promptTargetMore: 0,
    promptSelection: null,
    sameTarget: false,
    avatarByPlayerId: null,
    unclaimedAvatar: null,
    nameByPlayerId: null,
    playerIdBySeat: null,
    waitingOn: null,
    awaySeats: new Set(),
    coinToss: null,
    spectator: false,
    watcher: false,
    attackLocked: false,
    over: false,
    finished: false,
    ended: null,
    losers: null,
    lost: null,
    endedBy: null,
    fullControl: false,
    stopAtEndStep: true,
    autoYield: null,
    phaseStop: null,
    lastError: null,
    lastInvalid: null,
    lastVerdict: null,
    connected: false,
    everConnected: false,
    tabId: options.tabId ?? pageTabId(),
    awaitingSnapshot: false,
    resyncsWithoutProgress: 0,
    stats: emptyStats(),
    revision: 0,
    transport: options.transport ?? socketIoMatchTransport(),
    buffer: [],
    listeners: new Set(),
  };
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
  const match = newMatch(options);

  match.transport.on(MATCH_EVENTS.serverToClient, (payload) => {
    ingest(match, payload);
  });

  match.transport.on(MATCH_EVENTS.fullControl, (payload) => {
    adoptFullControl(match, payload);
  });

  match.transport.on(MATCH_EVENTS.phaseStop, (payload) => {
    const parsed = PhaseStopSchema.safeParse(payload);
    if (!parsed.success || parsed.data.matchId !== match.matchId || parsed.data.phase === match.phaseStop) return;
    match.phaseStop = parsed.data.phase;
    notify(match);
  });

  match.transport.on(MATCH_EVENTS.triggerDecisions, (payload) => {
    const parsed = TriggerDecisionsSchema.safeParse(payload);
    if (!parsed.success || parsed.data.matchId !== match.matchId) return;
    match.triggerDecisions = parsed.data.decisions;
    notify(match);
  });

  match.transport.on(MATCH_EVENTS.seats, (payload) => {
    adoptSeats(match, payload);
  });

  match.transport.on(MATCH_EVENTS.role, (payload) => {
    adoptRole(match, payload);
  });

  match.transport.on(DECK_COLORS_EVENT, (payload) => {
    const parsed = DeckColorsSchema.safeParse(payload);
    if (!parsed.success || parsed.data.matchId !== match.matchId) return;
    match.deckColors = parsed.data.colors;
    notify(match);
  });

  match.transport.on(ART_EVENT, (payload) => {
    preloadMatchArt(match.matchId, payload);
  });

  match.transport.on('connect', () => {
    // A reconnect re-joins, and so does a first connect whose first join timed out before it.
    const rejoin = match.everConnected || match.stats.snapshots === 0;
    match.connected = true;
    match.everConnected = true;
    const drop = drops.get(match);
    if (drop !== undefined && drop.back === null) drop.back = Date.now();
    if (rejoin) fetchSnapshot(match, 'join');
    notify(match);
  });

  match.transport.on('disconnect', (reason) => {
    match.connected = false;
    drops.set(match, { reason: String(reason), at: Date.now(), back: null });
    if (match.stats.snapshots === 0) options.report?.('disconnected', { reason: String(reason), ...connectionFacts(match) });
    notify(match);
  });

  const report = options.report;
  if (report !== undefined) {
    reporters.set(match, report);
    let connectErrors = 0;
    match.transport.on('connect_error', (error) => {
      connectErrors += 1;
      if (connectErrors > CONNECT_ERRORS_REPORTED) return;
      report('connect-error', { message: error instanceof Error ? error.message : String(error), attempt: connectErrors, ...connectionFacts(match) });
    });
    watchdogs.set(
      match,
      setTimeout(() => {
        if (match.stats.snapshots === 0) report('no-snapshot', { afterMs: NO_SNAPSHOT_REPORT_MS, ...connectionFacts(match) });
      }, NO_SNAPSHOT_REPORT_MS),
    );
  }

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
  const before = askedKey(match);
  match.asks.splice(i, 1);
  if (askedKey(match) !== before) redraw(match);
  return true;
}

/** Every card id a frame names as `{ kind: 'card', id }`, at any depth. */
function cardRefs(value: unknown, out: Set<number>): Set<number> {
  if (Array.isArray(value)) for (const v of value) cardRefs(v, out);
  else if (typeof value === 'object' && value !== null) {
    const o = value as { kind?: unknown; id?: unknown };
    if (o.kind === 'card' && typeof o.id === 'number') out.add(o.id);
    for (const v of Object.values(value)) cardRefs(v, out);
  }
  return out;
}

/** The cards the seat's open decision shows: Forge's prompt card and every card an open ask names (`AdaptOptions.promptCards`). */
function promptCardsOf(match: LiveMatch): Set<number> {
  const out = cardRefs(match.asks, new Set());
  if (match.promptCard !== null) out.add(match.promptCard);
  return out;
}

/** {@link promptCardsOf}'s ask half as one string: the board's known library tops depend on it. */
function askedKey(match: LiveMatch): string {
  return [...cardRefs(match.asks, new Set())].sort((a, b) => a - b).join(',');
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
 * Refuses button one while Forge says it would refuse it (`refusal1`).
 */
export function pressButton(match: LiveMatch, which: 'ok' | 'cancel'): boolean {
  const bar = liveBar(match);
  if (bar === null) return false;
  if (which === 'ok' ? !bar.enable1 || bar.refusal1 !== undefined : !bar.enable2) return false;
  // Forge's game thread is parked on the open question; a press now would
  // reach whichever input is current once it is answered.
  if (match.asks.length > 0) return false;
  // A pass: the offer stays drawn until Forge names the next one (`./offer-hold.ts`); a press kept
  // under the old hold belonged to the window this answers.
  match.deferredSelect = null;
  const drawn = drawnOffer(match);
  if (!drawn.selectionOpen) holdOffer(match, drawn);
  send(match, { kind: 'act', method: which === 'ok' ? 'selectButtonOk' : 'selectButtonCancel' });
  // Forge sends a fresh bar for the next decision; until it does, the bar we
  // just answered must not be pressable twice.
  holdBar(match, which === 'ok' ? 'pressed-ok' : 'pressed-cancel');
  match.stats.replies += 1;
  notify(match);
  return true;
}

/** The bar this seat may press now: Forge's latest, unless {@link LiveMatch.barHold} still stands. */
export function liveBar(match: LiveMatch): LiveButtons | null {
  return pressableBar(match.buttons, match.barHold, Date.now());
}

/**
 * Hold the bar back — the ONLY way this client keeps a live bar from being pressed. The next
 * `updateButtons` lifts it; if none comes within `HOLD_MAX_MS`, Forge kept the input it
 * showed, and the bar and the board's clicks are live again as they were.
 */
function holdBar(match: LiveMatch, reason: string): void {
  const hold: BarHold = { reason, since: Date.now() };
  const wasLive = match.inputLive;
  match.barHold = hold;
  match.inputLive = false;
  lapseHold(hold, () => match.barHold, () => {
    match.barHold = null;
    match.inputLive = wasLive;
    notify(match);
  });
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
 * Set this seat's stop at `phase`'s next occurrence, or clear it with null, and
 * tell the server. The phase rail's own sender. Optimistic, as `setFullControl`.
 */
export function setPhaseStop(match: LiveMatch, phase: StopPhase | null): boolean {
  if (match.phaseStop === phase) return false;
  match.transport.emit(MATCH_EVENTS.phaseStop, phaseStopFrame(match.matchId, phase));
  match.phaseStop = phase;
  notify(match);
  return true;
}

/**
 * Have Forge answer one optional trigger itself (`ACCEPT`/`DECLINE`) or ask
 * again (`ASK`). The server echoes the seat's whole remembered list back on
 * `forge:trigger-decisions`, which is what {@link LiveMatch.triggerDecisions}
 * holds — nothing here is optimistic.
 */
export function setTriggerDecision(match: LiveMatch, key: string, decision: 'ACCEPT' | 'DECLINE' | 'ASK'): void {
  match.transport.emit(MATCH_EVENTS.triggerDecision, triggerDecisionFrame(match.matchId, key, decision));
}

/**
 * Flip this seat's End step checkbox and tell the server. The settings
 * panel's own sender, and the only one: `forge:stop-preference` folds into
 * the seat's `StopPolicy` (`apps/server/src/play/socket.ts`'s handler),
 * toggling `END_OF_TURN` in or out of `stopWithPlayOnTheirTurn` without
 * touching any other field of it.
 *
 * `force` re-sends even when the local flag already agrees — the settings
 * panel's own mount effect uses it to push a PERSISTED preference (read back
 * from `@wolffm/prefs-client` on a returning viewer) into a freshly joined
 * match, whose server-side `StopPolicy` starts from `DEFAULT_STOP_POLICY`
 * and has no memory of a preference set in an earlier match. Without `force`
 * a persisted OFF would no-op against the client's own initial value, and
 * the server would keep its default (on).
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
 * changes mid-game (`Match.seatAvatarChanged`), so this is the one place
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
  const unclaimed = parsed.value.seats.find((seat) => !seat.claimed && seat.playerId === null);
  match.unclaimedAvatar = unclaimed === undefined ? null : normalizeAvatarId(unclaimed.avatarId);
  const names = new Map<number, string>();
  for (const seat of parsed.value.seats) {
    if (seat.playerId !== null && seat.name !== undefined) names.set(seat.playerId, seat.name);
  }
  match.nameByPlayerId = names;
  const bySeat = new Map<number, number>();
  for (const seat of parsed.value.seats) {
    if (seat.playerId !== null) bySeat.set(seat.seat, seat.playerId);
  }
  match.playerIdBySeat = bySeat;
  // Keyed by SEAT, not player id — a seat can hold an open
  // ask before `openView` has named its Forge player (an early mulligan
  // confirm, for one), and the fact must still reach the viewer then.
  const waitingOn = new Map<number, { method: string; hostCard: string | null }>();
  for (const seat of parsed.value.seats) {
    if (seat.waitingOn !== undefined) waitingOn.set(seat.seat, seat.waitingOn);
  }
  match.waitingOn = waitingOn;
  // The decision has left this seat: whatever it held is not drawn again (`./offer-hold.ts`).
  if (waitingOnAnother(match)) match.offerHold = null;
  match.awaySeats = new Set(parsed.value.seats.filter((seat) => seat.away === true).map((seat) => seat.seat));
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
  const spectator = parsed.value.role !== 'player';
  const watcher = parsed.value.role === 'watcher';
  if (match.spectator === spectator && match.watcher === watcher) return;
  match.spectator = spectator;
  match.watcher = watcher;
  // The role lands AFTER the snapshot's frames drew a view: a watcher's is
  // re-drawn from the active player's side now.
  redraw(match);
  notify(match);
}

/**
 * The Forge player id the board is drawn FROM: the snapshot's. A watcher's follows the turn —
 * whoever's turn it is is drawn at the bottom (the operator, 2026-10-28: *"the spectator
 * impersonates the view of the active player"*), and the snapshot's before Forge has said.
 */
export function viewerPlayerIdOf(match: LiveMatch): number | null {
  if (!match.watcher) return match.playerId;
  const game = [...match.state.values()].find((o) => o._type === DELTA_TYPE.game);
  return intOf(game, 'PlayerTurn') ?? match.playerId;
}

/** The seat across the table from this one; null for a socket that holds none. */
export function otherSeat(match: LiveMatch): number | null {
  return match.seat === null ? null : match.seat === 0 ? 1 : 0;
}

/** The Forge player a SEAT holds, once `forge:seats` has named it; null before, and for a seat Forge has not named. */
export function playerIdOfSeat(match: LiveMatch, seat: number): number | null {
  return match.playerIdBySeat?.get(seat) ?? null;
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
 *    this seat's OWN hand → those cards, and no player, except the opponents
 *    while attacks are declared and the viewer while a payment takes life;
 *  - Forge has named none of the four → nothing.
 *
 * A permanent of the seat's own that Forge offers tapped is a click that untaps it
 * ({@link untapOffers}), and Forge offers those in every input: so with a selection open it
 * joins the selection's cards, and with a question open it is all the board may click.
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
  if (view === null || !match.inputLive || !match.connected) return nothingClickable(match);
  const selection = match.selectables;
  const named =
    match.asks.length > 0
      ? untapOffers(match, view)
      : selection === null
      ? union(
          match.weaklySelectable,
          match.highlighted,
          mulliganHand(match.state, view),
          blockTargets(match, view),
          declaredBlockers(match, view),
          declaredAttackers(match, view),
          attackDefenders(match, view),
        )
      : union(selection.cards, untapOffers(match, view));
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
  } else if (attackInputLive(match)) {
    // `InputAttack.onPlayerSelected` makes an opponent the current defender.
    for (const p of view.players) if (!p.isViewer && !p.hasLost && !match.spent.players.has(p.id)) players.add(p.id);
  }
  return { selectable: offered, selectablePlayers: players, selectionOpen: selection !== null };
}

/**
 * What the board DRAWS as offered: {@link boardInteraction}, except through the silence after a
 * click, when the last offer stays drawn until Forge says what comes next (`./offer-hold.ts`).
 * Drawing only — every send still asks `boardInteraction`.
 */
export function drawnOffer(match: LiveMatch): LiveClickables {
  const real = boardInteraction(match);
  const view = match.view;
  if (match.offerHold === null || view === null || !match.connected) return real;
  return drawnOfferOf(real, match.offerHold, {
    now: Date.now(),
    turn: view.turn,
    askedByHand: match.asks.some(askedByHand),
    waitingOnAnother: waitingOnAnother(match),
  });
}

/**
 * AF397 (doomed cards) — what an OPEN choice on this board would send off the battlefield if
 * answered as it now stands, derived from the choice itself, never a card name:
 *
 *  - the legend rule: `selection.keepOne` (`PlayBridge.java`'s own note on why this, and not the
 *    `chooseSingleEntityForEffect` RPC the engine source alone suggests, is where it actually
 *    arrives — proven against real Forge, `af397-legend-rule.jvm.test.ts`) — every legendary of the
 *    one name Forge is asking about; `keep-one`, because answering sends every OTHER one to the
 *    graveyard;
 *  - a sacrifice: `selection.sacrifice`, already flagged server-side by the ability's own API
 *    (`PlayBridge.java`'s `sacrificeAsked`, `ApiType.Sacrifice`) — `chosen-goes`, because answering
 *    sends the ONE chosen;
 *  - a destroy or exile target: `selection.offBattlefield`, from the open target's own API and
 *    params (`PlayBridge.java`'s `leavesBattlefield`: `Destroy` always, `ChangeZone` only to
 *    Graveyard or Exile) — `chosen-goes`, same shape as a sacrifice.
 *
 * At most one of the three is ever set at once (one open input, one `selection`). Discard and mill
 * choices (hand, library) are deliberately left out — AF397 is battlefield departures only.
 */
export function doomAskOf(match: LiveMatch): { candidates: ReadonlySet<number>; fate: 'keep-one' | 'chosen-goes' } | undefined {
  const selection = match.promptSelection;
  if (selection === undefined || selection === null) return undefined;
  const keepOne = selection.keepOne;
  if (keepOne !== undefined && keepOne.cards.length > 1) {
    return { candidates: new Set(keepOne.cards.map((c) => c.id)), fate: 'keep-one' };
  }
  const sacrifice = selection.sacrifice;
  if (sacrifice !== undefined && sacrifice.cards.length > 0) {
    return { candidates: new Set(sacrifice.cards.map((c) => c.id)), fate: 'chosen-goes' };
  }
  const offBattlefield = selection.offBattlefield;
  if (offBattlefield !== undefined && offBattlefield.cards.length > 0) {
    return { candidates: new Set(offBattlefield.cards.map((c) => c.id)), fate: 'chosen-goes' };
  }
  return undefined;
}

/** A question this seat answers by hand, not one its browser answers itself. */
const askedByHand = (ask: LiveAsk): boolean => !SELF_ANSWERING.has(ask.method) && selfAnswer(ask) === null;

/** The game waits on a seat that is not this one (`forge:seats`' `waitingOn`). */
const waitingOnAnother = (match: LiveMatch): boolean => [...(match.waitingOn?.keys() ?? [])].some((seat) => seat !== match.seat);

/** Whether a hold is still drawn: its time is not up and the turn has not moved on. */
function holdStandsNow(match: LiveMatch): boolean {
  return holdStands(match.offerHold, Date.now()) && match.offerHold.turn === match.view?.turn;
}

const ownTurn = (match: LiveMatch): boolean => match.view?.players.find((p) => p.isViewer)?.isActive === true;

const without = (ids: ReadonlySet<number>, id: number): ReadonlySet<number> => new Set([...ids].filter((other) => other !== id));

/**
 * Forge falls silent about this seat's offer: keep drawing `offer` until it names the next one
 * (`./offer-hold.ts`). `pressed` is what a click just sent; what was pressed under a hold that still
 * stands carries over.
 */
function holdOffer(match: LiveMatch, offer: LiveClickables, pressed: { card?: number; player?: number } = {}): void {
  const view = match.view;
  if (view === null) return;
  const carried: Pressed = holdStandsNow(match) ? match.offerHold!.pressed : { cards: new Set(), players: new Set() };
  const plus = (ids: ReadonlySet<number>, id: number | undefined): ReadonlySet<number> => (id === undefined ? ids : new Set([...ids, id]));
  const hold: OfferHold = { offer, since: Date.now(), turn: view.turn, pressed: { cards: plus(carried.cards, pressed.card), players: plus(carried.players, pressed.player) } };
  match.offerHold = hold;
  lapseHold(hold, () => match.offerHold, () => {
    match.offerHold = null;
    match.deferredSelect = null;
    notify(match);
  });
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
  const bar = liveBar(match);
  if (bar === null || !(bar.enable1 || bar.enable2)) return false;
  return bar.label2 === CALL_BACK_LABEL || bar.label2 === ALPHA_STRIKE_LABEL;
}

/**
 * `InputAttack` is the input running on this seat: its phase, and its own bar. Every click this
 * module offers on Forge's behalf while attacks are declared — a defender, an opponent, an attacker
 * to call back — is a click only that input takes; the same step's priority stop
 * (`InputPassPriority`, OK / End Turn) refuses every one of them.
 */
function attackInputLive(match: LiveMatch): boolean {
  return declaringAttackers(match) && attackWindowLive(match);
}

/** `InputBlock` is the input running on this seat: the block step, and its current attacker marked (`blockFocusOf`). */
function blockInputLive(match: LiveMatch): boolean {
  return blockFocusOf(match) !== null;
}

/**
 * The seat's own tapped permanents in Forge's actionable set: each a click untaps (its mana
 * unspent, nothing triggered — `PlayerControllerHuman.tryUndo`), whatever input is open.
 */
function untapOffers(match: LiveMatch, view: BoardView): ReadonlySet<number> {
  const out = new Set<number>();
  if (match.weaklySelectable === null) return out;
  for (const c of viewerOf(view)?.battlefield ?? []) if (c.tapped && match.weaklySelectable.has(c.id)) out.add(c.id);
  return out;
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
  const me = viewerOf(view);
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
    if (obj._type !== DELTA_TYPE.game) continue;
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
    for (const c of p.handShown ?? []) if (c !== null) ids.add(c.id);
    for (const c of p.libraryTop ?? []) ids.add(c.id);
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
  if (!boardInteraction(match).selectable.has(cardId)) {
    // A held outline (`./offer-hold.ts`) is a promise the card is playable: keep the press for
    // Forge's word instead of refusing it — but only a play, never a choice a selection asks for.
    const drawn = drawnOffer(match);
    if (match.offerHold === null || match.offerHold.pressed.cards.has(cardId) || drawn.selectionOpen || !drawn.selectable.has(cardId)) {
      reportRefusedClick(match, cardId);
      return false;
    }
    match.deferredSelect = { cardId, placement };
    return true;
  }
  match.deferredSelect = null;
  if (match.selectables === null && !payingMana(match)) match.actCard = cardId;
  const drawn = drawnOffer(match);
  match.spent.cards.add(cardId);
  // The card pressed is dark until Forge says what came of it; the rest stays drawn.
  holdOffer(match, { ...drawn, selectable: without(drawn.selectable, cardId) }, { card: cardId });
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
      ...sameTargetOf(match),
    },
    placement,
  );
}

/** Why {@link boardInteraction} does not offer `cardId` now, the first gate that turns it away. */
function refusal(match: LiveMatch, cardId: number): string {
  if (match.view === null) return 'no-view';
  if (!match.connected) return 'disconnected';
  if (!match.inputLive) return 'no-input';
  if (match.spent.cards.has(cardId)) return 'spent';
  if (match.asks.length > 0) return 'ask-open';
  if (match.selectables !== null) return 'not-in-selection';
  if (match.weaklySelectable === null) return 'nothing-offered';
  return match.weaklySelectable.has(cardId) ? 'not-in-view' : 'not-offered';
}

/**
 * A board click turned away is logged (the operator's Eldrazi Spawn, 2026-10-24: a click refused
 * here sent nothing, so the match log could not say it was ever made): the card, why, and what
 * was open. A watcher sends nothing, as for every other client event.
 *
 * the same reason feeds `mistakes.ts`'s classifier, and `said` stamps what it found onto
 * this telemetry — so the match log keeps saying what this seat was told, next to why, and
 * `-` when the refusal is nobody's mistake: a `null` there failed the schema and the server
 * dropped the whole event (#20).
 */
function reportRefusedClick(match: LiveMatch, cardId: number): void {
  if (match.watcher) return;
  const reason = refusal(match, cardId);
  const said = mistakeOfClick(match.view, reason, cardId);
  setMistake(match, said);
  match.transport.emit(CLIENT_EVENT, {
    matchId: match.matchId,
    kind: 'info',
    data: {
      what: 'click-refused',
      card: cardId,
      reason,
      said: said ?? '-',
      asks: match.asks.length,
      ask: match.asks[0]?.method ?? '-',
      selection: match.selectables !== null,
      paying: payingMana(match),
      offered: match.weaklySelectable?.has(cardId) ?? false,
      manaOnly: match.weaklySelectableManaOnly?.has(cardId) ?? false,
      prompt: (match.prompt ?? '').split('\n')[0]!.slice(0, 80),
    },
  } satisfies ClientEvent);
}

/**
 * A click on a board card's own face. `selectCard`, except on the seat's own
 * creature while it blocks: blocking is by drag only, so that click never
 * assigns a block — it takes the creature out of any block it is in
 * (`removeBlock`).
 */
export function clickCard(match: LiveMatch, cardId: number): void {
  if (ownBlocker(match, cardId)) removeBlock(match, cardId);
  else selectCard(match, cardId);
}

/** Click a player: Forge's `selectPlayer`. Same rule as `selectCard`. */
export function selectPlayer(match: LiveMatch, playerId: number): boolean {
  if (!boardInteraction(match).selectablePlayers.has(playerId)) return false;
  const drawn = drawnOffer(match);
  match.spent.players.add(playerId);
  holdOffer(match, { ...drawn, selectablePlayers: without(drawn.selectablePlayers, playerId) }, { player: playerId });
  return sendAct(match, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: playerId }, triggerEvent: null, ...sameTargetOf(match) });
}

/** A pick on a target question with "same target for all" ticked says so; the server answers the rest. */
function sameTargetOf(match: LiveMatch): { sameTarget?: true } {
  return match.sameTarget && match.promptTargetMore > 0 ? { sameTarget: true } : {};
}

/** Tick or clear "same target for all" on the open target question. */
export function setSameTarget(match: LiveMatch, on: boolean): void {
  match.sameTarget = on;
  notify(match);
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
  return view !== null && view.phase === 'COMBAT_DECLARE_ATTACKERS' && view.activePlayerId === (viewerOf(view)?.id ?? null);
}

/** `COMBAT_DECLARE_BLOCKERS`, and this seat is NOT the attacker — so it blocks. */
export function declaringBlockers(match: LiveMatch): boolean {
  const view = match.view;
  return view !== null && view.phase === 'COMBAT_DECLARE_BLOCKERS' && view.activePlayerId !== (viewerOf(view)?.id ?? null);
}

const NO_PICKS: ReadonlySet<number> = new Set();

/**
 * While this seat blocks, Forge's one highlighted card is `InputBlock`'s current attacker — the one
 * the next blocker click is assigned to (`InputBlock.java:192`, `setCurrentAttacker`) — not a choice
 * this seat made. It is the block focus; null outside the block step.
 */
export function blockFocusOf(match: LiveMatch): number | null {
  if (!declaringBlockers(match)) return null;
  const [first] = match.highlighted ?? NO_PICKS;
  return first ?? null;
}

/**
 * The viewer's creatures Forge says can attack or block right now — `InputAttack`'s
 * `pushAttackerCandidates` and `InputBlock`'s `pushBlockerCandidates`
 * (`PlayerControllerHuman.java:1605-1647`), which arrive as the actionable set — only while
 * that input is live: the attack window's own button 2 (`attackWindowLive`), the block
 * window's current attacker (`blockFocusOf`). The same step's later priority stop pushes an
 * ordinary actionable set (abilities), which is not this. Empty otherwise.
 */
export function combatCandidates(match: LiveMatch): ReadonlySet<number> {
  const live = attackInputLive(match) || blockInputLive(match);
  return live && match.weaklySelectable !== null ? match.weaklySelectable : NO_PICKS;
}

/** Forge's highlighted cards drawn as PICKED: every one, except the block step's current attacker (`blockFocusOf`). */
export function pickedOf(match: LiveMatch): ReadonlySet<number> {
  return declaringBlockers(match) ? NO_PICKS : (match.highlighted ?? NO_PICKS);
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
 * Life one press of {@link payWithLife} pays: what Forge names for a life-paid mana ability, else
 * its fixed 2 per Phyrexian shard (`InputPayManaOfCostPayment.onPlayerSelected`, `phyLifeToLose += 2`).
 */
export function lifePerPress(match: LiveMatch): number {
  const named = LIFE_PER_CLICK.exec(match.prompt ?? '')?.[1];
  return named === undefined ? 2 : Number(named);
}

/** A payment is open that the viewer may pay with life. */
export function lifePayable(match: LiveMatch): boolean {
  return payingMana(match) && LIFE_PAYMENT.test(match.prompt ?? '');
}

/**
 * The viewer pays one shard of the open payment with life: Forge's payment
 * input takes it as the payer selecting themselves
 * (`InputPayManaOfCostPayment.onPlayerSelected`). Spent until Forge's next
 * frame, which re-sends the prompt — so a cost with two shards is two presses,
 * each answered first.
 */
export function payWithLife(match: LiveMatch): boolean {
  const me = lifePayer(match);
  if (me === null) return false;
  match.spent.players.add(me);
  return sendAct(match, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: me }, triggerEvent: null });
}

/**
 * The colours of the viewer's floating pool a press pays the open payment with, while a payment is
 * open, else empty. The operator, 2026-10-22: *"i had BBB in the pool. all i could do was click
 * auto to make payment. i should have been able to click on my black mana to pay for the spell"*.
 */
export function poolPays(match: LiveMatch): readonly PoolColor[] {
  return payingMana(match) ? (match.promptPoolPays ?? []) : [];
}

/**
 * The pool pays the open payment more than one way, so it is highlighted: the operator,
 * 2026-10-21, *"if there is more mana in the pool than is needed, we should require the player to
 * click on the mana symbols in their pool … lets highlight the mana pool area when this happens"*.
 */
export function poolChoice(match: LiveMatch): boolean {
  return match.promptPoolChoice && poolPays(match).length > 0;
}

/**
 * Pay the open payment with one `color` from the viewer's pool: Forge's own pool payment
 * (`IGameController.useMana` → `InputPayMana.useManaFromPool`). Spent until Forge's next prompt.
 */
export function payFromPool(match: LiveMatch, color: PoolColor): boolean {
  if (!poolPays(match).includes(color)) return false;
  match.promptPoolPays = null;
  match.promptPoolChoice = false;
  redraw(match);
  return sendAct(match, { kind: 'act', method: 'useMana', color: 1 << POOL_COLORS.indexOf(color) });
}

/** The viewer's player while a press of {@link payWithLife} would be taken, else null. */
export function lifePayer(match: LiveMatch): number | null {
  if (!lifePayable(match)) return null;
  const me = viewerOf(match.view);
  return me === undefined || match.spent.players.has(me.id) ? null : me.id;
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
  const me = viewerOf(view);
  const card = me?.battlefield.find((c) => c.id === id);
  return card !== undefined && card.card.typeLine.includes('Land');
}

/**
 * The viewer's own lands that Forge will take a click on right now, in
 * battlefield order: what a box drawn over the lands may click. An untapped one
 * is offered for its mana; a tapped one only while the mana it made still
 * floats, and the click untaps it (`AvailableActions.cardHasActionable` →
 * `PlayerControllerHuman.tryUndo`). Empty whenever a click on a land would mean
 * anything else — a selection or an ask is open (the land is then an answer to
 * a question), or combat is being declared.
 *
 * Lands only, by the card's CURRENT type line, the same reading
 * `isOwnBattlefieldLand` gives `nothingToDecide`: a creature Forge offers for
 * an ability is a decision, and a sweep must not make it.
 */
export function landsOffered(match: LiveMatch): BoardCard[] {
  const view = match.view;
  if (view === null || match.selectables !== null || match.asks.length > 0 || declaringCombat(match)) return [];
  const offered = boardInteraction(match).selectable;
  const me = viewerOf(view);
  return (me?.battlefield ?? []).filter((c) => offered.has(c.id) && c.card.typeLine.includes('Land'));
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
  const me = viewerOf(view);
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

/**
 * This seat genuinely has something to decide right now, rather than Forge's
 * raw per-frame `hasPriority` ping-ponging through an auto-passed exchange.
 * `LiveBoard.tsx`'s `withGatedPriority` turns it into the avatar ring;
 * `ownDecisionOpen` and `waitingForOpponent` are its own
 * `myOwnDecisionOpen`/`isWaitingForOpponent(match)` — both already computed
 * there for the pop-ups themselves, so this is the one place that COMBINES
 * them.
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
  // The pressable bar, not Forge's raw one: a press closes this seat's window at once, not when
  // the server's next bar arrives — and a lapsed hold reopens it.
  const bar = liveBar(match);
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
 * leave the attacker and the blocker to the arrange gesture — see
 * `gestures/install.ts`'s `arrangeable`.
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
  if (!blockInputLive(match)) return null;
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
 * `AttackersWithPlannedBlockers` the whole time `InputBlock` runs). A
 * click Forge actually refuses (it is blocking a different attacker than the
 * current one) costs nothing: `selectCard` only ever offers the click, Forge
 * still decides what it means.
 *
 * Hidden information is untouched: the cards are on this seat's own
 * battlefield, and `boardInteraction` still intersects with `cardIdsInView`.
 */
function declaredBlockers(match: LiveMatch, view: BoardView): ReadonlySet<number> | null {
  if (!blockInputLive(match)) return null;
  const me = viewerOf(view);
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
function declaredAttackers(match: LiveMatch, view: BoardView): ReadonlySet<number> | null {
  if (!attackInputLive(match) || match.buttons?.label2 !== CALL_BACK_LABEL) return null;
  const me = viewerOf(view);
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
  if (!attackInputLive(match)) return null;
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
  const me = viewerOf(view);
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
export function afterMarked(match: LiveMatch, target: { kind: 'card' | 'player'; id: number }, then: () => void): void {
  afterState(match, () => isMarked(match, target), then);
}

/** How long a second click waits for Forge to show it applied the first (`afterMarked`, `removeBlock`). */
export const MARK_WAIT_MS = 2000;

/** Run `then` once `ready()` holds — at once if it already does — and never if it has not within `MARK_WAIT_MS`. */
function afterState(match: LiveMatch, ready: () => boolean, then: () => void): void {
  if (ready()) { then(); return; }
  let done = false;
  const finish = (go: boolean): void => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    if (go) then();
  };
  const unsubscribe = subscribe(match, () => { if (ready()) finish(true); });
  const timer = setTimeout(() => finish(false), MARK_WAIT_MS);
}

/** Whether `attacker` is one this seat can drag a blocker onto while `InputBlock` runs, and `blocker` is its own. */
export function isBlockAssignment(match: LiveMatch, blocker: number, attacker: number): boolean {
  const view = match.view;
  if (view === null) return false;
  const targets = blockTargets(match, view);
  if (targets === null || !targets.has(attacker)) return false;
  return ownBlocker(match, blocker);
}

/**
 * `card` is on this seat's own battlefield while `InputBlock` runs for it (a
 * current attacker is marked). Such a card blocks only by being dragged onto
 * an attacker (`assignBlock`): a click on it never assigns a block, it takes
 * the card out of whatever it blocks (`removeBlock`).
 */
export function ownBlocker(match: LiveMatch, card: number): boolean {
  if (blockFocusOf(match) === null) return false;
  return match.view?.players.some((p) => p.isViewer && p.battlefield.some((c) => c.id === card)) === true;
}

/** The attackers `blocker` is assigned to right now — the first attacker of each band whose planned blockers name it. */
function attackersBlockedBy(match: LiveMatch, blocker: number): number[] {
  const out: number[] = [];
  for (const band of match.view?.combat ?? []) {
    const attacker = band.attackers[0];
    if (attacker !== undefined && (band.plannedBlockers ?? []).includes(blocker)) out.push(attacker);
  }
  return out;
}

/**
 * One `InputBlock` click on `blocker` against `attacker`: the attacker first,
 * unless Forge has already marked it current, then the blocker once it has.
 *
 * `InputBlock` takes the attacker first — a click on an attacking card sets
 * `currentAttacker`, and the click AFTER it is applied to that attacker
 * (`InputBlock.java:129-163`): it adds the blocker, or removes it when it
 * already blocks that attacker. Its constructor auto-selects the first
 * blockable attacker (`:59-68`) and marks it (`setCurrentAttacker`,
 * `:190-197`), so when that is the one meant the blocker's click is all it
 * takes. The blocker's click waits for the mark: Forge may apply two quick
 * clicks in either order (`afterMarked`).
 */
function clickBlock(match: LiveMatch, attacker: number, blocker: number, then?: () => void): void {
  const target = { kind: 'card' as const, id: attacker };
  const blockerClick = (): void => {
    if (selectCard(match, blocker)) then?.();
  };
  if (isMarked(match, target)) { blockerClick(); return; }
  if (!selectCard(match, attacker)) return;
  afterMarked(match, target, blockerClick);
}

/**
 * Take `blocker` out of every block it is in, then run `then`: Forge's own
 * undo (`InputBlock.java:134-146`, the blocker clicked with the attacker it
 * blocks current), one attacker at a time. Each next step waits until Forge's
 * combat no longer names the pair AND Forge offers the blocker again
 * (`pushBlockerCandidates` after the undo), so a following click on it is
 * not refused as stale.
 */
export function removeBlock(match: LiveMatch, blocker: number, then: () => void = () => {}): void {
  const [attacker] = attackersBlockedBy(match, blocker);
  if (attacker === undefined) { then(); return; }
  clickBlock(match, attacker, blocker, () =>
    afterState(
      match,
      () => !attackersBlockedBy(match, blocker).includes(attacker) && boardInteraction(match).selectable.has(blocker),
      () => removeBlock(match, blocker, then),
    ),
  );
}

/**
 * Block `attacker` with `blocker` — the drag. A creature already blocking
 * something else is MOVED: Forge refuses a second block for a creature that
 * cannot block more (`CombatUtil.canBlock` → `canBlockMoreCreatures`), so it
 * is taken off first (`removeBlock`). One that can block another attacker is
 * still offered by Forge as a candidate (`pushBlockerCandidates`,
 * `PlayerControllerHuman.java:1621-1647`) and keeps its first block. A drop on
 * the attacker it already blocks changes nothing.
 */
export function assignBlock(match: LiveMatch, blocker: number, attacker: number): void {
  const current = attackersBlockedBy(match, blocker);
  if (current.includes(attacker)) return;
  if (current.length === 0 || match.weaklySelectable?.has(blocker) === true) {
    clickBlock(match, attacker, blocker);
    return;
  }
  removeBlock(match, blocker, () => clickBlock(match, attacker, blocker));
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
  const me = viewerOf(view);
  if (me === undefined) return out;
  for (const card of me.battlefield) {
    if (!held.ids.has(card.id)) continue;
    out.set(card.id, card.attacking ? 'declared' : match.spent.cards.has(card.id) ? 'sent' : 'refused');
  }
  return out;
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
  clearTimeout(watchdogs.get(match));
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
  const request: MatchRequest = kind === 'join' ? { matchId: match.matchId, tabId: match.tabId } : { matchId: match.matchId };
  match.transport.request(event, request, (err, response) => {
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
    if (kind === 'join') {
      match.settled.clear();
      reportRejoin(match);
    }
    adoptSnapshot(match, ack.value);
  });
}

/**
 * A rejoin after a lost connection, in the match log: why the last one closed, as socket.io
 * said it (`transport close`, `ping timeout`, `io server disconnect`, …), and how long the board
 * was without one. Sent once the join is answered, so the server holds this socket in the seat.
 */
function reportRejoin(match: LiveMatch): void {
  const drop = drops.get(match);
  if (drop === undefined) return;
  drops.delete(match);
  match.transport.emit(CLIENT_EVENT, {
    matchId: match.matchId,
    kind: 'connection',
    data: { what: 'rejoined', reason: drop.reason.slice(0, 80), downMs: (drop.back ?? Date.now()) - drop.at, joins: match.stats.joins },
  } satisfies ClientEvent);
}

/**
 * A failed snapshot drops the buffer rather than replaying it: replaying would
 * re-trigger the resync that just failed, in a loop paced by the server's own
 * errors. The next live frame is what tries again.
 */
function snapshotFailed(match: LiveMatch, why: string): void {
  reporters.get(match)?.('snapshot-failed', { why, ...connectionFacts(match) });
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
  match.reveal = null;
  match.revealed = null;
  // The server re-sends the open selection, the marks and the actionable set
  // after the snapshot (wave 31 §S: `resendAfterSnapshot` keeps them per
  // seat), as normal frames. What this client held from before is replaced by
  // those, so it is dropped here rather than trusted.
  match.selectables = null;
  match.weaklySelectable = null;
  match.weaklySelectableManaOnly = null;
  match.castForbidden = null;
  match.heldChanges = null;
  match.highlighted = null;
  match.highlightedPlayers = null;
  // The log, like the asks: the server re-sends its kept says after the
  // snapshot, so a line that survives from before is not trusted.
  match.says = [];
  match.rolls = [];
  match.flips = [];
  match.inputLive = false;
  match.barHold = null;
  // The server re-sends the window after the snapshot, both halves.
  match.windowHalf = null;
  match.over = false;
  match.finished = false;
  match.ended = null;
  match.losers = null;
  match.lost = null;
  match.endedBy = null;
  unspend(match);
  match.lastError = null;
  match.lastInvalid = null;
  // A snapshot's history holds every fight this game has had, all of them drawn already, or (a fresh
  // page) none of them owed: its damage is not news. Re-noting it would number it above every hit
  // the board has seen, and a board still mounted across a reconnect would ram the last fight again.
  // `nextHitSeq` keeps counting, so the first hit after the snapshot is still above them all.
  match.hits = [];
  match.faceHits = [];
  foldFrames(match, snapshot.frames, 'history');
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
function statePacket(match: LiveMatch): FoldablePacket {
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
    pendingTriggers: match.pendingTriggers,
    waitingEffects: match.waitingEffects,
    tokenSources: [...match.tokenSources],
    cantBlock: [...match.cantBlock],
    printedTypes: [...match.printedTypes].map(([id, printed]) => [id, printed.type, printed.token] as const),
    printedPT: [...match.printedPT].map(([id, pt]) => [id, pt.power, pt.toughness] as const),
    lifePaying: [...match.lifePaying],
    conditionMet: [...match.conditionMet],
  };
}

/**
 * Fold the state-channel frames among `frames` into `match`, and redraw.
 *
 * `setGameView` is a full baseline and REPLACES what came before it;
 * `applyDelta` folds on top. `openView` names the seats this client controls,
 * which the snapshot already said — a disagreement is an identity bug on the
 * server, and is surfaced rather than silently resolved either way.
 *
 * A snapshot's frames are `history`: their state folds, their damage is no
 * hit to draw (`adoptSnapshot`).
 */
function foldFrames(match: LiveMatch, frames: readonly ServerFrame[], source: 'live' | 'history'): void {
  let packets: unknown[] = match.state.size > 0 ? [statePacket(match)] : [];
  let changed = false;
  for (const frame of frames) {
    if (frame.method === 'setGameView') {
      const { gameView, sequenceNumber, ...siblings } = frame.payload;
      packets = [{ seq: sequenceNumber, checksum: 0, checksumProperties: [], newObjects: gameView, objectDeltas: {}, events: [], ...siblings }];
      changed = true;
    } else if (frame.method === 'applyDelta') {
      const { packet, damage, deaths, faceDamage, counteredStackItems, ...siblings } = frame.payload;
      packets.push({ ...packet, ...siblings });
      if (damage !== undefined && source === 'live') noteHits(match, damage);
      if (deaths !== undefined) noteDeaths(match, deaths);
      if (faceDamage !== undefined && source === 'live') noteFaceHits(match, faceDamage);
      if (counteredStackItems !== undefined) noteCountered(match, counteredStackItems);
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
  const { seq, skippedDeltas, ...folded } = foldPackets(expectWirePackets(packets, `match ${match.matchId}`));
  Object.assign(match, folded);
  match.forgeSeq = seq;
  match.skippedDeltas += skippedDeltas;
  redraw(match);
}

/** How many damage hits a match keeps: far more than one resolution deals, and still bounded. */
const HITS_KEPT = 64;

function noteHits(match: LiveMatch, damage: readonly (readonly [number, number, number])[]): void {
  const added = damage.map(([cardId, sourceId, amount]) => ({ seq: match.nextHitSeq++, cardId, sourceId: sourceId >= 0 ? sourceId : null, amount }));
  match.hits = [...match.hits, ...added].slice(-HITS_KEPT);
}

function noteFaceHits(match: LiveMatch, damage: readonly (readonly [number, number, number, boolean])[]): void {
  const added = damage.map(([playerId, sourceId, amount, combat]) => ({ seq: match.nextHitSeq++, playerId, sourceId: sourceId >= 0 ? sourceId : null, amount, combat }));
  match.faceHits = [...match.faceHits, ...added].slice(-HITS_KEPT);
}

function noteDeaths(match: LiveMatch, deaths: readonly (readonly [number, DeathCause])[]): void {
  const next = new Map(match.deathCauses);
  for (const [cardId, cause] of deaths) {
    next.delete(cardId);
    next.set(cardId, cause);
  }
  match.deathCauses = new Map([...next].slice(-HITS_KEPT));
}

/** AE27 — `deaths`'s own pattern, for stack item ids that left the stack not by resolving cleanly. */
function noteCountered(match: LiveMatch, ids: readonly number[]): void {
  const next = new Set(match.counteredStackItems);
  for (const id of ids) next.add(id);
  match.counteredStackItems = new Set([...next].slice(-HITS_KEPT));
}

function redraw(match: LiveMatch): void {
  const viewerPlayerId = viewerPlayerIdOf(match);
  const before = match.view;
  match.view =
    viewerPlayerId === null || match.state.size === 0
      ? null
      : toBoardView(match.state, match.forgeSeq, {
          viewerPlayerId,
          // `null` (seats never arrived) and an empty `Map` (they arrived, and
          // named no avatars) both mean "pass nothing" to the adapter — see the
          // field's own note on why the two are still kept apart in STATE.
          avatarByPlayerId: match.avatarByPlayerId ?? undefined,
          ...(match.unclaimedAvatar === null || match.playerIdBySeat === null
            ? {}
            : { unclaimed: { avatarId: match.unclaimedAvatar, seated: new Set(match.playerIdBySeat.values()) } }),
          nameByPlayerId: match.nameByPlayerId ?? undefined,
          stackTargetSpells: match.stackTargetSpells,
          pendingTriggers: match.pendingTriggers,
          waitingEffects: match.waitingEffects,
          tokenSources: match.tokenSources,
          cantBlock: match.cantBlock,
          printedTypes: match.printedTypes,
          printedPTs: match.printedPT,
          lifePaying: match.lifePaying,
          conditionMet: match.conditionMet,
          hits: match.hits,
          faceHits: match.faceHits,
          deathCauses: match.deathCauses,
          counteredStackItems: match.counteredStackItems,
          promptCards: promptCardsOf(match),
          watcher: match.watcher,
          attackLocked: match.attackLocked,
        });
  match.attackLocked = match.view?.phase === 'COMBAT_DECLARE_ATTACKERS' && (match.attackLocked || attackLockedIn(match.view.players));
  if (match.view?.gameOver === true) match.over = true;
  // Another seat's spell resolved: nothing held is drawn over what it does (`./offer-hold.ts`).
  const viewerName = viewerPlayerId === null ? null : strOf(match.state.get(deltaKey(DELTA_TYPE.player, viewerPlayerId)), 'Name');
  if (resolvedByAnother(before, match.view, viewerName)) match.offerHold = null;
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
  timed('forge', () => ingestNow(match, raw));
}

function ingestNow(match: LiveMatch, raw: unknown): void {
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
  const half = match.windowHalf;
  match.windowHalf = null;
  if (half !== null) applyFrame(match, half);
  if (envelope.value.pairsWithNext === true) match.windowHalf = parsed.value;
  else if (envelope.value.displayOnly === true) showReveal(match, parsed.value, envelope.value.forceNotice === true);
  else applyFrame(match, parsed.value);
  if (match.offerHold !== null) dropMarked(match.offerHold, { cards: match.highlighted, players: match.highlightedPlayers });
  sendDeferredSelect(match);
  notify(match);
}

/**
 * The press {@link selectCard} kept through a held offer: sent once Forge offers the card again as
 * a play, dropped once Forge's word is anything else — a selection, a set without it, or the hold
 * running out. A dropped press is a park Forge never takes, and floats home like any other.
 */
function sendDeferredSelect(match: LiveMatch): void {
  const kept = match.deferredSelect;
  if (kept === null) return;
  const real = boardInteraction(match);
  if (!real.selectionOpen && real.selectable.has(kept.cardId)) {
    selectCard(match, kept.cardId, kept.placement);
    return;
  }
  if (real.selectionOpen || !drawnOffer(match).selectable.has(kept.cardId)) match.deferredSelect = null;
}

/**
 * A frame the server marked `displayOnly`: a reveal Forge has already been
 * answered for. Only a `getChoices` reveal is ever sent that way
 * (`apps/server/src/play/match.ts`'s `showReveal`); anything else so marked is
 * counted invalid and dropped — there is no reply to owe it either way.
 *
 * A reveal of cards the board already draws face up in their own zones (a
 * hand shown by Gitaxian Probe, a revealed library top, a permanent) opens no
 * notice: the board is where the seat sees them (`../adapter.ts`'s
 * `drawsFaceUp`). Any card it does not draw — a library searched, cards
 * revealed and put back unseen — and the notice shows the whole reveal.
 *
 * `forceNotice` (the envelope's own field, AF403) skips that `drawsFaceUp`
 * check entirely: the server already found that whatever the SAME
 * resolution did right behind this reveal (`DigUntilEffect`'s move to the
 * bottom) takes these cards off the position that made them look
 * already-visible, so trusting the board here would show the seat nothing
 * — the very bug this flag exists to catch. A persistent look grant
 * (Courser of Kruphix) never sets it, since nothing moves those cards.
 */
function showReveal(match: LiveMatch, frame: ServerFrame, forceNotice: boolean): void {
  if (frame.kind !== 'ask' || frame.method !== 'getChoices') {
    match.stats.invalid += 1;
    match.lastInvalid = [{ path: '$.displayOnly', message: `only a getChoices reveal is display-only, not ${frame.kind} ${frame.method}` }];
    return;
  }
  const cardIds = frame.choices.flatMap((c) => (c.ref?.kind === 'card' ? [c.ref.id] : []));
  const onBoard = !forceNotice && cardIds.length === frame.choices.length && match.view !== null && drawsFaceUp(match.view, cardIds);
  if (!onBoard) match.reveal = frame;
  match.revealed = { ask: frame, cardIds, at: Date.now() };
}

/** The reveal notice has been seen (its time ran out, or the player clicked it away). */
/** The open damage window's assignment changed: the board echoes it ({@link damagePreviewOf}). */
export function previewDamage(match: LiveMatch, callId: string, amounts: ReadonlyMap<number, number>): void {
  match.damagePreview = { callId, amounts };
  notify(match);
}

/** The damage each card is about to take, while the window that assigns it is open; undefined otherwise. */
export function damagePreviewOf(match: LiveMatch): ReadonlyMap<number, number> | undefined {
  const preview = match.damagePreview;
  if (preview === null || !match.asks.some((a) => a.callId === preview.callId)) return undefined;
  return preview.amounts;
}

export function dismissReveal(match: LiveMatch, callId: string): void {
  if (match.reveal?.callId !== callId) return;
  match.reveal = null;
  notify(match);
}

/**
 * J12 (wave 64): the three ask methods whose own wire schema carries no card
 * at all — `showConfirmDialog`/`showOptionDialog`/`showInputDialog`
 * (`packages/forge-wire/src/tier-a.ts`), never `getChoices` or the others,
 * which sometimes do. A NEW one of these opening is "a prompt without a
 * card," and clears {@link LiveMatch.lastSelectedCard} at the source — a
 * stale click from two actions ago must not supply `clickOrigin`'s arrow
 * tail for a plain yes/no this seat never clicked anything to open.
 */
const CARDLESS_ASKS: ReadonlySet<string> = new Set(['showConfirmDialog', 'showOptionDialog', 'showInputDialog']);

/** One entry of the bridge's `heldChanges`, as the board draws it. */
function heldChange(h: NonNullable<Extract<ServerFrame, { method: 'setWeaklySelectable' }>['heldChanges']>[number]): HeldChange {
  if (h.cost === undefined || h.printed === undefined) return h.flashBy === undefined ? {} : { flashBy: h.flashBy };
  const now = manaCostTokens(h.cost);
  const printed = manaCostTokens(h.printed);
  const change = now.manaValue < printed.manaValue ? 'less' : now.manaValue > printed.manaValue ? 'more' : 'same';
  const cost = { now: now.tokens, printed: printed.tokens, by: h.costBy ?? [], change } as const;
  return h.flashBy === undefined ? { cost } : { cost, flashBy: h.flashBy };
}

function applyFrame(match: LiveMatch, frame: ServerFrame): void {
  if (frame.kind === 'ask') {
    if (match.settled.has(frame.callId)) {
      match.stats.reasksDropped += 1;
      return;
    }
    // Queued, never replacing another: see the module header. The same callId
    // twice (a re-send) updates its entry in place rather than queueing twice.
    const i = match.asks.findIndex((a) => a.callId === frame.callId);
    const asked = askedKey(match);
    if (i < 0) {
      match.asks.push(frame);
      if (CARDLESS_ASKS.has(frame.method)) match.lastSelectedCard = null;
    } else match.asks[i] = frame;
    if (askedKey(match) !== asked) redraw(match);
    // The seat's next real decision takes the place of a reveal still showing.
    match.reveal = null;
    // A question to answer by hand ends the silence: what was held is not drawn under it, nor after.
    if (askedByHand(frame)) match.offerHold = null;
    unspend(match);
    return;
  }
  if (INPUT_FRAMES.has(frame.method)) unspend(match);
  if (frame.kind === 'notify' && frame.method === 'showPromptMessage') {
    match.prompt = typeof frame.message === 'string' ? frame.message : null;
    // Overwritten by EVERY prompt, including with null. That is what makes it
    // fresh: see the field's note, and `payingMana`.
    const promptCard = frame.card === null ? null : frame.card.id;
    const redrawBoard = promptCard !== match.promptCard;
    match.promptCard = promptCard;
    // The board's known library tops depend on it (`adapter.ts` `knownTop`).
    if (redrawBoard) redraw(match);
    match.promptTrigger = frame.confirmAbility?.trigger ?? null;
    match.promptParts = frame.parts ?? null;
    match.promptPoolPays = frame.poolPays ?? null;
    match.promptPoolChoice = frame.poolChoice !== undefined;
    match.promptTargetMore = frame.targetAbility?.more ?? 0;
    match.promptSelection =
      frame.selection === undefined
        ? null
        : {
            targets: frame.selection.targets,
            aimed: frame.selection.aimed ?? [],
            sacrifice: frame.selection.sacrifice,
            offBattlefield: frame.selection.offBattlefield,
            keepOne: frame.selection.keepOne,
          };
    match.sameTarget = false;
    match.inputLive = true;
  } else if (frame.kind === 'notify' && frame.method === 'updateButtons') {
    match.buttons = {
      label1: typeof frame.label1 === 'string' ? frame.label1 : 'OK',
      label2: typeof frame.label2 === 'string' ? frame.label2 : 'Cancel',
      enable1: frame.enable1 === true,
      enable2: frame.enable2 === true,
      ...(frame.refusal1 === undefined ? {} : { refusal1: frame.refusal1 }),
    };
    match.barHold = null;
    match.inputLive = true;
  } else if (frame.kind === 'notify' && frame.method === 'setSelectables') {
    match.selectables = {
      cards: new Set(frame.cards.map((c) => c.id)),
      min: frame.min,
      max: frame.max,
      players: frame.players === undefined ? null : new Set(frame.players.map((p) => p.id)),
    };
    // A selection is a decision too: it takes the reveal's place, as an ask does.
    match.reveal = null;
    match.inputLive = true;
    // Forge's word on what this seat may do: nothing held is drawn past it.
    match.offerHold = null;
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
    if (frame.castForbidden !== undefined) {
      match.castForbidden = new Map(
        frame.castForbidden.map((f) => [f.card.id, { source: f.source, duration: f.duration, durationPlayer: f.durationPlayer?.id }]),
      );
    }
    if (frame.heldChanges !== undefined) match.heldChanges = new Map(frame.heldChanges.map((h) => [h.card.id, heldChange(h)]));
    match.inputLive = true;
    match.offerHold = null;
  } else if (frame.kind === 'notify' && frame.method === 'finishGame') {
    // Whatever Forge asked before the end can no longer be answered: a concede that met the coin
    // toss left its Play/Draw open under the result (#19).
    match.finished = true;
    match.over = true;
    dropOpenInput(match);
    if (frame.losers !== undefined) match.losers = new Set(frame.losers);
    if (frame.lost !== undefined) match.lost = new Map(frame.lost.map((l) => [l.player, l]));
    if (frame.endedBy !== undefined) match.endedBy = frame.endedBy;
  } else if (frame.kind === 'notify' && frame.method === 'showErrorDialog' && frame.matchEnded === true) {
    // The server's own ending notice (`Match.endNotice`): the match cannot
    // continue, whatever the board still shows — and nothing still open on it
    // can be answered, so none of it stays drawn.
    match.over = true;
    match.ended = { title: frame.title, message: frame.message };
    dropOpenInput(match);
  } else if (frame.kind === 'notify' && frame.method === 'message') {
    // Display only — see the module header. Not an input frame, not an answer:
    // nothing below this line reads it back, on purpose.
    if (frame.message !== '') {
      match.says.push({ text: frame.message, log: frame.log ?? null });
      if (match.says.length > SAYS_KEPT) match.says.shift();
    }
    if (frame.roll !== undefined) {
      match.rolls = [...match.rolls, shownRoll(frame.roll)].slice(-ROLLS_KEPT);
    }
    if (frame.flip !== undefined) {
      match.flips = [...match.flips, shownFlip(frame.flip, frame.message)].slice(-ROLLS_KEPT);
    }
  } else if (frame.kind === 'notify' && frame.method === 'flashIncorrectAction') {
    if (match.actCard !== null) refuse(match, match.actCard);
  } else if (frame.kind === 'notify' && frame.method === 'clearWeaklySelectable') {
    // The input that offered them has stopped. `inputLive` is NOT cleared
    // here: Forge clears the set at the END of priority and again at the start
    // of payment, with the prompt and bar for the next input still standing.
    // With nothing named, nothing is offered either way — and until Forge names the next set, the
    // board keeps drawing this one (`./offer-hold.ts`), unless a hold already stands. Only on this
    // seat's own turn: on the other's, the windows the server passes for it were never its to draw,
    // and what it does there itself (a click, a press) holds on its own.
    const drawn = drawnOffer(match);
    if (!holdStandsNow(match) && !drawn.selectionOpen && ownTurn(match)) holdOffer(match, drawn);
    match.weaklySelectable = null;
    match.weaklySelectableManaOnly = null;
  }
  foldFrames(match, [frame], 'live');
}

/** How long a refused card is marked ({@link LiveMatch.refused}). */
export const REFUSED_MS = 900;

function refuse(match: LiveMatch, card: number): void {
  const seq = (match.refused?.seq ?? 0) + 1;
  match.refused = { card, seq };
  // the one `flashIncorrectAction` cause this classifier can tell apart from Forge's own two
  // (`InputPassPriority`, `InputAttack`) — see `mistakes.ts`'s own header on why the order holds.
  setMistake(match, payingMana(match) ? mistakeOfAutoCancel() : null);
  setTimeout(() => {
    if (match.refused?.seq !== seq) return;
    match.refused = null;
    notify(match);
  }, REFUSED_MS);
}

/** How long the mistake bubble's line stays up, then how long its exit takes (the preview's own timing). */
export const MISTAKE_SAY_MS = 3200;
export const MISTAKE_EXIT_MS = 260;

/**
 * the one setter for {@link LiveMatch.mistake} — a null `key` (no certain classification) is a no-op.
 * It notifies, as the clear below does: a refused click Forge never saw changes nothing else, so
 * without it the bubble waited on whatever redrew the board next, and a quiet board drew none.
 */
function setMistake(match: LiveMatch, key: MistakeKey | null): void {
  if (key === null) return;
  const seq = (match.mistake?.seq ?? 0) + 1;
  match.mistake = { key, seq };
  notify(match);
  setTimeout(() => {
    if (match.mistake?.seq !== seq) return;
    match.mistake = null;
    notify(match);
  }, MISTAKE_SAY_MS + MISTAKE_EXIT_MS);
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

/**
 * Everything this seat could still answer or press, and every pop-up that says who is deciding:
 * dropped when the board is replaced, and when the match ends with nothing left to answer them.
 */
function dropOpenInput(match: LiveMatch): void {
  match.asks = [];
  match.reveal = null;
  match.revealed = null;
  match.prompt = null;
  match.promptCard = null;
  match.promptTrigger = null;
  match.promptParts = null;
  match.promptPoolPays = null;
  match.promptPoolChoice = false;
  match.buttons = null;
  match.barHold = null;
  match.windowHalf = null;
  match.selectables = null;
  match.weaklySelectable = null;
  match.weaklySelectableManaOnly = null;
  match.castForbidden = null;
  match.heldChanges = null;
  match.highlighted = null;
  match.highlightedPlayers = null;
  match.inputLive = false;
  match.attackIntent = null;
  match.lastSelectedCard = null;
  match.actCard = null;
  match.refused = null;
  match.offerHold = null;
  match.deferredSelect = null;
  match.promptTargetMore = 0;
  match.promptSelection = null;
  match.sameTarget = false;
  match.waitingOn = null;
  match.coinToss = null;
}

function discardLocal(match: LiveMatch): void {
  match.cursor = null;
  const { seq, ...empty } = foldPackets([]);
  Object.assign(match, empty);
  match.forgeSeq = seq;
  match.view = null;
  dropOpenInput(match);
  match.settled.clear();
  match.says = [];
  match.rolls = [];
  match.flips = [];
  match.hits = [];
  match.faceHits = [];
  match.deathCauses = new Map();
  match.counteredStackItems = new Set();
  match.avatarByPlayerId = null;
  match.unclaimedAvatar = null;
  match.nameByPlayerId = null;
  match.playerIdBySeat = null;
  match.over = false;
  match.finished = false;
  match.ended = null;
  match.losers = null;
  match.lost = null;
  match.endedBy = null;
  unspend(match);
}

/* ── A replay ────────────────────────────────────────────────────────── */

/** One recorded frame, with the marks its envelope carried (`displayOnly`: a reveal shown, not kept). */
export interface ReplayFrame {
  frame: ServerFrame;
  displayOnly?: boolean;
  forceNotice?: boolean;
}

/** What {@link replayMatch} hands a replay's player: the board, and the one way frames reach it. */
export interface ReplayFold {
  match: LiveMatch;
  /**
   * `'start'`: the board from nothing, `frames` folded as a snapshot's history is (a seek, a loop) —
   * no hit, no reveal, only the game's end. `'here'`: `frames` applied on top, as a live board
   * applies its stream (playback), so what a live watcher saw happen is drawn happening.
   */
  fold(frames: readonly ReplayFrame[], from: 'start' | 'here'): void;
}

/** A board with no server: nothing is sent, nothing arrives but what {@link ReplayFold.fold} is handed. */
const NO_SERVER: MatchTransport = {
  on() {},
  emit() {},
  request(_event, _payload, onAck) {
    onAck(new Error('a replay has no server'), undefined);
  },
  disconnect() {},
};

/** The frames that end a game: a fold from the start applies them, so a seek past the end shows the result. */
const endsTheGame = (frame: ServerFrame): boolean =>
  frame.method === 'finishGame' || (frame.kind === 'notify' && frame.method === 'showErrorDialog' && frame.matchEnded === true);

/**
 * A read-only board fed frames directly: a finished match's recording, drawn as its watchers saw it
 * (`../../replay/player.ts`). No server and no resync — the recording is the whole stream and it is
 * already here. `playerId` is the player the recording's `openView` names. `pointers`: what carries the
 * recorded pointer messages to the board's own presence layer (its `on`; nothing is ever sent), and
 * `seats`, each seat's Forge player, so that layer knows whose pointer is drawn at the bottom.
 */
export function replayMatch(matchId: string, playerId: number, options: { pointers?: Pick<MatchTransport, 'on'>; seats?: ReadonlyMap<number, number> } = {}): ReplayFold {
  const match = newMatch({ matchId, transport: options.pointers === undefined ? NO_SERVER : { ...NO_SERVER, on: options.pointers.on } });
  const seats = options.seats ?? null;
  match.seat = 0;
  match.playerId = playerId;
  match.connected = true;
  match.everConnected = true;
  match.spectator = true;
  match.watcher = true;
  match.playerIdBySeat = seats;
  return {
    match,
    fold(frames, from) {
      if (from === 'start') {
        discardLocal(match);
        match.reveal = null;
        match.revealed = null;
        foldFrames(match, frames.map((f) => f.frame), 'history');
        match.playerIdBySeat = seats;
        for (const { frame } of frames) if (endsTheGame(frame)) applyFrame(match, frame);
      } else {
        for (const { frame, displayOnly, forceNotice } of frames) {
          if (displayOnly === true) showReveal(match, frame, forceNotice === true);
          else applyFrame(match, frame);
        }
      }
      notify(match);
    },
  };
}
