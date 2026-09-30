/*
 * The board, on a live match.
 *
 * `Board` is drawn exactly as the fixture harness draws it — this component
 * adds only what a live source has and a fixture does not: a connection line,
 * an error line, and the question Forge is waiting on. Everything it shows is
 * read off the `LiveMatch` handle (`./match.ts`), which re-renders it through
 * `useSyncExternalStore` on the handle's revision counter.
 *
 * ## The prompt
 *
 * One ask is drawn at a time — the oldest open one (`currentAsk`); Forge's
 * game thread asks one question at a time, and anything queued behind it
 * stays open until its turn. `showConfirmDialog` draws as `ConfirmDialog`,
 * the other fourteen through `../prompts/`'s `PromptFor`. Every answer goes
 * back through `answerAsk`, the one seam.
 *
 * The prompt is keyed by `callId`, never by position or revision: the board
 * keeps redrawing under an open prompt as the state channel moves, and a
 * redraw must not remount it and throw away a half-made choice. Its `lookup`
 * is rebuilt from the CURRENT state on each render, so a card that changed
 * under the prompt is named as it is now.
 *
 * A prompt component that throws is a bug in that component — and Forge's
 * thread is parked on the ask it failed to draw. `PromptBoundary` aborts that
 * ask (`unsupported`) so Forge takes its own default, and says so on screen.
 *
 * ### One answer is no question
 *
 * Before any of that, an ask goes past `../prompts/rules.ts`'s `autoAnswer` —
 * the ONE place the browser decides whether a question answers itself. Today
 * that is `getAbilityToPlay` with exactly one ability: the operator's *"one
 * choice shouldn't require this dialog at all"* (wave 20, item 4), and the
 * whole of their *"'choose ability' often needs the click TWICE"* (item 9),
 * because Forge asks that offer twice for one `selectCard` and both copies now
 * answer themselves. The reply goes through `answerAsk` like any other and the
 * board SAYS what it played (`noteAutoAnswered`), so the shortcut is visible;
 * nothing is drawn for it, not even for a frame. `match.fullControl` turns it
 * off and the picker comes back.
 *
 * ## Clicks on the board
 *
 * `Board` gets a `BoardInteraction` built from `boardInteraction(match)` —
 * exactly what Forge named, and nothing else (`./match.ts` says how) — and its
 * callbacks go to `selectCard` / `selectPlayer`, which check the CURRENT state
 * again before sending anything.
 *
 * ## The pointer belongs to the gesture layer
 *
 * Dragging a card, box-drawing over attackers, the targeter arrow: none of it
 * is in this file. It lives in `./gestures/` — framework-free, delegated from
 * this component's own root — and this component's whole part in it is one
 * effect that installs it on the canvas and disposes it when the match handle
 * changes (`installGestures`, `GestureHandle`).
 *
 * Wave 24 moved it out: it was ~280 lines of pointer state in a component
 * whose job is the FRAME, and the frame is what this file is now. The seam is
 * the element, not a prop — the gesture layer is handed `.live` itself and
 * finds the board, the cards and lane A's overlay root under it. So nothing
 * here knows what a drop means, and nothing there knows React.
 *
 * ## The corner stops talking, and the log moves (wave 25 §C)
 *
 * The operator, 2026-09-27: *"i mostly hate all the text in the bottom right
 * it's totally useless"*, and then *"the corner box can still have the
 * full-control toggle and some of the user control like the buttons you had
 * before. but i hate the log, the log must go somewhere else."* So the cluster
 * keeps every CONTROL and has no text row at all: Forge's prompt line and the
 * server's says both moved into `live-logbook`, an overlay on the left edge
 * that the phase rail vacated, **collapsed by default** behind the cluster's
 * own `Log` toggle.
 *
 * The prompt line kept its test id (`live-says`). It is the only place Forge's
 * own message text is readable, and `e2e/play.spec.ts` — another lane's file —
 * reads it by that id to see what the game is waiting on. The ELEMENT moved;
 * the name it is found by did not.
 *
 * ## The says
 *
 * Lane C's server says a thing to the seat when it acts for it —
 * "auto-passed Upkeep step", "paid U — Volcanic Island" — because an
 * auto-pass nobody can see is indistinguishable from a board that froze
 * (§C.2), and a cast that shows no payment looks free (#8). Those arrive as
 * Tier-A `message` notifies; `match.says` holds the last few (`SAYS_KEPT`) and
 * the logbook draws all of them — the cluster's fixed two-line slot was the
 * only reason it ever drew fewer. A say is a state, not prose — it is rendered
 * exactly as sent, braces said in words like every other rules text.
 *
 * ## The overlays have a blocking, and it is the operator's own (wave 26 §B)
 *
 * `docs/planning/board-layout-2026-09-27.md` is a spec drawn by dragging the
 * real regions on a 1280×800 canvas, and four of its five overlays are this
 * file's. Everything below is that table, in the operator's own percentages:
 *
 *  - **a question has ONE home**, a fixed column at 59.4% across and 24.1%
 *    wide, over the board (*"float over the board makes sense"*). The board
 *    keeps its widths and the column covers it while a question is open. A
 *    centred sheet put the same question in a different place every time,
 *    depending on how tall it was; this one is where the player learned to look.
 *    The column's TOP THIRD is the stack's — `.stack` is drawn inside `Board`
 *    and belongs to lane A, so this file reserves the geometry (`--live-col-*`
 *    in `live.css`) and takes the lower two thirds for the question.
 *  - **the phase rail is 8.4% wide and every step says its name.** At 32px it
 *    could draw marks and the current step only, with every other name clipped;
 *    the operator widened it to ~108px deliberately, so the phases are to be
 *    READ. It also carries the only turn indicator on the page, because §A
 *    deleted the turn bar — `live-turn` is what the specs read now.
 *  - **the controls are 112×84**, five buttons, directly under the rail — item
 *    5 (wave 30) deleted `Leave` and item 7 put `Settings` in the slot it
 *    vacated, so the five wave 25 took the prose out of are still five. Wave
 *    25 took the prose out; this is the rest of it.
 *  - **the log is a 36×32 button** of its own, in the gutter above the rail, and
 *    the panel it opens is the full height of the match. It is out of the
 *    control cluster entirely: the cluster is five buttons at 112px wide and a
 *    sixth would not fit, and the operator drew the log's button somewhere else.
 *
 * ## Nothing says `Seat 1, live.` any more
 *
 * The operator, 2026-09-27: *"i dont understand what 'turn bar' and 'seat 1
 * live' are relevant for so i think these should just be deleted."* So a LIVE
 * match draws no line about itself at all — `statusText` returns `null` for that
 * one state and the element is not rendered.
 *
 * The other five states keep the line, and that is not a hedge: in every one of
 * them there is no board, so the line is the only thing on the page. `Match
 * gone.` with nothing under it is a player being told what happened; deleting it
 * would leave them a blank screen with nothing on it at all. What the operator
 * was shown, and rejected, was the line on a LIVE table.
 *
 * ## A payment is a question, so it is drawn as one (wave 25 §C.2)
 *
 * The operator, on a Mana Leak: *"if an effect happens that is necessary, it
 * should popout into its own popover modal on top of the game not in some
 * shitty text box."* A mana payment is not one of Forge's `ask` methods — it is
 * a STATE of the live match, `showPromptMessage` plus `updateButtons`, which is
 * exactly why its text used to land in the corner with the rest of the prose
 * and its answers were the cluster's own two buttons. `match.ts`'s
 * `payingMana` already names that state (four facts, all cited there), so this
 * component draws it in the prompt sheet with Forge's own message and Forge's
 * own two labels. No new words, and nothing in `../prompts/` — there is no ask
 * to have a prompt component for.
 *
 * The cluster's OK and Cancel stay live through a payment, because they are the
 * same two buttons: `pressButton` is the one sender either way.
 *
 * The toggle beside the buttons is §C.4's escape hatch: full control OFF is
 * the default (the shortcuts run), ON asks every question and stops at every
 * stop. One click, one `forge:full-control`, `setFullControl` the only
 * sender. It is a preference of the person in the seat, not an answer to
 * anything Forge is waiting on, so it is pressable at ANY time — before the
 * first prompt is exactly when a player wants "ask me everything".
 *
 * ## The controls are a cluster over the board, not a bar under it
 *
 * The operator, 2026-09-26: the bar's CONTENTS are right and its SHAPE is
 * wrong — *"the bottom control bar is ugly"*, and full control *"may live
 * bottom-right, over the board"* (§C.1). So `live__buttons` is out of the flex
 * flow entirely: it is absolutely positioned in the bottom-right corner of
 * `.live`, and the row it used to occupy is the table's now.
 *
 * What did NOT change, because `e2e/table-fit.spec.ts` measures it on every
 * animation frame of a real match: it is still ONE container, still drawn in
 * every frame with the same children, and its box is still the same box at a
 * given window size — *"a fixed home, not a bar on demand"*. That is why its
 * width and height are fixed in `live.css` and every slot inside it is fixed
 * too. A cluster that appeared when Forge asked would fail that spec, and it
 * would be the *"appearing and disappearing"* the operator called ugly in the
 * first place. Wave 25 took the two TEXT rows out of it, so the box is shorter
 * and holds nothing that can grow: every child is now a button.
 *
 * A button is disabled unless Forge enabled it AND no question is open;
 * `pressButton` refuses the same cases, so a disabled button that is somehow
 * pressed still sends nothing. With no bar from Forge yet, the buttons carry
 * neutral labels.
 *
 * **Concede and Settings are in it** (wave 24 §C.4, wave 30 item 7), BELOW OK
 * and Cancel with Full control between them. Neither is an answer to Forge,
 * and keeping them out of reach of Forge's two is what stops a reach for one
 * being a misclick on theirs. Wave 27 §B.1 made the cluster a single column,
 * so "its own row" is now every button's. `Leave` sat where `Settings` is now,
 * just above Concede, from wave 22 §F.1 until item 5 (wave 30) deleted it on
 * the operator's own instruction — *"delete the Leave button; Concede is
 * enough"* — and item 7 put the settings disclosure in the slot it vacated
 * rather than shrinking the cluster, which is what keeps the reachability
 * promise (§7: no fourth floating thing) cheap: one more button in a box that
 * already exists, not a new one.
 *
 * ## Concede asks first
 *
 * `concede` has been on the wire since the beginning and has never had a
 * button (§C.4). It ends the game and nothing undoes it, so the button does
 * not send: it opens a confirmation, and only that confirmation's own yes
 * calls `concede` (`./match.ts`'s sender — this file adds none). Cancel closes
 * it and sends nothing. `conceding` is local state and not a `LiveMatch`
 * field, because it is a question this component asked, not one Forge is
 * parked on.
 *
 * It is deliberately NOT `ConfirmDialog`: that component takes a `ConfirmAsk`
 * — a `showConfirmDialog` frame off the wire, with a callId Forge is waiting
 * on — and there is no such frame here. Synthesising one would put a fake wire
 * ask in the type and a second `confirm-dialog` on the page. So this reuses
 * that dialog's LOOK (`.confirm`, styled in `live.css`) and none of its
 * plumbing.
 *
 * ## The phase reads down the side
 *
 * §C.2: which phase, which step, whose turn, at a glance. `PhaseRail` draws
 * Forge's thirteen `PhaseType` steps as a column at the RIGHT edge (wave 25 §C.4
 * — the operator put it there, and the left edge it used to hold is the
 * logbook's now), grouped the way a turn is, with the step the game is on named
 * and the rest as marks. Presentation only — every value comes off `match.view`,
 * which already carried all three, and nothing new goes on the wire.
 *
 * The current step is marked three ways, because colour may not be the only
 * signal: it is the only one that says its name, its mark is the long one, and
 * it carries `aria-current="step"`. The rail is out of flow and takes no
 * pointer events, so it changes no canvas box (the static-canvas rule) and can
 * never be the thing under the cursor.
 *
 * ## One state, one line
 *
 * The operator, on seeing `forge:join was refused: unknown-match`,
 * `Connected, not seated.` and `Waiting for the game state.` stacked together:
 * *"are these messages coordinated? are they in the right spot? i wonder if it
 * makes sense to show all three."* No — they were three lines for one
 * situation, and two of them were hopeful about a match that was already gone.
 *
 * `liveStatus` is the whole state machine (`LiveStatus`: six states, the names
 * agreed with lane E, which owns what the SERVER says about a gone match). One
 * of them holds, `statusText` gives it one line, and that line is the only one
 * drawn — with one exception, and it is a different kind of thing: while the
 * state is `live`, `lastError` draws its own alert, because a failure INSIDE a
 * live match (a prompt that would not draw, a resync that never caught up) is
 * not what state the board is in. In every other state the status line has
 * already said what the error was about, and `lastError`'s full text is on the
 * line's `title` rather than on a second row.
 *
 * A refusal is an **outcome**, not a status, so it outranks every hopeful
 * branch — and `unknown-match` in particular means the match is gone.
 * `isMatchGone` is the seam that decides that, and it is the ONE line lane E's
 * new wire shape changes.
 */

import { Component, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { DraftCard } from '@hadoku/shared';
import { usePrefs } from '@wolffm/prefs-client/react';

import { routeHash } from '../../screens/route.ts';
import { PHASE_LABEL, type BoardView } from '../adapter.ts';
import { Board, type BoardInteraction, type BoardLayout } from '../Board.tsx';
import { lookupFromState, plainRulesText, withAbilityLabels } from '../prompts/lookup.ts';
import { autoAnswer } from '../prompts/rules.ts';
import { isPromptMethod, PromptFor, type AskOf, type PromptMethod } from '../prompts/index.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { installGestures } from './gestures/index.ts';
import {
  abortAsk,
  answerAsk,
  answerConfirm,
  boardInteraction,
  concede,
  currentAsk,
  declaringAttackers,
  noteAutoAnswered,
  payingMana,
  pressButton,
  SAYS_KEPT,
  selectCard,
  selectPlayer,
  sendStopPreference,
  setFullControl,
  subscribe,
  type LiveAsk,
  type LiveClickables,
  type LiveMatch,
} from './match.ts';
import { getPlayPrefsClient, PLAY_PREFS_DEFAULTS, type PlayPrefs } from './prefs.ts';
import { SettingsPanel } from './SettingsPanel.tsx';
import './live.css';

/* ── Where the match is: six states, one line ─────────────────────────── */

/**
 * The states a live board can be in. Exactly one holds, and exactly one line
 * is drawn for it.
 *
 * These names are the wave-22 contract with lane E, which owns what the SERVER
 * says when a match is gone; neither lane renames them and neither invents the
 * other's text. `unknown-match` is NOT one of them: it is a refusal on the
 * wire, and what it MEANS is `match-gone`.
 */
export type LiveStatus =
  | 'connecting'
  | 'connected-not-seated'
  | 'seated-waiting-for-state'
  | 'live'
  | 'refused'
  | 'match-gone';

/** The refusal that means the match itself is gone, rather than this join. */
export const MATCH_GONE_REFUSAL = 'unknown-match';

/**
 * What a player is told when the match they asked for is not there any more —
 * the server's own sentence (`MATCH_GONE_WORDS`, `apps/server/src/play/socket.ts`,
 * sent as `message` on the `match-gone` ack).
 *
 * It is held here and not read off the ack because `match.ts` folds a refused ack
 * into `lastError` as the refusal CODE alone and keeps nothing else of it; until
 * it keeps `message`, this is the same string the server sends, and it is only
 * ever drawn for `unknown-match`, which is the one refusal that carries it.
 */
export const MATCH_GONE_SENTENCE =
  'This match is no longer running on the server — it ended when the server restarted or when Forge stopped. Nothing you did caused it. Start a new match to play again.';

/**
 * This socket is WATCHING: the account holds the seat in another window, and
 * only that window may act (`LiveMatch.spectator`, shape 3 of the wave's agreed
 * seams — the server's `forge:role`). Read through a structural type so this file
 * does not depend on the field's landing order; `false` until the server says.
 */
export function isSpectator(match: LiveMatch): boolean {
  return (match as { spectator?: boolean }).spectator === true;
}

/** The server's `ended` frame has arrived (`LiveMatch.over`, shape 4). */
export function isOver(match: LiveMatch): boolean {
  return (match as { over?: boolean }).over === true;
}

/** `forge:join was refused: unknown-match` → `unknown-match`. */
const REFUSAL = /\bwas refused: (.+)$/;

/**
 * The refusal a `forge:join` / `forge:resync` ack carried, or null.
 *
 * `match.ts` folds a refused ack into one sentence — the event, then the
 * server's own word — and this is the ONE place the client reads that word back
 * out. Every other `lastError` (an unanswered ack, a snapshot that did not
 * parse, a prompt that would not draw) is not a refusal and does not come back
 * through here.
 */
export function refusalOf(match: LiveMatch): string | null {
  const found = REFUSAL.exec(match.lastError ?? '');
  return found === null ? null : found[1]!;
}

/**
 * **The seam.** Whether the match this board is pointed at is gone.
 *
 * Today the only signal is the refusal word on the join ack, so that is what
 * this reads. Lane E is making a gone match distinguishable on the wire from a
 * generic refusal: when that shape lands, THIS function's body is the one line
 * that changes — nothing else in this file, and nothing in `live.css`, asks
 * the question.
 */
export function isMatchGone(match: LiveMatch): boolean {
  return refusalOf(match) === MATCH_GONE_REFUSAL;
}

/**
 * Which state the board is in. The whole machine, in reading order.
 *
 * An outcome outranks a status: a refused join is not "connecting", and a match
 * that is gone is not "not seated" — which is exactly the stack of three the
 * operator was shown. `connecting` covers the handshake whole, socket and join
 * both, because a join in flight with no seat yet is not a state a player can
 * do anything about; `connected-not-seated` is the one that lasts — the socket
 * is up, nothing is in flight, and no seat came back.
 */
export function liveStatus(match: LiveMatch): LiveStatus {
  if (isMatchGone(match)) return 'match-gone';
  if (refusalOf(match) !== null) return 'refused';
  if (!match.connected) return 'connecting';
  if (match.seat === null) return match.awaitingSnapshot ? 'connecting' : 'connected-not-seated';
  if (match.view === null) return 'seated-waiting-for-state';
  return 'live';
}

/**
 * The one line, in the operator's register: a state, and no prose about it —
 * and **no line at all for a live match** (wave 26 §B.5).
 *
 * `null` is the `live` case, and it is the whole of the deletion the operator
 * asked for: *"i dont understand what 'turn bar' and 'seat 1 live' are relevant
 * for so i think these should just be deleted."* `Seat 1, live.` said nothing a
 * player could not see by looking at their own table.
 *
 * Every other state returns a sentence, because in every other state there is no
 * board and this line is the only thing on the page. See the module header.
 */
export function statusText(match: LiveMatch): string | null {
  // Both seated branches are reached only with a seat; the fallback keeps this
  // total rather than asserting.
  const seat = `Seat ${(match.seat ?? 0) + 1}`;
  switch (liveStatus(match)) {
    case 'connecting':
      return 'Connecting…';
    case 'connected-not-seated':
      return 'Connected, not seated.';
    case 'seated-waiting-for-state':
      return `${seat}, waiting for the state.`;
    case 'live':
      return null;
    case 'refused':
      return `Refused: ${refusalOf(match) ?? ''}`;
    case 'match-gone':
      return MATCH_GONE_SENTENCE;
  }
}

interface BoundaryProps {
  onError: (error: unknown) => void;
  children: ReactNode;
}

/** Catches a prompt component's throw; see the module header. Keyed by callId, so it resets per ask. */
class PromptBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function LivePrompt({ match, ask }: { match: LiveMatch; ask: LiveAsk }) {
  if (ask.method === 'showConfirmDialog') {
    return <ConfirmDialog ask={ask} onAnswer={(yes) => answerConfirm(match, ask.callId, yes)} />;
  }
  if (!isPromptMethod(ask.method)) {
    // Unreachable while forge-wire's blocking set is the fifteen; a sixteenth
    // would land here, and throwing makes the boundary abort it.
    throw new Error(`no prompt component for ${ask.method}`);
  }
  return (
    <PromptFor
      ask={ask as AskOf<PromptMethod>}
      // `getAbilityToPlay` is the one ask whose options carry their own label
      // (the bridge sends Forge's "cost then description"; the state channel
      // has no SpellAbilityView to read). Layered over the fold so an
      // unlabelled offer still draws its "ability #id" fallback.
      lookup={withAbilityLabels(lookupFromState(match.state), abilityLabelsOf(ask))}
      onAnswer={(reply) => answerAsk(match, ask.callId, ask.method, reply)}
    />
  );
}

/** The labels a `getAbilityToPlay` offer carries, keyed by ability id. */
function abilityLabelsOf(ask: LiveAsk): Record<number, string> {
  if (ask.method !== 'getAbilityToPlay') return {};
  const out: Record<number, string> = {};
  for (const ab of ask.abilities) if (ab.label !== undefined) out[ab.id] = ab.label;
  return out;
}

/**
 * How many of the held says the logbook draws: all of them.
 *
 * It was 2 while the log lived in the control cluster, because the cluster's box
 * is fixed and its slot was two lines tall. The logbook has the height, so the
 * cap is the server's own `SAYS_KEPT` and nothing is dropped between what the
 * match holds and what the panel shows.
 */
export const SAYS_SHOWN = SAYS_KEPT;

/* ── the log, as something you can read (wave 28 §A.11, render half) ──── */

/**
 * What KIND of thing a log line reports.
 *
 * The operator, 2026-09-28: *"log should show the whole game log not just what
 * i've done … properly color things based on what happened like damage taken …
 * any cardnames should be hoverable and show what card it is."* Lane B shipped
 * the first clause — `match.ts`'s `sayToTable` composes a line once per
 * recipient, from that recipient's own folded history, so the whole table's
 * events reach both seats without a name crossing that the recipient may not
 * know. This is the rest of it.
 *
 * **The vocabulary is small and it is ours, which is why classifying it by its
 * words is honest here and would not be in general.** Every line on this channel
 * is a `message` notify, and there are four writers of them in the whole repo:
 * `paid …` and `<seat> paid …` (`auto.ts`'s `paymentLine`), `full control
 * on`/`off` (`match.ts`'s own `say`), `played …` (this client's
 * `noteAutoAnswered`), and whatever Forge itself sends through `showMessage`.
 * Only the last is out of our hands, and it falls to `said`, which is the
 * default and is styled as plain text.
 *
 * **Forge's own game log cannot reach us today**, so there is no richer source
 * to classify: `GameEventAddLog` is modelled in `packages/forge-wire` and
 * `bridge/PlayBridge.java:538` sends `"events": []` on every delta on purpose,
 * because per-event visibility rules do not exist yet. When they do, an
 * `AddLog` arrives with a `GameLogEntryType` and a `sourceCard` — a KIND and a
 * card id, structured — and this function is the thing it replaces rather than
 * something it has to be bent into.
 */
export type LogKind = 'payment' | 'damage' | 'life' | 'play' | 'control' | 'said';

/* ── Forge's second button, and the two labels we refuse (items 6, 16) ───── */

/**
 * Whether Forge's SECOND button is offered at all.
 *
 * The operator, 2026-09-28: *"i hate the 'alpha strike' button just delete it."*
 * There is no alpha-strike affordance in this repo and there never was —
 * `grep -rni alpha` over `apps/`, `packages/` and `e2e/` finds two doc lines
 * about Forge's protocol and nothing else. What the operator saw is **Forge's own
 * label, painted by us**:
 *
 *     InputAttack.java:89
 *       String alphaLabel = canCallBackAttackers() ? localizer.getMessage("lblCallBack")
 *                                                  : localizer.getMessage("lblAlphaStrike");
 *     res/languages/en-US.properties:472   lblAlphaStrike=Alpha Strike
 *
 * and the two call sites below, which render `bar.label2` verbatim. So the button
 * is Forge's and the fix is ours: during declare-attackers we do not offer it.
 *
 * **Wave 30 item 16 widens that to `Call Back` as well, on the operator's own
 * instruction, and the cost is real and named rather than hidden: `Call Back`
 * is Forge's `lblCallBack`, offered exactly when
 * `InputAttack.canCallBackAttackers()` is true, and it is the only way this UI
 * ever let a player UN-DECLARE attackers they had already committed to. Wave
 * 29 kept it for exactly that reason — `Alpha Strike` is a shortcut the
 * operator asked gone, `Call Back` was an undo — and this wave removes the undo
 * too, because the operator asked for it anyway with the cost stated. Nothing
 * downstream of this function changes: `declaringAttackers` alone decides it
 * now, so the button is refused for the whole of declare-attackers and never
 * unlocks partway through.**
 *
 * Off `declaringAttackers` — structured state Forge already tells this client,
 * never off the label's TEXT, because the label is localized and a client that
 * reads Forge's prose to decide what a button means is a client that breaks in
 * French.
 *
 * The button ITSELF stays in the DOM, disabled, and reads `Cancel`. It is not
 * removed: the control cluster is a fixed box with a fixed slot for each of its
 * children, and `e2e/table-fit.spec.ts` fails a frame in which that box is not
 * the box it was in every other frame. Disabled-and-neutral is also the
 * truthful reading outside declare-attackers, where this button is still
 * Forge's own generic Cancel (a mana payment's, for one) and unaffected by any
 * of this.
 */
function offersSecondButton(match: LiveMatch): boolean {
  return !declaringAttackers(match);
}

/** What the second button says: Forge's word, or the neutral one when we refuse it. */
function secondLabel(match: LiveMatch): string {
  const bar = match.buttons;
  if (!offersSecondButton(match)) return 'Cancel';
  return bar === null || bar.label2 === '' ? 'Cancel' : bar.label2;
}


export function logKind(line: string): LogKind {
  if (/^full control (on|off)$/.test(line)) return 'control';
  if (/\bpaid\b/.test(line)) return 'payment';
  if (/\bdamage\b|\bdeals?\b/i.test(line)) return 'damage';
  if (/\blife\b|\bgains?\b|\bloses\b/i.test(line)) return 'life';
  if (/\b(played|casts?|plays)\b/i.test(line)) return 'play';
  return 'said';
}

/**
 * The cards this viewer can put a name to, by lower-cased name.
 *
 * Built from the BOARD VIEW and nothing else, which is what makes the hover
 * leak-free by construction: every card in it is already drawn on this viewer's
 * own screen (their hand, either battlefield, either graveyard, either exile, or
 * a stack item's source). An opponent's hand is a COUNT in `BoardView` — the
 * adapter never maps those cards — so there is nothing here to reveal that the
 * viewer could not already click on.
 *
 * A name the viewer's board does not hold simply draws as text with no hover,
 * which is the right answer: we have no card to show.
 */
/** Reused so `interaction.actionable` allocates nothing when there is no glow to draw. */
const EMPTY_CARD_IDS: ReadonlySet<number> = new Set();

/**
 * Item 17.2's staged id, or `undefined` when nothing is staged — see
 * `BoardInteraction.stagedCardId`'s own note for the full argument. Exported
 * for its own test.
 *
 * `blocked` is `askOpen || paying`: an ask or a payment window claims the
 * SAME footprint (`board.css`'s `.staging`), so a card the player is casting
 * stays in its ordinary hand slot for as long as either is showing, rather
 * than the two drawing on top of each other.
 */
export function stagedHandCardId(match: LiveMatch, offered: LiveClickables, blocked: boolean): number | undefined {
  if (blocked || !offered.selectionOpen) return undefined;
  const id = match.lastSelectedCard;
  if (id === null) return undefined;
  const viewer = match.view?.players.find((p) => p.isViewer);
  return viewer?.hand?.some((c) => c.id === id) === true ? id : undefined;
}

/** The forge ids of every card of each name in the view — what a log line's name hands the inspector. */
export function cardIdsNamedInView(view: BoardView | null): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (view === null) return out;
  const add = (card: DraftCard, id: number): void => {
    const key = card.name.toLowerCase();
    const held = out.get(key);
    if (held === undefined) out.set(key, [id]);
    else held.push(id);
  };
  for (const p of view.players) {
    for (const zone of [p.hand ?? [], p.battlefield, p.graveyard, p.exile]) for (const c of zone) add(c.card, c.id);
  }
  for (const item of view.stack) if (item.sourceCard !== null && item.sourceCardId !== null) add(item.sourceCard, item.sourceCardId);
  return out;
}

export function cardsNamedInView(view: BoardView | null): Map<string, DraftCard> {
  const out = new Map<string, DraftCard>();
  if (view === null) return out;
  const add = (card: DraftCard): void => {
    const key = card.name.toLowerCase();
    if (!out.has(key)) out.set(key, card);
  };
  for (const p of view.players) {
    for (const zone of [p.hand ?? [], p.battlefield, p.graveyard, p.exile]) for (const c of zone) add(c.card);
  }
  for (const item of view.stack) if (item.sourceCard !== null) add(item.sourceCard);
  return out;
}

/**
 * A log line, split into the card names it holds and the text between them.
 *
 * Longest name first, so `Volcanic Island` is one match rather than `Island`
 * inside it, and case-insensitively, because Forge's own strings and ours do not
 * agree about it. Non-overlapping: a name already consumed cannot be matched
 * again inside a later one.
 */
export function splitLogLine(line: string, cards: ReadonlyMap<string, DraftCard>): (string | DraftCard)[] {
  const names = [...cards.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return line === '' ? [] : [line];
  const out: (string | DraftCard)[] = [];
  const lower = line.toLowerCase();
  let at = 0;
  while (at < line.length) {
    let hitAt = -1;
    let hitName = '';
    for (const name of names) {
      const i = lower.indexOf(name, at);
      if (i === -1) continue;
      if (hitAt === -1 || i < hitAt || (i === hitAt && name.length > hitName.length)) {
        hitAt = i;
        hitName = name;
      }
    }
    if (hitAt === -1) {
      out.push(line.slice(at));
      break;
    }
    if (hitAt > at) out.push(line.slice(at, hitAt));
    out.push(cards.get(hitName)!);
    at = hitAt + hitName.length;
  }
  return out.filter((p) => p !== '');
}

/**
 * One line of the table's log.
 *
 * Three things beyond the words:
 *
 *  - `data-log-kind`, which `live.css` colours. Damage is the one the operator
 *    named; it is not the only one that is worth telling apart at a glance.
 *  - `data-log-who`, `them` when the line opens with the OTHER seat's name.
 *    `sayToTable` attributes the copy it sends the opponent and leaves the
 *    actor's own copy unattributed, so a line that starts with a seat name is by
 *    construction someone else's doing — and an unattributed line in a table's
 *    log reads as your own, which is the thing this marks.
 *  - a card name is HOVERABLE and shows the card — THROUGH THE INSPECTOR, not a
 *    surface of its own (wave 31 P12: *"we shouldn't even create a separate hover
 *    display just use the existing one"*). The name carries `data-inspect-ids`,
 *    the forge ids of every card of that name in the view, and
 *    `../inspect/index.ts` — which listens on the document — enlarges the tile the
 *    board already drew for the first of them. A name whose cards have no tile
 *    on the page (a zone the board draws as a count, a card hidden from this
 *    seat) shows NOTHING: that is the honest answer, and inventing a face for it
 *    would be the second surface again. The name is `tabindex`-reachable, and the
 *    inspector answers focus as it answers hover.
 */
function LogLine({
  line,
  cards,
  ids,
  theirName,
}: {
  line: string;
  cards: ReadonlyMap<string, DraftCard>;
  ids: ReadonlyMap<string, readonly number[]>;
  theirName: string | null;
}) {
  const text = plainRulesText(line);
  const mine = theirName === null || !text.startsWith(`${theirName} `);
  return (
    <li data-log-kind={logKind(text)} data-log-who={mine ? 'you' : 'them'}>
      {splitLogLine(text, cards).map((piece, i) =>
        typeof piece === 'string' ? (
          <span key={i}>{piece}</span>
        ) : (
          <span
            key={i}
            className="live__log-card"
            data-log-card={piece.name}
            data-inspect-ids={(ids.get(piece.name.toLowerCase()) ?? []).join(',')}
            tabIndex={0}
          >
            {piece.name}
          </span>
        ),
      )}
    </li>
  );
}

/* ── The phase, down the side (§C.2) ─────────────────────────────────── */

/**
 * Forge's `PhaseType` constants in turn order, grouped the way a turn is.
 *
 * The constant names are Forge's (`PhaseType.java:16-28`) and the words for
 * them are `PHASE_LABEL`'s, in `../adapter.ts` — this lane draws them and
 * renames none. The GROUPS are the turn's own structure, and they are what
 * makes a column of thirteen readable at a glance: a gap between groups, and
 * only the step the game is on says its name.
 */
const PHASE_ORDER: ReadonlyArray<{ phase: string; group: string }> = [
  { phase: 'UNTAP', group: 'begin' },
  { phase: 'UPKEEP', group: 'begin' },
  { phase: 'DRAW', group: 'begin' },
  { phase: 'MAIN1', group: 'main1' },
  { phase: 'COMBAT_BEGIN', group: 'combat' },
  { phase: 'COMBAT_DECLARE_ATTACKERS', group: 'combat' },
  { phase: 'COMBAT_DECLARE_BLOCKERS', group: 'combat' },
  { phase: 'COMBAT_FIRST_STRIKE_DAMAGE', group: 'combat' },
  { phase: 'COMBAT_DAMAGE', group: 'combat' },
  { phase: 'COMBAT_END', group: 'combat' },
  { phase: 'MAIN2', group: 'main2' },
  { phase: 'END_OF_TURN', group: 'end' },
  { phase: 'CLEANUP', group: 'end' },
];

/**
 * Whose turn it is, in the one word the rail has room for.
 *
 * `nobody` is the honest answer before the first turn and after the last: the
 * view carries no active player then, and the rail says so rather than picking
 * a seat.
 */
export function whoseTurn(view: BoardView): 'yours' | 'theirs' | 'nobody' {
  const active = view.players.find((p) => p.id === view.activePlayerId);
  if (active === undefined) return 'nobody';
  return active.isViewer ? 'yours' : 'theirs';
}

/** The one row the six combat steps share while the game is not in combat. */
const COMBAT_ROW = 'COMBAT';

interface RailRow {
  phase: string;
  group: string;
  /** Index, in `PHASE_ORDER`, of the LAST step this row stands for: the row is past once the game is beyond it. */
  last: number;
}

/**
 * The rows the rail draws. **Combat is six steps only while the game is in it**
 * (wave 31 P1 — asked twice: *"collapse the combat phases"*). Outside combat the
 * six are ONE row, `Combat`, and the rail's box does not change: its height is
 * definite in `live.css` and the rows share it out, so eight rows and thirteen
 * are the same box with taller and shorter rows (`e2e/table-fit.spec.ts` reads
 * `.live__step-name` for clipping, and taller rows clip nothing).
 */
function railRows(inCombat: boolean): RailRow[] {
  const out: RailRow[] = [];
  PHASE_ORDER.forEach(({ phase, group }, i) => {
    if (group === 'combat' && !inCombat) {
      if (out.at(-1)?.phase !== COMBAT_ROW) out.push({ phase: COMBAT_ROW, group, last: i });
      else out.at(-1)!.last = i;
      return;
    }
    out.push({ phase, group, last: i });
  });
  return out;
}

/**
 * The phase rail. Presentation only — turn, step and whose turn all come off
 * the view that was already on screen (see the module header).
 *
 * A step before the current one carries `data-past`, so the column reads as a
 * turn in progress rather than a menu. A phase Forge sends that is not one of
 * the thirteen leaves nothing current: `PHASE_LABEL` has no word for it either,
 * and inventing one here would be this lane guessing at the engine.
 *
 * **Every step draws its name** (wave 26 §B.2). It used to be the current one
 * only, because a 32px rail had room for a mark and nothing else; the operator
 * widened it to 8.4% of the width so that the thirteen could be read, and a rail
 * that is wide enough for the names and draws none of them is the same rail it
 * was. The current step is still marked three ways — its mark is the long one,
 * its name is the accent, and it carries `aria-current="step"`.
 *
 * It is also the ONLY turn indicator on the page now that §A has deleted the
 * turn bar. `live-turn` is the row, and `live-turn-n` is Forge's own turn
 * counter alone — two ids, because the row reads `14theirs` and a spec that
 * wants the number should not have to take it apart.
 */
function PhaseRail({ view }: { view: BoardView }) {
  const at = PHASE_ORDER.findIndex((p) => p.phase === view.phase);
  const whose = whoseTurn(view);
  const inCombat = at >= 0 && PHASE_ORDER[at]!.group === 'combat';
  const rows = railRows(inCombat);
  return (
    <div
      className="live__phases"
      data-testid="live-phases"
      data-whose={whose}
      data-phase={view.phase ?? ''}
      data-turn={view.turn}
      data-combat={inCombat ? '' : undefined}
    >
      <p className="live__turn" data-testid="live-turn">
        <span className="live__turn-n" data-testid="live-turn-n">
          {view.turn}
        </span>
        <span className="live__turn-who">{whose}</span>
      </p>
      <ol className="live__steps" aria-label="Phase">
        {rows.map(({ phase, group, last }, i) => {
          const current = phase === view.phase;
          return (
            <li
              key={phase}
              className="live__step"
              data-phase={phase}
              data-group={group}
              data-current={current ? '' : undefined}
              data-past={at >= 0 && last < at ? '' : undefined}
              data-group-start={i === 0 || rows[i - 1]!.group !== group ? '' : undefined}
              aria-current={current ? 'step' : undefined}
            >
              <span className="live__mark" aria-hidden="true" />
              <span className="live__step-name">{PHASE_LABEL[phase] ?? (phase === COMBAT_ROW ? 'Combat' : phase)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ── Concede, behind a confirmation (§C.4) ───────────────────────────── */

/**
 * The confirmation Concede opens. It sends nothing itself: `onConcede` is the
 * only path to `concede`, and `onCancel` is the only other way out.
 *
 * `role="alertdialog"` with the safe button focused: Enter on a dialog nobody
 * read must not end the game. Escape is the same as Cancel, which is what a
 * dialog is expected to do and costs one handler.
 */
function ConcedeAsk({ onConcede, onCancel }: { onConcede: () => void; onCancel: () => void }) {
  const titleId = useId();
  const messageId = useId();
  return (
    <div
      className="live__ask"
      data-testid="live-concede-ask"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <section className="confirm" role="alertdialog" aria-labelledby={titleId} aria-describedby={messageId}>
        <h2 className="confirm__title" id={titleId}>
          Concede
        </h2>
        <p className="confirm__message" id={messageId}>
          You lose this game.
        </p>
        <div className="confirm__actions">
          <button
            type="button"
            className="button confirm__button"
            data-testid="live-concede-no"
            data-default
            autoFocus
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button confirm__button live__danger"
            data-testid="live-concede-yes"
            onClick={onConcede}
          >
            Concede
          </button>
        </div>
      </section>
    </div>
  );
}

/* ── A payment is a question (wave 25 §C.2) ──────────────────────────── */

/**
 * The payment window: Forge's own message, and Forge's own two labels.
 *
 * It is drawn in the same KIND of host the asks are drawn in — `.live__prompt`,
 * so it inherits the placement the operator asked for: centred, above the
 * cluster, clear of the canvas.
 *
 * Its test id is its OWN (`live-payment-host`) and deliberately not
 * `live-prompt`, because `live-prompt` means *"one of Forge's fifteen asks is
 * open"* to three e2e readers that would all get this wrong: `answerPrompt`
 * (`e2e/play/prompts.ts`) switches on `data-method` and throws on a host that
 * has none, `e2e/arrow.spec.ts` looks for that host's `prompt-submit`, and
 * `e2e/table-fit.spec.ts`'s stuck-detector treats an open prompt as "a person is
 * being asked, leave it alone" — which is the opposite of what a payment needs.
 * `table-fit` measures this host under its own id instead.
 *
 * The buttons send through `pressButton`, the one sender — the same one the
 * cluster's OK and Cancel use, and it refuses a bar Forge has disabled whichever
 * button was pressed. Button one is the default only while Forge has ENABLED it:
 * `InputPayMana` enables its `Auto` when it has sources to pay with
 * (`InputPayMana.java:405`), and a cost that cannot be auto-paid has no default
 * answer at all — the player taps sources on the board instead.
 *
 * No title. Forge's message is the question, and a heading here would be this
 * lane inventing a word for a window whose whole point is that it says what
 * Forge said.
 */
function PaymentWindow({ match }: { match: LiveMatch }) {
  const messageId = useId();
  const bar = match.buttons;
  return (
    <div className="live__prompt" data-testid="live-payment-host">
      <section className="confirm live__payment" data-testid="live-payment" role="dialog" aria-labelledby={messageId}>
        <p className="confirm__message" id={messageId}>
          {plainRulesText(match.prompt ?? '')}
        </p>
        <div className="confirm__actions">
          <button
            type="button"
            className="button confirm__button"
            data-testid="live-payment-ok"
            data-default={bar !== null && bar.enable1 ? '' : undefined}
            disabled={bar === null || !bar.enable1}
            onClick={() => pressButton(match, 'ok')}
          >
            {bar === null || bar.label1 === '' ? 'OK' : bar.label1}
          </button>
          <button
            type="button"
            className="button confirm__button"
            data-testid="live-payment-cancel"
            disabled={bar === null || !bar.enable2 || !offersSecondButton(match)}
            onClick={() => pressButton(match, 'cancel')}
          >
            {secondLabel(match)}
          </button>
        </div>
      </section>
    </div>
  );
}

/** What a watching window is offered: nothing. */
const INERT_CLICKABLES: LiveClickables = {
  selectable: EMPTY_CARD_IDS,
  selectablePlayers: EMPTY_CARD_IDS,
  selectionOpen: false,
};

export interface LiveBoardProps {
  match: LiveMatch;
  /**
   * The room this match was started from, when the route knows it — the one way
   * back a gone match offers. Absent: the lobby. (A `#/match/<id>` route carries
   * no room, so `MatchScreen` passes one only when it has one.)
   */
  roomId?: string | null;
}

export function LiveBoard({ match, roomId = null }: LiveBoardProps) {
  useSyncExternalStore(
    (listener) => subscribe(match, listener),
    () => match.revision,
  );
  /*
   * A WATCHING socket (shape 3): the account holds this seat in another window,
   * and two windows acting on one seat is exactly what the operator ruled out.
   * So this window draws the table and answers nothing — no ask is drawn or
   * auto-answered, no button presses, no click or drag reaches Forge, Concede is
   * inert — and hover, the inspector and the log stay. `spectator` is read every
   * render, so a promotion lifts all of it without a reload.
   */
  const spectator = isSpectator(match);
  const over = isOver(match);
  const pending = currentAsk(match);
  /*
   * One answer is no question (§B, items 4 and 9). `rules.ts`'s `autoAnswer`
   * is the only place that decides it; here it is sent, and the prompt that
   * would have asked is never drawn. Full control turns it off, and then the
   * picker comes back for one ability as it does for two.
   */
  const auto = pending === null || match.fullControl || spectator ? null : autoAnswer(pending);
  const autoCallId = auto === null || pending === null ? null : pending.callId;
  useEffect(() => {
    if (autoCallId === null || auto === null) return;
    // `answerAsk` refuses a callId that is no longer open, so a re-render
    // between the reply and the frame that closes it cannot answer twice.
    if (answerAsk(match, autoCallId, auto.method, auto.reply)) noteAutoAnswered(match, auto.why);
  }, [match, autoCallId, auto]);
  /* Nothing renders for an ask that answers itself — not even for a frame. */
  const ask = auto === null && !spectator ? pending : null;
  const bar = match.buttons;
  const status = liveStatus(match);
  /* `null` while the match is live, which is the whole of §B.5. */
  const statusLine = statusText(match);
  /*
   * The status line is the only line about WHERE the match is. `lastError`
   * draws its own row only while the board is live, where it is a failure
   * inside a match rather than the match's state — every other case has
   * already been said above, and saying it twice is the bug §F.2 names.
   */
  const alert = status === 'live' ? match.lastError : null;
  const askOpen = ask !== null;
  /*
   * Forge is parked on a mana payment (§C.2). `payingMana` is the whole
   * predicate and it already refuses while any ask is queued, so the two can
   * never be drawn at once; the `ask === null` here says that in one place
   * rather than relying on it.
   *
   * It is read HERE, above the interaction, because the stack has to know that a
   * question is in front of it (items 7 and 13) and this is one of the two
   * things that can be.
   */
  const paying = !spectator && !askOpen && payingMana(match);
  /*
   * What the log can put a face to, and whose lines are whose. Both come off the
   * board view the viewer is already looking at — see `cardsNamedInView` for why
   * that is the leak-free source — and both are `null`/empty before the first
   * state frame, which draws the log as plain text.
   */
  const logCards = cardsNamedInView(match.view);
  const logIds = cardIdsNamedInView(match.view);
  const theirName = match.view?.players.find((p) => !p.isViewer)?.name ?? null;
  const offered = spectator ? INERT_CLICKABLES : boardInteraction(match);
  const interaction: BoardInteraction = {
    /*
     * `selectionOpen` rides in with the spread: `LiveClickables` already
     * carries it (`boardInteraction` sets it to `match.selectables !== null`),
     * so naming it again here would be one more place for the two to drift.
     */
    ...offered,
    /*
     * `declaringAttackers` does NOT ride in, and cannot: `boardInteraction` is
     * about what Forge OFFERED, and this is about which input Forge is parked
     * on. Forge publishes an open selection from exactly two call sites, both
     * selection inputs (`InputSelectEntitiesFromList.java:57`,
     * `InputSelectTargets.java:68`); `InputAttack` is neither, so its creatures
     * arrive as the ACTIONABLE set with no selection open and `selectionOpen`
     * is false throughout the step. Lane A's arrangement needs to stand down on
     * the viewer's own creatures anyway, or it shadows the attack gesture for
     * the whole of it — and lane B derives the fact from structured state
     * (`view.phase` and `view.activePlayerId`), never from prompt text (§0b).
     *
     * This component computes neither fact. It is the one place both can be
     * read off the same `LiveMatch` handle, so it is where they are handed over.
     */
    declaringAttackers: declaringAttackers(match),
    /*
     * A question is in front of the board, so the stack stands aside (items 7 and
     * 13). The two things that draw in that column are the fifteen prompts and
     * the payment window, and both are decided a few lines below as `ask` and
     * `paying` — this is the same pair, named once, so the stack cannot disagree
     * with what is actually on screen.
     */
    questionOpen: askOpen || paying,
    /*
     * Item 16's glow: Forge's actionable set, and ONLY while nothing is
     * asking. `offered.selectable` IS that set already, whenever
     * `selectionOpen` is false (`boardInteraction`'s own union) — a real
     * SELECTION replaces its meaning with "answer with one of these", which
     * the ring alone already says. Computed here rather than read off
     * `match.weaklySelectable` directly so it can never drift from what
     * `selectable` itself claims for the same cards.
     */
    actionable: offered.selectionOpen ? EMPTY_CARD_IDS : offered.selectable,
    /*
     * Item 17.2's staging area: the hand card this seat clicked to cast,
     * while Forge is asking for its target and nothing else is on top of the
     * board (`stagedCardId`'s own note on why an ask or a payment wins the
     * same footprint). `boardCardById` is the one lookup, exported below for
     * its own test.
     */
    stagedCardId: stagedHandCardId(match, offered, askOpen || paying),
    onSelectCard: (cardId) => {
      if (!spectator) selectCard(match, cardId);
    },
    onSelectPlayer: (playerId) => {
      if (!spectator) selectPlayer(match, playerId);
    },
  };

  const rootRef = useRef<HTMLDivElement>(null);
  /*
   * Concede's confirmation is open. Local state, not a `LiveMatch` field: it
   * is this component's own question, nothing on the wire is waiting on it,
   * and a resync must not answer it.
   */
  const [conceding, setConceding] = useState(false);
  /*
   * The logbook is open. Local state and COLLAPSED by default (§C.3): the
   * operator's complaint was that this text was on screen at all times, and the
   * cluster's `Log` toggle is how it comes back. It is a preference of the person
   * in the seat, like full control, so nothing on the wire touches it.
   */
  const [logOpen, setLogOpen] = useState(false);
  const logbookId = useId();

  /*
   * The settings panel is open. Local state, not a `LiveMatch` field — it is
   * this component's own disclosure, like the logbook's, not a question Forge
   * or the wire is waiting on.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /*
   * Board layout (item 11): a PROP of `Board`, `single` by default, read from
   * the persisted preference below once it loads. Lives here, not inside
   * `SettingsPanel`, because `<Board>` needs it whether or not Settings is
   * ever opened.
   */
  const [boardLayout, setBoardLayout] = useState<BoardLayout>(PLAY_PREFS_DEFAULTS.boardLayout);
  /*
   * Item 6's persistence, and item 2/6's wire message.
   *
   * `usePrefs` is called ONCE, here, rather than inside `SettingsPanel`:
   * applying a persisted preference to a FRESH match has to happen whether or
   * not the player ever opens Settings this match (a preference set last
   * match must still reach this seat), so it cannot be gated behind a panel
   * that may never mount. Manager, 2026-09-30: *"send it on join/rejoin with
   * the stored preference as well as on toggle, since the server default is
   * off and does not remember."*
   *
   * `sendStopPreference(..., true)` is keyed on `[prefs, match, match.stats.snapshots]`:
   * `prefs` so the first load applies immediately once it resolves, and
   * `match.stats.snapshots` — bumped by every successful `forge:join` /
   * `forge:resync` (`./match.ts`'s `fetchSnapshot`) — so a RESYNC, which
   * hands this seat a freshly-created-or-recovered server `StopPolicy` with
   * no memory of an earlier preference, gets the stored value re-sent too.
   * `force: true` because the persisted value may already equal the
   * client's own default (`false`) while the server still needs telling —
   * `sendStopPreference`'s own doc comment has the full case.
   */
  const { prefs, save: savePrefs } = usePrefs(getPlayPrefsClient());
  const appliedBoardLayout = useRef(false);
  useEffect(() => {
    if (appliedBoardLayout.current || prefs === null) return;
    appliedBoardLayout.current = true;
    if (prefs.boardLayout === 'type-separated') setBoardLayout('type-separated');
  }, [prefs]);
  useEffect(() => {
    // `snapshots === 0` is "no join has completed yet" — sending before that
    // would fire on mount, before the socket has so much as connected, and
    // then fire AGAIN the moment the real join lands (`stats.snapshots`
    // 0 → 1), which is a real double-send and not merely a wasted one.
    if (spectator || prefs === null || match.stats.snapshots === 0) return;
    sendStopPreference(match, prefs.stopAtEndStep ?? PLAY_PREFS_DEFAULTS.stopAtEndStep, true);
    // `match.stats.snapshots` (not `match.stats` itself, which is a mutated-in-place
    // object with a stable identity) is the join/resync trigger; see the block comment above.
  }, [match, prefs, spectator, match.stats.snapshots]);

  /*
   * The pointer layer is lane B's (`./gestures/`), and the element is the whole
   * contract: `installGestures` is handed `.live` and finds the board, the
   * cards and lane A's overlay root under it. No `onChange` — the board redraws
   * off `match.revision` above, and the arrow is drawn in the overlay by the
   * gesture layer itself, so there is nothing here for a callback to do.
   */
  useEffect(() => {
    const canvas = rootRef.current;
    // A watcher's pointer belongs to nobody: no drag, no box, no arrow.
    if (canvas === null || spectator) return undefined;
    const handle = installGestures({ canvas, match });
    return () => handle.dispose();
  }, [match, spectator]);

  if (status === 'match-gone') {
    /*
     * A match that is gone has no table, and so none of the table's chrome: the
     * operator, 2026-09-30, *"why can I still join this if the match is gone?"*.
     * Before this, the page was the status line AND the log toggle, the OK /
     * Cancel / Full control / Settings / Concede cluster and an empty logbook —
     * a live-looking page with nothing behind it. Now: the server's own
     * sentence, and ONE way back, an anchor to the room or else the lobby. No
     * button, nothing Join-shaped.
     */
    return (
      <div className="live live--gone" ref={rootRef} data-testid="live-gone">
        <p
          className="live__status"
          role="status"
          data-testid="live-status"
          data-live-line=""
          data-status={status}
          data-perch="table"
          title={match.lastError ?? undefined}
        >
          {statusLine}
        </p>
        <a
          className="live__gone-back"
          data-testid="live-gone-back"
          href={routeHash(roomId === null ? { kind: 'lobby' } : { kind: 'room', roomId })}
        >
          {roomId === null ? 'Back to the lobby' : 'Back to the room'}
        </a>
      </div>
    );
  }

  return (
    <div
      className="live"
      ref={rootRef}
      data-spectator={spectator ? '' : undefined}
      // The board's own arranging drag is HTML5 and is lane A's; a watcher's
      // window refuses it here, at the root, rather than teaching the board.
      onDragStartCapture={spectator ? (event) => event.preventDefault() : undefined}
    >
      {spectator && (
        <p className="live__spectator" role="status" data-testid="live-spectator">
          Watching: this seat is being played in another window
        </p>
      )}
      {/*
       * `data-live-line` marks every row of text this component draws about
       * itself, so a test can count them: three at once was the bug.
       * `data-perch` is where the line sits — over the board's top-left corner
       * when there is a table under it, or in the table's own space when there is
       * none.
       *
       * A LIVE match has no line (§B.5): `statusText` returns `null` for that one
       * state and nothing is rendered. The five states that keep it are the five
       * with no board, where this line is the whole page.
       */}
      {statusLine !== null && (
        <p
          className="live__status"
          role="status"
          data-testid="live-status"
          data-live-line=""
          data-status={status}
          data-perch={match.view === null ? 'table' : 'corner'}
          title={match.lastError ?? undefined}
        >
          {statusLine}
        </p>
      )}
      {alert !== null && (
        <p className="live__error" role="alert" data-testid="live-error" data-live-line="">
          {alert}
        </p>
      )}
      {match.view !== null && <Board view={match.view} interaction={interaction} boardLayout={boardLayout} />}
      {/* Out of flow, over the board's right edge: it moves no canvas box. */}
      {match.view !== null && <PhaseRail view={match.view} />}
      {/*
       * The logbook (§C.3): Forge's current message and the server's says, over
       * the board's LEFT edge — the side the phase rail vacated — and hidden
       * until the cluster's `Log` toggle opens it.
       *
       * It is always in the DOM and only `hidden`, which is what makes it a
       * disclosure rather than a thing that comes and goes: the toggle's
       * `aria-controls` points at a node that exists, and a spec reading Forge's
       * message off `live-says` finds it whether the panel is open or not.
       *
       * `pointer-events: none` in `live.css`, for the same reason the phase rail
       * has it: an overlay over the canvas must never be the thing under the
       * cursor, or it would shadow the drag gesture on whatever it covers.
       */}
      <div className="live__logbook" data-testid="live-logbook" id={logbookId} hidden={!logOpen}>
        {/*
         * What Forge is waiting on, exactly as Forge said it. This is the line
         * that used to be the cluster's top row; it kept its test id because it
         * is the only place Forge's own message is readable and another lane's
         * spec finds it by that name.
         */}
        <p className="live__says" data-testid="live-says">
          {plainRulesText(match.prompt ?? '')}
        </p>
        {/*
         * The says, newest at the bottom, all of the ones the match holds. Brace
         * notation is said in words, as every other rules text is.
         */}
        <ul className="live__log" data-testid="live-log" aria-label="Said">
          {match.says.slice(-SAYS_SHOWN).map((line, i) => (
            <LogLine key={i} line={line} cards={logCards} ids={logIds} theirName={theirName} />
          ))}
        </ul>
      </div>
      {/*
       * The log's own button (wave 26 §B.4): 36×32, in the right-hand gutter
       * above the phase rail, and NOT in the control cluster any more.
       *
       * The operator drew it there and drew the cluster at 112×84 with five
       * buttons in it, which is the same decision twice: a sixth control does not
       * fit in a box that size, and the log is the one control that answers
       * nothing — not Forge, not the match. It is still a disclosure, with
       * `aria-expanded` and `aria-controls` naming the panel it opens, and still
       * pressable at any time for the reason Full control is: it is a preference
       * about what is on screen.
       */}
      <button
        type="button"
        className="live__log-button"
        data-testid="live-log-toggle"
        aria-expanded={logOpen}
        aria-controls={logbookId}
        title="The log"
        onClick={() => setLogOpen(!logOpen)}
      >
        Log
      </button>
      {/*
       * The control cluster (§C.1). One container, every frame, the same
       * children and the same box — `e2e/table-fit.spec.ts` measures that box on
       * every animation frame of a real match, and now also fails a frame in
       * which either text row came back into it. `live.css` pins it in the
       * right-hand gutter under the rail, at the 112 wide the operator drew
       * (wave 26 §B.3); it is in no flex flow and costs the table no height.
       *
       * Wave 27 §B.1 made it a single COLUMN of five — the shape
       * `board-layout-2026-09-27.md` describes in words — because two 49px
       * columns clipped `Full control` and `Concede`, and the cluster's width is
       * what `board.css` reserves the gutter from and so cannot grow. Item 5
       * (wave 30) deleted `Leave`; item 7 put `Settings` where it was, so the
       * cluster is still five. They are written here in the order they are
       * drawn, so the tab order and the reading order are one order; in two
       * columns they were not.
       */}
      <div className="live__buttons" data-testid="live-buttons">
        <button
          type="button"
          className="live__ok"
          data-testid="live-button-ok"
          disabled={spectator || ask !== null || bar === null || !bar.enable1}
          onClick={() => pressButton(match, 'ok')}
        >
          {bar === null || bar.label1 === '' ? 'OK' : bar.label1}
        </button>
        <button
          type="button"
          className="live__cancel"
          data-testid="live-button-cancel"
          disabled={spectator || askOpen || bar === null || !bar.enable2 || !offersSecondButton(match)}
          onClick={() => pressButton(match, 'cancel')}
        >
          {secondLabel(match)}
        </button>
        <button
          type="button"
          className="live__toggle"
          data-testid="live-full-control"
          aria-pressed={match.fullControl}
          disabled={spectator}
          title="Full control"
          onClick={() => setFullControl(match, !match.fullControl)}
        >
          Full control
        </button>
        {/*
         * Settings (item 7), in the slot `Leave` vacated when item 5 deleted
         * it. A disclosure like the log's — `aria-expanded` follows the
         * panel — and pressable at any time for the same reason Full control
         * is: it is a preference of the person in the seat, not an answer to
         * Forge.
         */}
        <button
          type="button"
          className="live__settings"
          data-testid="live-settings"
          aria-expanded={settingsOpen}
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          Settings
        </button>
        {/*
         * Concede (§C.4), last. It sends NOTHING: it opens the confirmation,
         * and only that dialog's own yes reaches `concede`. Pressable with a
         * question open — giving up is not an answer to what Forge asked.
         */}
        <button
          type="button"
          className="live__concede"
          data-testid="live-concede"
          aria-expanded={conceding}
          disabled={spectator || over}
          title="Concede the game"
          onClick={() => setConceding(true)}
        >
          Concede
        </button>
      </div>
      {ask !== null && (
        <div className="live__prompt" data-testid="live-prompt" data-call-id={ask.callId} data-method={ask.method}>
          <PromptBoundary
            key={ask.callId}
            onError={(error) => {
              const why = error instanceof Error ? error.message : String(error);
              match.lastError = `could not show ${ask.method}; Forge was told to take its default (${why})`;
              abortAsk(match, ask.callId, 'unsupported', `the ${ask.method} prompt failed to draw: ${why}`);
            }}
          >
            <LivePrompt match={match} ask={ask} />
          </PromptBoundary>
        </div>
      )}
      {paying && <PaymentWindow match={match} />}
      {conceding && !spectator && !over && (
        <ConcedeAsk
          onConcede={() => {
            concede(match);
            setConceding(false);
          }}
          onCancel={() => setConceding(false)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          match={match}
          inert={spectator}
          boardLayout={boardLayout}
          onBoardLayoutChange={setBoardLayout}
          onSave={(patch: Partial<PlayPrefs>) => void savePrefs(patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
