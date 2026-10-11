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
 * server's says both moved into `live-logbook`, a wide overlay starting at the
 * left edge the phase rail vacated and reaching across the main view,
 * **collapsed by default** behind the cluster's own `Log` toggle — see that
 * element's own comment for the geometry and why "on the left edge" is now
 * where it STARTS, not the whole of its box.
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
 *    READ. §A deleted the turn bar, and wave 35 (R11) moved the turn counter
 *    itself off the rail and into the logbook — "the log has it" — so
 *    `live-turn` is drawn there now; the rail keeps `data-turn` / `data-whose`
 *    for the specs that read them off `live-phases`.
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
 * The control box's `Next Phase` and `End Turn` stay greyed through a payment:
 * Forge's bar there is `Auto` + `Cancel`, which is neither of them.
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
 * Wave 51: the two game buttons are `Next Phase` and `End Turn`, our words,
 * enabled only for the one input each presses (`barRoute`, `offersEndTurn`);
 * every other answer to Forge's bar is the decision pop-up. `pressButton`
 * refuses a disabled bar too, so a greyed button that is somehow pressed still
 * sends nothing.
 *
 * On the OTHER seat's turn the End Turn slot is repurposed — Auto Yield /
 * Cancel Yield, a standing preference (`setAutoYield`, `isAutoYieldOn`)
 * rather than an answer to Forge's bar, pressable from the instant the other
 * seat's turn starts. The server acts on it (`match.ts`'s `maybeAutoPass`).
 *
 * **Concede and Settings are in it** (wave 24 §C.4, wave 30 item 7), BELOW Next
 * Phase and End Turn with Full control between them. Neither is an answer to Forge,
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

import { Component, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { CLIENT_EVENT, type ClientEvent, type DraftCard } from '@hadoku/shared';
import { YIELDING } from '@hadoku/forge-wire';
import { usePrefs } from '@wolffm/prefs-client/react';

import { navigate, routeHash } from '../../screens/route.ts';
import { roomsClient } from '../../rooms/api.ts';
import { roomFeed } from '../../rooms/feed.ts';
import { tablesClient, type RoomTable, type StartOutcome } from '../../screens/tables.ts';
import { avatarSquareUrl } from '../../room/avatar.ts';
import { PHASE_LABEL, type BoardPlayer, type BoardView, type StackEntry } from '../adapter.ts';
import { Board, type BoardInteraction, type BoardLayout } from '../Board.tsx';
import { lookupFromState, plainRulesText, promptText, withAbilityLabels, type PromptLookup } from '../prompts/lookup.ts';
import { RulesText } from '../prompts/RulesText.tsx';
import { RevealNotice } from '../prompts/RevealNotice.tsx';
import { ConfirmPrompt, DRAW_LABEL, PLAY_LABEL, barRoute, isConfirmPrompt, isPlayOrDrawPrompt, offersEndTurn } from '../prompts/ConfirmPrompt.tsx';
import { autoAnswer, type AutoAnswer } from '../prompts/rules.ts';
import { classifySelection, isPromptMethod, PromptFor, SelectionPrompt, type AskOf, type PromptMethod, type SelectionKind } from '../prompts/index.ts';
import { installGestures } from './gestures/index.ts';
import { stackAsk } from './gestures/stack.ts';
import { installPresence } from './presence.ts';
import { setChainHalted } from './placed.ts';
import { installArrangementSync } from './arrangement-sync.ts';
import { isPacedTransport } from './pace.ts';
import { BAR_STUCK_MS, barStuck } from './bar-hold.ts';
import { deriveSoundEvents } from './sound-events.ts';
import { isMuted, playRole, playSoundEvents, setMatchMusic, type DelayedSoundEvent } from '../../sound/index.ts';
import {
  abortAsk,
  answerAsk,
  answerConfirm,
  blockFocusOf,
  boardInteraction,
  combatCandidates,
  concede,
  currentAsk,
  declaringAttackers,
  declaringBlockers,
  declaringCombat,
  dismissReveal,
  genuinelyAsked,
  isAutoYieldOn,
  liveBar,
  nothingToDecide,
  noteAutoAnswered,
  choosingMulligan,
  payingMana,
  pickedOf,
  pressButton,
  relayout,
  SAYS_KEPT,
  selectCard,
  selectPlayer,
  sendStopPreference,
  setAutoYield,
  setFullControl,
  setSameTarget,
  setTriggerDecision,
  subscribe,
  type LiveAsk,
  type LiveClickables,
  type LiveMatch,
  type MatchTransport,
} from './match.ts';
import { getPlayPrefsClient, PLAY_PREFS_DEFAULTS, type PlayPrefs } from './prefs.ts';
import { SettingsPanel } from './SettingsPanel.tsx';
import { SettingsPopover, useSettingsPopover } from '../../settings/Settings.tsx';
import { eventTarget } from '../../dom.ts';
import './live.css';
import { CoinToss, useCoinFlipping } from './CoinToss.tsx';

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
const MATCH_GONE_REFUSAL = 'unknown-match';

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
function isSpectator(match: LiveMatch): boolean {
  return (match as { spectator?: boolean }).spectator === true;
}

/** The server's `ended` frame has arrived (`LiveMatch.over`, shape 4). */
function isOver(match: LiveMatch): boolean {
  return (match as { over?: boolean }).over === true;
}

/* ── wave 51 §A.6: the stack sits right above the decision area ───────── */

/** What occupies the decision column: a pop-up's sheet, or a card staged for its target. */
const QUESTION_SELECTOR = '.live__prompt > *, .staging__list';

/**
 * The top edge of whatever is in the decision column, in the stack band's own
 * frame (`.board__mid`'s containing block, its `position: relative` parent
 * `.board`), or `null` when nothing is there. The topmost one wins: a card
 * staged for its target sits above its decision pop-up (`data-staged`), and
 * the stack sits above the card.
 */
export function questionTopOf(root: HTMLElement): number | null {
  const frame = root.querySelector('.board__mid')?.parentElement;
  if (frame == null) return null;
  const tops = Array.from(root.querySelectorAll(QUESTION_SELECTOR), (el) => el.getBoundingClientRect())
    .filter((box) => box.height > 0)
    .map((box) => box.top);
  return tops.length === 0 ? null : Math.min(...tops) - frame.getBoundingClientRect().top;
}

/**
 * Whether the board animates (a played card's flight to its slot, the other
 * seat's hand-off). Fast Mode is pacing — no delays before the server's own
 * answers — and a 300 ms flight is not a delay, so it never turns motion off
 * (the operator, 2026-10-08, Fast Mode unchecked and no flight: the gate was
 * wrong either way). Only the person's own reduced-motion setting does.
 */
const motionWanted = (): boolean => !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * Client telemetry (`@hadoku/shared`'s `telemetry.ts`): the server writes it
 * into the match's log beside its own events. Settings on join and on each
 * change; a played card's landing from the gesture layer. A watcher sends none.
 */
function reportClient(transport: Pick<MatchTransport, 'emit'>, matchId: string, kind: ClientEvent['kind'], data: ClientEvent['data']): void {
  transport.emit(CLIENT_EVENT, { matchId, kind, data } satisfies ClientEvent);
}

/** How old a coin toss may be and still sound: a fresh one, not one a reload or rejoin finds already decided. */
const TOSS_SOUND_FRESH_MS = 15_000;

/** Whether a coin toss sounds now: there is one, the game is still in its pregame, and the toss is fresh. */
export function tossSounds(tossAt: number | null, turn: number, now: number): boolean {
  return tossAt !== null && turn <= 0 && now - tossAt <= TOSS_SOUND_FRESH_MS;
}

/** A list for a telemetry field: the schema's scalars stop at 80 characters, so a long one ends in how many it dropped. */
function listField(items: readonly string[]): string {
  const all = items.join(',');
  if (all.length <= 80) return all;
  let out = '';
  let n = 0;
  for (const item of items) {
    const more = ` +${String(items.length - n)}`;
    if ((out === '' ? item : `${out},${item}`).length + more.length > 80) return `${out}${more}`;
    out = out === '' ? item : `${out},${item}`;
    n += 1;
  }
  return out;
}

/**
 * What the table raised to play, and why, into the match's log: `view` for a
 * board change (the roles, their colour cells, the view's turn and seq),
 * `decision` for a decision window's chime, `press` for a bar button, `toss`
 * for the coin toss. Raised,
 * not heard: the mixer may still drop one (unassigned, collapsed, muted), and
 * `muted` says the last.
 */
function reportSound(match: LiveMatch, why: 'view' | 'decision' | 'press' | 'toss', events: readonly DelayedSoundEvent[], extra: ClientEvent['data'] = {}): void {
  if (events.length === 0) return;
  reportClient(match.transport, match.matchId, 'sound', {
    why,
    roles: listField(events.map((e) => (e.seat === 'opp' ? `${e.role}@opp` : e.role))),
    cells: listField(events.flatMap((e) => (e.colourCell == null ? [] : [e.colourCell]))),
    count: events.length,
    seq: match.view?.seq ?? -1,
    turn: match.view?.turn ?? -1,
    muted: isMuted(),
    ...extra,
  });
}

/** Forge's priority status block with something on the stack: "Priority: … / Turn: … / Phase: … / Stack: N to Resolve." */
const PRIORITY_OVER_STACK = /^Priority: [^\n]*\nTurn: [^\n]*\nPhase: [^\n]*\nStack: \d+ to Resolve\.?$/;

/** Forge's own sentence opening the London mulligan's bottom pick: "Return N card(s) to the bottom of your library." */
const MULLIGAN_BOTTOM_PICK = /^Return \d+ card\(s\) to the bottom of your library\.?$/;

/**
 * What the decision pop-up says. Forge's priority status block is what the
 * log's status line is for; in the pop-up, with its OK meaning "let the stack
 * resolve", it names the top of the stack (the operator, 2026-10-08: never a
 * bare "Resolve?"): a trigger or an ability names its SOURCE ("Resolve
 * Bitterblossom's trigger?"), a spell names itself ("Resolve Keiga, the Tide
 * Star?"). `topStack` is `match.view.stack[0]`; while the view has not caught
 * up with the prompt it is `null` and the question stays bare rather than
 * invent a name. Every other prompt is Forge's own words, made readable.
 */
export function decisionMessage(prompt: string, topStack: StackEntry | null): string {
  if (!PRIORITY_OVER_STACK.test(prompt)) return promptText(prompt);
  if (topStack === null) return 'Resolve?';
  const name = topStack.sourceName ?? 'unknown source';
  return topStack.isAbility ? `Resolve ${name}'s trigger?` : `Resolve ${name}?`;
}

/* ── T2: a calm "waiting for the other player" (wave 36 §L) ───────────── */

/**
 * The OTHER seat's own open ask or payment, as the
 * server reported it (`apps/server/src/play/match.ts`'s `waitingOnFor`,
 * carried onto `LiveMatch.waitingOn` by `match.ts`'s `adoptSeats`) — a FACT.
 *
 * **Made dead, deleted**: the client used to infer "the
 * opponent is doing something" from the negative space of the VIEWER's own
 * three signals — no open ask, no selection, not paying mana, and the bar's
 * `enable1` off (`myMoveNow`, wave 36 §L) — because Forge parks each seat's
 * own thread on its own input and this client never saw the OPPONENT's ask,
 * buttons or prompt directly. That inference is exactly what the flash the
 * operator saw between the mulligan ending and the first real prompt landing
 * was: this client's own signals can clear a beat before the server's
 * `waitingOn` fact for the other seat catches up. The fact replaces the
 * inference outright, so there is no more inference to keep around.
 *
 * `null` before a seat is known, before `forge:seats` has ever landed, or
 * while the other seat has neither.
 */
function theirWaitingOn(match: LiveMatch): { method: string; hostCard: string | null } | null {
  if (match.seat === null || match.waitingOn === null) return null;
  const fact = match.waitingOn.get(match.seat === 0 ? 1 : 0) ?? null;
  if (fact === null || fact.method !== 'priority') return fact;
  // `priority` is the server's word for a seat that merely holds priority (an ordinary "Priority: …"
  // window with a live bar). Over an EMPTY stack that is nothing to wait for — the operator,
  // 2026-10-08: *"'Waiting for Hadoku…' this shouldn't be showing at all times … i wanted this to
  // show when player is resolving an effect not simply when waiting on them."* Over a stack it is
  // exactly that: they are deciding whether to respond to it — the operator, 2026-10-09: *"if i'm
  // waiting on my opponent to respond to 'Resolve Cranial Plating?' then there should at least be
  // some kind of waiting indicator for me"*. The top of the stack (`view.stack[0]`) is what they hold.
  const top = match.view?.stack[0];
  return top === undefined ? null : { method: 'priority', hostCard: top.sourceName ?? null };
}

/**
 * The verb for the T2 banner's sentence ("Waiting for {name} to {verb}…" —
 * Settled). Keyed by the ask's own wire method, plus the synthetic `'pay'`
 * {@link theirWaitingOn} never sends for a real ask (`match.ts`'s own note on
 * why payment and an ask never hold at once). Every other blocking method —
 * an attack assignment, a mana-X slider, a sideboard, an option list — reads
 * as plain "decide": precise enough to be true, not so precise it needs a
 * fifteenth entry.
 */
const WAITING_VERB: Readonly<Record<string, string>> = {
  chooseSingleEntityForEffect: 'choose',
  getChoices: 'choose cards',
  chooseEntitiesForEffect: 'choose cards',
  confirm: 'decide',
  pay: 'pay',
};

/**
 * "Waiting for Hadoku to choose for Thirst for Knowledge…" — Settled's own example; a priority hold
 * over the stack reads "Waiting for Hadoku to respond to Cranial Plating…" (`theirWaitingOn`).
 */
function waitingSentence(name: string, fact: { method: string; hostCard: string | null }): string {
  if (fact.method === 'priority') return fact.hostCard === null ? `Waiting for ${name} to respond…` : `Waiting for ${name} to respond to ${fact.hostCard}…`;
  const verb = WAITING_VERB[fact.method] ?? 'decide';
  return fact.hostCard === null ? `Waiting for ${name} to ${verb}…` : `Waiting for ${name} to ${verb} for ${fact.hostCard}…`;
}

/**
 * The operator: *"the 'Waiting for Hadoku to decide for
 * Serum Visions...' text at the top is a bit easy to miss. can we instead
 * move text like that to the 'decision popout' area? similar to how it shows
 * 'Waiting for {opponent}...' during the mulligan phase? i think that would
 * be cleaner."*
 *
 * One component, one testid, for BOTH uses the old code drew separately: the
 * ordinary mid-game wait (the deleted `live__waiting` top line, out of flow
 * over the board) and the pregame wait (the coin toss, either seat's opening
 * mulligan — W1's own `live-pregame-wait`). Both now draw the exact same
 * `section.confirm[role=status]` shape, in the SAME `.live__prompt` slot every
 * other decision pop-up uses, carrying whatever sentence the caller already
 * computed (`waitingSentence`'s verb table for the mid-game case, or the
 * plain "Waiting for {name}…" pregame has no Forge text to extend). No
 * buttons: there is nothing on this seat's wire to answer with either way.
 *
 * **Made dead, deleted**: the top-line `live__waiting` element and its CSS
 * (`live.css`'s breathing dot); the two testids `live-pregame-wait` and
 * `live-pregame-wait-host` (collapsed into this component's one,
 * `live-waiting-pop`).
 */
function WaitingPop({ sentence }: { sentence: string }) {
  return (
    <div className="live__prompt">
      <section className="confirm" data-testid="live-waiting-pop" role="status" aria-live="polite">
        <p className="confirm__message">{sentence}</p>
      </section>
    </div>
  );
}

/**
 * T2. Operator: a clear, calm indicator whenever the opponent holds priority
 * or is answering a question, gone the instant it is the viewer's move.
 *
 * Driven by {@link theirWaitingOn} — a server-reported
 * FACT — rather than `!myMoveNow(match)`'s inference. The flash the operator
 * saw between the mulligan ending and the first real prompt landing was
 * exactly the gap those two disagree in: this client's own `myMoveNow` goes
 * false (its bar, selection and asks are all momentarily clear) a beat before
 * the other seat's `waitingOn` fact — sent only once Forge actually parks a
 * thread on an ask or a payment — catches up. Gating on the fact alone closes
 * it: there is nothing to say "Waiting for…" about until there is something
 * the other seat is actually doing.
 *
 * `false` with no board (`view === null`) and once the game has ended: both
 * already have their own line (the five-state status line; `GameResultScreen`),
 * and "waiting" would be a second, disagreeing thing to say on the same page.
 * `false` for a spectator too — a watcher is not making a move for either
 * seat to wait on.
 */
export function isWaitingForOpponent(match: LiveMatch): boolean {
  if (isSpectator(match)) return false;
  const view = match.view;
  if (view === null || view.gameOver) return false;
  return theirWaitingOn(match) !== null;
}

/**
 * Whether the other seat holds ANY open window the server reports — a decision OR a plain
 * priority hold. The opponent's priority FLAG reads this, never `isWaitingForOpponent`: the
 * pop-out drops `priority` (it is for decisions), and the flag reading that same filtered fact
 * went dark for every held window after `0670a98` (found by AE16's spec: four windows forwarded
 * to bob, alice's flag for him never lit).
 */
export function opponentHoldsAWindow(match: LiveMatch): boolean {
  if (isSpectator(match) || match.seat === null || match.waitingOn === null) return false;
  const view = match.view;
  if (view === null || view.gameOver) return false;
  return match.waitingOn.has(match.seat === 0 ? 1 : 0);
}

/*
 * Wave 42 §L. Playtest 7, the operator: *"if opponent is choosing to
 * play/draw something needs to be showing on the other persons screen as
 * well. i think the coinflip prompt should be shown to both players at
 * once. and for the one who lost they get the waiting prompt. same for
 * mulligan, if opponent is chosing to mulligan we need some waiting
 * prompt."* `isWaitingForOpponent`'s small line already fires for this —
 * but it fires identically for EVERY "not my move" moment, mid-game
 * priority included, and the operator is asking for the PREGAME half of
 * that — the coin toss and the opening mulligan — to show in the decision
 * area the way the winner's own Play/Draw and Keep/Mulligan pop-ups do, not
 * as the small corner line.
 *
 * `view.turn` is Forge's own counter, and it is read here rather than any
 * prompt text because Forge sends the LOSING seat no wire signal at all for
 * this moment to read instead: `GameAction.determineFirstTurnPlayer`'s own
 * comment — *"show 'Waiting for opponent...' while first player chooses
 * whether to go first or keep their hand"* — calls `awaitNextInput()` on
 * every OTHER seat's controller, but `AbstractGuiGame.awaitNextInput()` is
 * `final` and purely a LOCAL desktop-client timer (it delays a PROMPT LABEL
 * repaint so Swing buttons don't flicker); there is no `ProtocolMethod` for
 * it, `RemoteClientGuiGame` cannot override a `final` method, and it never
 * reaches our bridge's socket at all. So there is no "the opponent is
 * choosing their opening hand" flag to read off the wire — `turn` is the
 * only structural fact that is true for exactly this window: `PhaseHandler`
 * only increments it inside `advanceToNextPhase`'s `turnEnded` branch, which
 * cannot run until `PhaseHandler.startFirstTurn` — called ONLY after both
 * seats' mulligans resolve (`GameAction.startGame`'s own ordering: the coin
 * toss (`determineFirstTurnPlayer`), then `new MulliganService(first).perform()`,
 * THEN `game.setAge(GameStage.Play)` and `startFirstTurn`). Turn is still its
 * initial `0` throughout the coin toss and both mulligans — already the
 * rail's own convention for "pregame" (`whoseTurnNow`'s `match.view.turn > 0
 * ? … : 'Start'`), not a new one invented here.
 */
export function isWaitingForPregameDecision(match: LiveMatch): boolean {
  return isWaitingForOpponent(match) && (match.view?.turn ?? 1) <= 0;
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
    const yes = ask.yesButtonText === '' ? 'Yes' : ask.yesButtonText;
    const no = ask.noButtonText === '' ? 'No' : ask.noButtonText;
    return (
      <ConfirmPrompt
        testId="confirm-dialog"
        role="alertdialog"
        title={ask.title === '' ? 'A question' : ask.title}
        message={ask.message}
        callId={ask.callId}
        button1={{ label: yes, enabled: true, answer: 'yes', isDefault: ask.defaultYes, onClick: () => answerConfirm(match, ask.callId, true) }}
        button2={{ label: no, enabled: true, answer: 'no', isDefault: !ask.defaultYes, onClick: () => answerConfirm(match, ask.callId, false) }}
      />
    );
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
 * How long `AutoAnswer.why` may be before the logged line keeps it beside the
 * card's name rather than in place of it.
 *
 * `why` is Forge's own `SpellAbilityView.toString()` (`tier-b.ts`'s
 * `OfferedAbilitySchema` note: "cost then description"). For an ordinary mana
 * ability that is a few words ("Tap: Add R."); for a MODAL spell it is the
 * whole mode menu ("Choose two — • Prevent all damage… • …"). The cutoff is
 * chosen so the first survives beside the name and the second does not.
 */
const AUTO_ABILITY_LOG_MAX = 40;

/**
 * What `noteAutoAnswered` logs for an auto-answered ask — the host card's
 * NAME, from the prompt lookup, with the ability's own label beside it only
 * when that label is short enough to read as a caption rather than take over
 * the line. Never the ability text alone: a modal spell's `why` is its whole
 * mode text and the card's name is what belongs in a one-line log.
 *
 * `getChoices` (the lone-stack-target auto-answer, `onlyStackTarget` in
 * `rules.ts`) is untouched: its `why` is already a stack item's own label — a
 * spell's name — so there is no ability text to crowd it out.
 */
function autoAnsweredLine(ask: LiveAsk, auto: AutoAnswer, lookup: PromptLookup): string {
  if (ask.method !== 'getAbilityToPlay' || auto.method !== 'getAbilityToPlay') return auto.why;
  const name = lookup.card(ask.hostCard.id)?.name;
  if (name === null || name === undefined || name === '') return auto.why;
  return auto.why.length <= AUTO_ABILITY_LOG_MAX ? `${name} — ${auto.why}` : name;
}

/**
 * How many of the held says the logbook draws: all of them.
 *
 * It was 2 while the log lived in the control cluster, because the cluster's box
 * is fixed and its slot was two lines tall. The logbook has the height, so the
 * cap is `match.ts`'s own `SAYS_KEPT` — a generously bounded whole game, not a
 * two-line window — and nothing is dropped between what the match holds and
 * what the panel shows.
 */
const SAYS_SHOWN = SAYS_KEPT;

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
 * is a `message` notify, and there are five writers of them in the whole repo:
 * `paid …` and `<seat> paid …` (`auto.ts`'s `paymentLine`), `triggered …` and
 * `<seat> triggered …` (`auto.ts`'s `triggerLine`), `full control
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
type LogKind = 'payment' | 'trigger' | 'damage' | 'life' | 'play' | 'control' | 'said';

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
 * The decision pop-up (wave 51) does not draw Forge's second button at all
 * while this is false. The payment window's own cancel button
 * (`live-payment-cancel`) stays in the DOM disabled instead — it has its own
 * fixed sheet, so there is nothing there for a vanishing child to break.
 */
function offersSecondButton(match: LiveMatch): boolean {
  return !declaringAttackers(match);
}



function logKind(line: string): LogKind {
  if (/^full control (on|off)$/.test(line)) return 'control';
  // Ahead of the rest: a trigger's own text may say "damage" or "life", and the line is still the trigger's.
  if (/^(?:.+ )?triggered /.test(line)) return 'trigger';
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
 * Every id on a battlefield, either seat. This is `classifySelection`'s
 * (`../prompts/index.ts`, lane P's) own `boardCardIds` — "every id the board
 * can draw a clickable tile for" — and battlefield is the whole of that set
 * today: a hand or a graveyard pile draws as a pile, not a per-card
 * clickable tile, which is exactly why `setSelectables` naming a graveyard or
 * exile card (W18, Relentless Dead) had no board element to answer it with.
 */
function battlefieldCardIds(view: BoardView | null): ReadonlySet<number> {
  if (view === null) return EMPTY_CARD_IDS;
  const ids = new Set<number>();
  for (const p of view.players) for (const c of p.battlefield) ids.add(c.id);
  return ids;
}

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
function stagedHandCardId(match: LiveMatch, offered: LiveClickables, blocked: boolean): number | undefined {
  if (blocked || !offered.selectionOpen) return undefined;
  const id = match.lastSelectedCard;
  if (id === null) return undefined;
  const viewer = match.view?.players.find((p) => p.isViewer);
  return viewer?.hand?.some((c) => c.id === id) === true ? id : undefined;
}

/** The forge ids of every card of each name in the view — what a log line's name hands the inspector. */
function cardIdsNamedInView(view: BoardView | null): Map<string, number[]> {
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

function cardsNamedInView(view: BoardView | null): Map<string, DraftCard> {
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
function splitLogLine(line: string, cards: ReadonlyMap<string, DraftCard>): (string | DraftCard)[] {
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
function whoseTurn(view: BoardView): 'yours' | 'theirs' | 'nobody' {
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
 * R6: a real gap, not a guess — see `docs/planning/wave35-evidence/l4-flicker.md`
 * for the full derivation. The short version:
 *
 *  - Pressing `End Turn` arms Forge's own `skipPhaseDelay` (`PlayBridge.java`'s
 *    `setPhaseDelayOff`), and `apps/server/src/play/endturn.jvm.test.ts` proves
 *    against a REAL match that the phases from that click to the end step then
 *    arrive **under 50 ms apart** — a crawl, not a sequence a person watches one
 *    step at a time.
 *  - Every turn, crawled or not, passes through the six `combat` steps
 *    (`PHASE_ORDER` above) even with no attackers — so `inCombat` flips
 *    true-then-false on EVERY turn, and `.live__phases[data-combat]` (`live.css`,
 *    wave 26 §B.2 / 33 §L1) changes `--rail-rows` under a `transition: height
 *    0.3s ease` built for a human-paced combat (Q3, wave 32).
 *  - During the crawl, that flip happens several times inside the transition's
 *    own 300 ms window. A CSS transition retargeted mid-flight does not finish
 *    and restart cleanly — it animates toward whatever the LATEST target is —
 *    so a `0.3s` transition re-armed every `<50ms` for the length of the crawl
 *    (anywhere from a few hundred ms to over a second, `endturn.jvm.test.ts`'s
 *    own `upToEnd.length` of phases) renders as the rail visibly JUDDERING open
 *    and shut for that whole span — the flicker. Nothing here remounts (no
 *    `key` on this element or its ancestors depends on the phase or the turn);
 *    it is one real box, animating toward a target that will not hold still.
 *  - The control cluster (`.live__buttons`) was checked too: Forge sends
 *    `updateButtons` only at a real decision point, and the crawl's own proof
 *    (`endturn.jvm.test.ts`) is entirely `applyDelta`/`Phase` traffic with no
 *    button frames inside the crawled span, so the cluster has nothing to
 *    thrash on and is not implicated.
 *
 * The fix stays data-correct and test-stable: `data-combat`, `data-phase`,
 * `data-turn` and the row list are UNCHANGED, still computed straight off
 * `view` with no delay (every existing assertion about them is exact, not
 * eventual). What changes is `data-crawl` (`useCrawlGuard` below) — a
 * recently-retriggered-too-fast flag `live.css` reads to turn the TRANSITION
 * off for exactly the span that would otherwise judder, so a crawl SNAPS
 * through its sizes instead of animating through all of them, and a real,
 * human-paced entry into combat still gets the smooth grow Q3 asked for.
 */
const CRAWL_GAP_MS = 80;
const CRAWL_COOLDOWN_MS = 250;

/**
 * True while `phase` has changed at least twice faster than a person reacts
 * (`CRAWL_GAP_MS` apart), and for a short cooldown after the last fast change —
 * long enough for the rail's own 300 ms transition to have nothing left to
 * finish animating when crawl mode lifts. A single ordinary phase change (the
 * common case, one step at a time) never sets it: the first change after any
 * gap only RECORDS the time, it takes a SECOND change inside the window to
 * call it a crawl.
 */
export function useCrawlGuard(phase: string | null): boolean {
  const [crawling, setCrawling] = useState(false);
  const lastChangeAt = useRef<number | null>(null);
  useEffect(() => {
    const now = performance.now();
    const previous = lastChangeAt.current;
    lastChangeAt.current = now;
    if (previous !== null && now - previous < CRAWL_GAP_MS) {
      setCrawling(true);
      const id = setTimeout(() => setCrawling(false), CRAWL_COOLDOWN_MS);
      return () => clearTimeout(id);
    }
    return undefined;
    // `phase` (not `view`): a prop that changes on every state frame, combat or
    // not, would arm the cooldown for frames that never touch `data-combat` at
    // all (a target or a says-only update), re-arming the timer for no reason
    // this guard cares about.
  }, [phase]);
  return crawling;
}

/**
 * The operator: *"i notice priority flashing back and forth in
 * untap/upkeep/draw... can you unify that behavior."* Measured against a
 * real match (`docs/planning/wave63-evidence/F/flash.md`): the rail, the
 * control bar and End Turn's highlight never move during an auto-passed
 * `UNTAP`/`UPKEEP`/`DRAW`. What moves is `Board.tsx`'s own `.seat__flag`
 * ("priority"), fed by `BoardPlayer.hasPriority` — Forge's raw, per-frame
 * wire fact, which ping-pongs through every auto-passed priority exchange
 * whether or not either seat is actually being asked anything.
 *
 * `view`, with each player's `hasPriority` gated on `open` — true only while
 * that seat genuinely has something to decide. An auto-passed window draws
 * no flag at all; a real one draws exactly Forge's own value. The caller
 * passes `match.ts`'s own `genuinelyAsked(match, seat, …)` (T9) for both
 * arguments, which keeps them mutually exclusive, so at most one flag is ever
 * lit. `view` itself, unchanged, when nothing needs correcting.
 */
export function withGatedPriority(view: BoardView, viewerOpen: boolean, opponentOpen: boolean): BoardView {
  let changed = false;
  const players = view.players.map((p) => {
    // The viewer's own flag is Forge's own fact, gated. The OPPONENT's flag is
    // the server's "waiting for them" fact alone (AE16): that fact rides the
    // seats channel, which the pacer never holds, while `p.hasPriority` is a
    // state delta that sits in the paced queue behind an End Turn crawl's
    // phase frames — measured ~4.8 s late once per match, the pop-out's fact
    // already lit and the flag still dark. Both read one server fact now.
    const want = p.isViewer ? viewerOpen && p.hasPriority : opponentOpen;
    if (p.hasPriority === want) return p;
    changed = true;
    return { ...p, hasPriority: want };
  });
  return changed ? { ...view, players } : view;
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
 * **Wave 35 R11 moved the visible turn counter off this rail and into the
 * logbook** (the operator's "the log has it"): `live-turn` / `live-turn-n` are
 * drawn there now, by `LiveBoard` itself, not by this component. `data-turn`
 * and `data-whose` stay on THIS element regardless, because `e2e/w32.spec.ts`
 * and `e2e/w33.spec.ts` read them off the rail by `data-testid="live-phases"`
 * and a hidden logbook must not make either attribute unreadable.
 *
 * **Wave 35 R6**: `data-crawl` turns the resize transition off while the phase
 * is changing faster than a person could watch it (see `useCrawlGuard` above).
 */
function PhaseRail({ view }: { view: BoardView }) {
  const at = PHASE_ORDER.findIndex((p) => p.phase === view.phase);
  const whose = whoseTurn(view);
  const inCombat = at >= 0 && PHASE_ORDER[at]!.group === 'combat';
  const rows = railRows(inCombat);
  const crawling = useCrawlGuard(view.phase);
  return (
    <div
      className="live__phases"
      data-testid="live-phases"
      data-whose={whose}
      data-phase={view.phase ?? ''}
      data-turn={view.turn}
      data-combat={inCombat ? '' : undefined}
      data-crawl={crawling ? '' : undefined}
    >
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
 * The pop-up's OK while the seat declares attackers or blockers says what pressing it does —
 * Forge's own label there is a bare "OK", which read as unclear in play.
 */
function combatDoneLabel(match: LiveMatch): string | null {
  if (declaringAttackers(match)) return 'Done Attacking';
  if (declaringBlockers(match)) return 'Done Blocking';
  return null;
}

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
 * The buttons send through `pressButton`, the one sender for Forge's two
 * buttons, and it refuses a bar Forge has disabled whichever button was pressed. Button one is the default only while Forge has ENABLED it:
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
  const bar = liveBar(match);
  return (
    <div className="live__prompt" data-testid="live-payment-host">
      <section className="confirm live__payment" data-testid="live-payment" role="dialog" aria-labelledby={messageId}>
        <p className="confirm__message" id={messageId}>
          <RulesText text={match.prompt ?? ''} />
        </p>
        <div className="confirm__actions">
          <button
            type="button"
            className="button confirm__button"
            data-testid="live-payment-ok"
            data-default={bar !== null && bar.enable1 ? '' : undefined}
            disabled={bar === null || !bar.enable1}
            onClick={() => pressWithSound(match, 'ok')}
          >
            {bar === null || bar.label1 === '' ? 'OK' : bar.label1}
          </button>
          <button
            type="button"
            className="button confirm__button"
            data-testid="live-payment-cancel"
            disabled={bar === null || !bar.enable2 || !offersSecondButton(match)}
            onClick={() => pressWithSound(match, 'cancel')}
          >
            {bar === null || bar.label2 === '' ? 'Cancel' : bar.label2}
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

/* ── R16: a result screen, not a toast ──────────────────────────────────
 *
 * Today's whole answer to "the game ended" was `Board`'s one-line `game over`
 * banner (`.board__over`). The operator asked for a real screen: who won, how,
 * both players' names and faces, and a way onward — `docs/planning/wave35-2026-10-02.md`'s
 * R16, with the Rematch/Main-menu ruling settled 2026-10-02.
 *
 * Lane B (shape 4) deleted the banner and its `.board__over` rule; that class
 * name is this component's now, kept on purpose because five e2e checks read
 * it as "the game has ended" (`play.spec.ts`, `table-fit.spec.ts`,
 * `w31.spec.ts`) and a renamed class would silently stop meaning that to them.
 *
 * ## Victory, Defeat or Draw — from the viewer's OWN board
 *
 * `BoardPlayer.hasLost` is already on the wire for both seats (adapter.ts), so
 * this needs no new field: the viewer lost and the opponent did not → Defeat;
 * the opponent lost and the viewer did not → Victory; both or neither → Draw
 * (the operator's own three-way split). A spectator reads the SEAT they are
 * watching, same as everywhere else in this file.
 *
 * ## How it ended — read off the board, not asked of Forge
 *
 * Nothing on today's wire tells a browser WHY a player lost — `winner` is a
 * name on a REST poll (`apps/server/src/play/socket.ts`'s `/matches/:id`), not
 * a reason, and reaches neither this file nor `match.ts`; `GameEventGameOutcome`
 * (`packages/forge-wire`'s `outcomeStrings`) is modelled but never leaves the
 * bridge (`PlayBridge.java` sends `"events": []` on every delta — see this
 * file's own header on why). Magic has exactly four ways a player loses, and
 * three of them are already visible facts on the SAME `BoardPlayer` `hasLost`
 * comes from: life at or below zero, ten-plus poison counters, and an empty
 * library (the "drawn from nothing" shape — Forge marks the loss the moment a
 * draw fails, so a decked player's library reads 0 here). A loser with none of
 * those is the fourth way: conceding changes nothing else about their board,
 * so it is the one case left once the other three are ruled out — not a
 * guess, a complete partition of the four causes this wave scopes to.
 */
export type GameOutcome = 'victory' | 'defeat' | 'draw';

/** Victory/Defeat/Draw, from the viewer's own side. `null` while the game is not over. */
export function gameOutcome(match: LiveMatch): GameOutcome | null {
  const view = match.view;
  // Forge's `finishGame()` (`match.finished`) is the certain signal; the view's
  // `GameOver` is the same fact when its delta happens to arrive (see
  // `LiveMatch.finished`). Either one ends the game here.
  if (view === null || !(view.gameOver || match.finished)) return null;
  const viewerLost = view.players.find((p) => p.isViewer)?.hasLost ?? false;
  const opponentLost = view.players.find((p) => !p.isViewer)?.hasLost ?? false;
  if (viewerLost === opponentLost) return 'draw';
  return viewerLost ? 'defeat' : 'victory';
}

/** The four ways a Magic game modelled here ends. See the section header for the derivation. */
export type GameEndReason = 'life' | 'poison' | 'decking' | 'concede';

const END_REASON_WORDS: Readonly<Record<GameEndReason, string>> = {
  life: 'life total reached 0',
  poison: '10 or more poison counters',
  decking: 'an empty library',
  concede: 'conceding',
};

/** Why THIS player lost, read off facts already on their `BoardPlayer`. Exported for its own test. */
export function reasonLost(player: BoardPlayer): GameEndReason {
  if (player.life <= 0) return 'life';
  const poison = (player.counters ?? []).find((c) => c.name === 'Poison');
  if (poison !== undefined && poison.count >= 10) return 'poison';
  if (player.libraryCount === 0) return 'decking';
  return 'concede';
}

/** One sentence per loser (almost always one; a double-loss draw gets both). `null` when nobody lost. */
export function endingSentence(view: BoardView): string | null {
  const losers = view.players.filter((p) => p.hasLost);
  if (losers.length === 0) return null;
  return losers.map((p) => `${p.name} — ${END_REASON_WORDS[reasonLost(p)]}`).join(' · ');
}

const OUTCOME_TITLE: Readonly<Record<GameOutcome, string>> = {
  victory: 'Victory',
  defeat: 'Defeat',
  draw: 'Draw',
};

/**
 * A player's face, for the result screen. Not `Board.tsx`'s `PlayerFace`
 * (unexported, and drawn for a different job — a clickable target with a life
 * badge): this reuses only the FACT lane A's own face draws from —
 * `avatarSquareUrl(player.avatarId)`, the one accessor, no new image host —
 * and draws its own, smaller mark so this file's styling stays in `live.css`
 * and does not lean on `board.css`'s private class names.
 *
 * `rematch`: this player has pressed Rematch — a check over their face.
 */
function ResultFace({ player, rematch }: { player: BoardPlayer; rematch: boolean }) {
  const avatar = player.avatarId === undefined ? null : avatarSquareUrl(player.avatarId);
  return (
    <div className="live__result-face" data-testid="game-result-face" data-you={player.isViewer} data-lost={player.hasLost || undefined}>
      <span className="live__result-portrait">
        {avatar === null ? (
          <svg className="live__result-avatar" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
            <circle cx="24" cy="19" r="10" />
            <path d="M8 42a16 16 0 0 1 32 0Z" />
          </svg>
        ) : (
          <img className="live__result-avatar" src={avatar} alt="" />
        )}
        {rematch && (
          <svg className="live__result-check" data-testid="game-result-check" viewBox="0 0 24 24" role="img" aria-label="Rematch">
            <circle cx="12" cy="12" r="11" />
            <path d="M6.5 12.5l3.5 3.5 7.5-7.5" />
          </svg>
        )}
      </span>
      <span className="live__result-name">{player.name}</span>
    </div>
  );
}

/** Who has pressed Rematch, and what pressing it can do now. */
export interface Rematch {
  /** I have pressed it. */
  mine: boolean;
  /** The other player has pressed it. */
  theirs: boolean;
  /** The other player is waiting on me: my button is highlighted. */
  highlight: boolean;
  /**
   * There is someone to rematch: a player still at the table, or the bot in a
   * game played alone. False until the table answers, and once the other
   * player has left.
   */
  possible: boolean;
  /** Both have pressed: the new match is to be asked for. */
  agreed: boolean;
}

/**
 * Read off the room's table. A Rematch press is the table's own Ready
 * (`POST …/ready`), so this is the same fact the room screen starts a match on.
 * `alone` is latched from the table's first answer: a game against the bot has
 * one player at the table from the start, a human game two until one leaves.
 */
export function rematchOf(table: RoomTable | null, alone: boolean): Rematch {
  const me = table?.players.find((p) => p.you);
  const other = table?.players.find((p) => !p.you);
  const mine = me?.ready === true;
  const theirs = other?.ready === true;
  return {
    mine,
    theirs,
    highlight: theirs && !mine,
    possible: me !== undefined && (alone || other !== undefined),
    agreed: mine && theirs,
  };
}

/**
 * The result screen itself (shape 4 + shape 5): drawn over the board — which
 * stays visible behind it, per the brief — when `view.gameOver`.
 *
 * **Rematch** is an agreement, not a jump (the operator, 2026-10-10: *"only
 * when both players have rematch clicked should it launch into a new game"*).
 * Pressing it readies you at the room's table — the same Ready the room screen
 * starts a match on, with the decks both players still hold there — and
 * pressing it again stands you down. This screen reads the table whenever the
 * room changes (`rooms/feed.ts`), draws a check over each face whose player is
 * ready, and highlights the button of the
 * player the other is waiting on. Once both are ready either screen asks for
 * the match (`startRoom`; the server answers one match to both), and a screen
 * that did not ask follows the room's new `matchId`. In a game played alone
 * against the bot there is nobody to wait for, so Rematch starts the next bot
 * game at once.
 *
 * **Main menu** leaves the room (`roomsClient().leave`, lane R shape 5) and
 * THEN goes to the lobby — in that order, `finally`, so a leave that fails
 * still lands the player somewhere rather than stranding them on a result
 * screen for a room that may already be gone. Leaving takes your seat at the
 * table with you, so the other screen's next read loses your check and its
 * highlight, and its Rematch has nobody left to agree with.
 *
 * Without a known room (`roomId === null` — a `#/match/<id>` link from
 * elsewhere, a match no room started, or a server that could not be reached;
 * see `MatchScreen.tsx`'s own comment on the same fact), there is no table to
 * ready at: Rematch is
 * disabled and Main menu goes straight to the lobby.
 */
function GameResultScreen({ match, roomId }: { match: LiveMatch; roomId: string | null }) {
  const view = match.view!;
  const outcome = gameOutcome(match)!;
  const viewer = view.players.find((p) => p.isViewer);
  const opponent = view.players.find((p) => !p.isViewer);
  const ending = endingSentence(view);
  const titleId = useId();
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [table, setTable] = useState<RoomTable | null>(null);
  const [alone, setAlone] = useState<boolean | null>(null);
  const [tables] = useState(tablesClient);
  /** A start is in flight: not asked again on every read. */
  const asked = useRef(false);
  const rematch = rematchOf(table, alone === true);

  useEffect(() => {
    if (roomId === null) return;
    let live = true;
    const stopFollowing = roomFeed().follow({ room: roomId }, () => {
      tables.table(roomId).then(
        (answer) => {
          if (!live || !answer.ok) return;
          setTable(answer.table);
          setAlone((was) => was ?? answer.table.players.length === 1);
        },
        // Unreachable for a moment: the last answer stays on screen and the next read asks again.
        () => undefined,
      );
    });
    return () => {
      live = false;
      stopFollowing();
    };
  }, [roomId, tables]);

  // The room's next match, whichever screen asked for it.
  const next = table?.room.matchId ?? null;
  useEffect(() => {
    if (next !== null && next !== match.matchId) navigate({ kind: 'match', matchId: next });
  }, [next, match.matchId]);

  const refused = (error: string): void => {
    asked.current = false;
    setBusy(false);
    setRefusal(error);
  };
  const started = (answer: StartOutcome): void => {
    if (answer.ok) navigate({ kind: 'match', matchId: answer.matchId });
    else refused(answer.error);
  };
  const unreachable = (err: unknown): void => refused(err instanceof Error ? err.message : String(err));

  useEffect(() => {
    if (!rematch.agreed || roomId === null || asked.current) return;
    asked.current = true;
    tables.startRoom(roomId).then(started, unreachable);
  }, [rematch.agreed, roomId, tables]);

  const onRematch = (): void => {
    if (roomId === null) return;
    setRefusal(null);
    setBusy(true);
    if (alone === true) {
      asked.current = true;
      tables.startVsBot(roomId).then(started, unreachable);
      return;
    }
    tables.ready(roomId, !rematch.mine).then((answer) => {
      setBusy(false);
      if (answer.ok) setTable(answer.table);
      else setRefusal(answer.error);
    }, unreachable);
  };

  const onMainMenu = (): void => {
    setLeaving(true);
    const left: Promise<unknown> = roomId === null ? Promise.resolve() : roomsClient().leave(roomId);
    void left.finally(() => navigate({ kind: 'lobby' }));
  };

  return (
    <section className="board__over" data-testid="game-result" data-result={outcome} role="dialog" aria-labelledby={titleId}>
      <div className="confirm live__result">
        <h2 className="confirm__title" id={titleId}>
          {OUTCOME_TITLE[outcome]}
        </h2>
        {ending !== null && <p className="confirm__message live__result-ending">{ending}</p>}
        <div className="live__result-faces">
          {viewer !== undefined && <ResultFace player={viewer} rematch={rematch.mine} />}
          {opponent !== undefined && <ResultFace player={opponent} rematch={rematch.theirs} />}
        </div>
        {refusal !== null && (
          <p className="live__error" role="alert">
            {refusal}
          </p>
        )}
        <div className="confirm__actions">
          <button
            type="button"
            className="button"
            data-testid="game-result-rematch"
            aria-pressed={rematch.mine}
            data-highlight={rematch.highlight ? 'true' : undefined}
            disabled={!rematch.possible || busy || leaving}
            onClick={onRematch}
          >
            Rematch
          </button>
          <button type="button" className="button" data-testid="game-result-menu" disabled={leaving} onClick={onMainMenu}>
            Main menu
          </button>
        </div>
      </div>
    </section>
  );
}

export interface LiveBoardProps {
  match: LiveMatch;
  /**
   * The room this match was started from, when the route knows it — the one way
   * back a gone match offers. Absent: the lobby. (A `#/match/<id>` route carries
   * no room, so `MatchScreen` passes one only when it has one.)
   */
  roomId?: string | null;
}

/**
 * `bar-stuck` (`./bar-hold.ts`): reported once the screen has offered nothing to press under a
 * live server bar for `BAR_STUCK_MS`, and again when that ends, each with what held it.
 */
function useBarStuckReport(match: LiveMatch, stuck: boolean, detail: () => ClientEvent['data']): void {
  const detailRef = useRef(detail);
  detailRef.current = detail;
  useEffect(() => {
    if (!stuck) return undefined;
    const from = Date.now();
    let reported = false;
    const timer = setTimeout(() => {
      reported = true;
      reportClient(match.transport, match.matchId, 'bar-stuck', { phase: 'held', ms: Date.now() - from, ...detailRef.current() });
    }, BAR_STUCK_MS);
    return () => {
      clearTimeout(timer);
      if (reported) reportClient(match.transport, match.matchId, 'bar-stuck', { phase: 'cleared', ms: Date.now() - from, ...detailRef.current() });
    };
  }, [stuck, match]);
}

/** A control-bar press, with its sound. `pressButton` refuses a disabled button; then nothing plays. */
function pressWithSound(match: LiveMatch, which: 'ok' | 'cancel'): boolean {
  const pressed = pressButton(match, which);
  if (pressed) {
    playRole('ui.pass');
    reportSound(match, 'press', [{ role: 'ui.pass' }], { button: which });
  }
  return pressed;
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
   * The table's sound: every view the pacer releases is diffed against the one
   * before it (`./sound-events.ts`), so a sound starts with the change on screen.
   * A watching window stays silent: the seat's own window is already playing it.
   */
  useEffect(() => {
    setMatchMusic(true);
    return () => setMatchMusic(false);
  }, []);
  const soundView = match.view;
  const lastSoundView = useRef<BoardView | null>(null);
  useEffect(() => {
    if (soundView === null) return;
    const prev = lastSoundView.current;
    lastSoundView.current = soundView;
    if (spectator) return;
    try {
      const events = deriveSoundEvents(prev, soundView);
      playSoundEvents(events);
      reportSound(match, 'view', events, { prevSeq: prev?.seq ?? -1 });
    } catch (err) {
      // Sound must never take the board down; say so in the console instead.
      console.error('[cardtable] sound events for this view failed', err);
    }
  }, [soundView, spectator, match]);
  /*
   * One answer is no question (§B, items 4 and 9). `rules.ts`'s `autoAnswer`
   * is the only place that decides it; here it is sent, and the prompt that
   * would have asked is never drawn. Full control turns it off, and then the
   * picker comes back for one ability as it does for two.
   */
  const auto = pending === null || match.fullControl || spectator ? null : autoAnswer(pending);
  const autoCallId = auto === null || pending === null ? null : pending.callId;
  useEffect(() => {
    if (autoCallId === null || auto === null || pending === null) return;
    // `answerAsk` refuses a callId that is no longer open, so a re-render
    // between the reply and the frame that closes it cannot answer twice.
    if (answerAsk(match, autoCallId, auto.method, auto.reply)) {
      noteAutoAnswered(match, autoAnsweredLine(pending, auto, lookupFromState(match.state)));
    }
  }, [match, autoCallId, auto, pending]);
  /* Nothing renders for an ask that answers itself — not even for a frame. */
  const ask = auto === null && !spectator ? pending : null;
  const bar = liveBar(match);
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
   * R2: the coin toss / play-draw question. Not an `ask` — Forge resolves the
   * toss itself and asks only the winner one question through the same
   * notify-only `prompt`/`buttons` channel every other yes/no in the control
   * bar already uses (`PlayerControllerHuman.chooseStartingPlayer`).
   * `isPlayOrDrawPrompt` (`../prompts/ConfirmPrompt.tsx`, presentational
   * only) reads it off `bar` alone, the same field `barRoute` reads.
   */
  const playOrDraw = !spectator && !askOpen && isPlayOrDrawPrompt(bar);
  /*
   * The coin toss on both screens (AE17 — `CoinToss.tsx`): the server's fact,
   * resolved to the winner's face and name by the roster the same `forge:seats`
   * message carried. Drawn beside the winner's own Play/Draw question, and on
   * the loser's screen INSTEAD of "Waiting for {name}…" for this one moment.
   */
  const coinToss = ((): { winner: number; name: string; avatarId: string | undefined; loserAvatarId: string | undefined; at: number } | null => {
    const toss = match.coinToss;
    if (toss === null) return null;
    const pid = toss.playerId;
    const player = pid === null ? undefined : match.view?.players.find((p) => p.id === pid);
    const name = (pid === null ? undefined : match.nameByPlayerId?.get(pid)) ?? player?.name ?? `Seat ${toss.winner + 1}`;
    const avatarId = (pid === null ? undefined : match.avatarByPlayerId?.get(pid)) ?? player?.avatarId;
    // The coin's other face: the seat that lost, so a flip shows both players.
    const loser = pid === null ? undefined : match.view?.players.find((p) => p.id !== pid);
    const loserAvatarId = loser === undefined ? undefined : (match.avatarByPlayerId?.get(loser.id) ?? loser.avatarId);
    return { winner: toss.winner, name, avatarId, loserAvatarId, at: toss.at };
  })();
  /*
   * The coin toss sounds `g.game-start` on both screens as the coin appears (the
   * operator, 2026-10-10: "did we lose the coin flip sound?" — nothing had ever
   * raised it; the chime they heard was the decision's). Only in the pregame and
   * only for a fresh toss, so a reload or a rejoin mid-game does not replay it.
   */
  const tossAt = coinToss?.at ?? null;
  // The winner's Play/Draw question waits for the coin to land (the operator, 2026-10-11:
  // "can we make it so the cointoss finishes before showing the prompt of who goes first?").
  const coinFlipping = useCoinFlipping(tossAt);
  const tossTurn = match.view?.turn ?? 0;
  useEffect(() => {
    if (spectator || !tossSounds(tossAt, tossTurn, Date.now())) return;
    playRole('g.game-start');
    reportSound(match, 'toss', [{ role: 'g.game-start' }]);
    // Once per toss: the turn moving on later must not sound it again.
  }, [tossAt]);
  /*
   * T4 (shape 1, lane G): every Forge yes/no that is an ANSWER rather than a
   * priority pass — the shockland's "pay 2 life?", the mulligan's
   * Keep/Mulligan, a scry's Top/Bottom, any other `InputConfirm` text — moves
   * to the decision area the same way R2 already moved the coin toss.
   * `isConfirmPrompt` (`../prompts/ConfirmPrompt.tsx`, G's, presentational
   * only) already excludes the coin toss by construction, so checking both
   * here is belt-and-suspenders, not a real race: the two can never both be
   * true for the same bar.
   */
  const confirmPrompt = !spectator && !askOpen && !playOrDraw && isConfirmPrompt(bar);
  /* "Your move": a decision window opened for this seat — an ask, or a yes/no in the decision area. */
  const decisionKey = ask !== null ? `ask:${ask.callId}` : confirmPrompt || playOrDraw ? `bar:${bar?.label1 ?? ''}` : null;
  useEffect(() => {
    if (decisionKey === null) return;
    playRole('ui.prompt');
    reportSound(match, 'decision', [{ role: 'ui.prompt' }], { key: decisionKey.slice(0, 80) });
  }, [decisionKey, match]);
  /* An optional trigger's "Always" box: ticked, the Yes or No pressed is the answer Forge keeps giving. Unticked for each new confirm. */
  const [always, setAlways] = useState(false);
  useEffect(() => {
    if (!confirmPrompt) setAlways(false);
  }, [confirmPrompt]);
  /* "Same target for all" on a trigger's target question while identical ones wait behind it (the operator, 2026-10-11). */
  const sameTargetCheck =
    !spectator && match.promptTargetMore > 0 && match.inputLive
      ? { label: 'Same target for all', testId: 'live-same-target', checked: match.sameTarget, onChange: (on: boolean) => setSameTarget(match, on) }
      : undefined;
  // The decision goes BEFORE the press, so the server still holds this confirm as the seat's prompt when it checks the key.
  const answerTrigger = (which: 'ok' | 'cancel') => {
    const live = bar !== null && (which === 'ok' ? bar.enable1 : bar.enable2);
    if (live && always && match.promptTrigger !== null) setTriggerDecision(match, match.promptTrigger.key, which === 'ok' ? 'ACCEPT' : 'DECLINE');
    setAlways(false);
    pressWithSound(match, which);
  };
  /*
   * W18/W16: a Forge SELECTION (`setSelectables`) that needs more than the
   * board's own highlighted ring — the soft-lock (an off-board target, no
   * board element to click) and Worldbreaker's own on-board choice
   * (previously silent: no titled prompt text anywhere). `classifySelection`
   * (`../prompts/index.ts`, lane P's) is the whole classifier; see
   * `docs/planning/wave42-evidence/P-contract.md`. Sanctum of Ugin's own
   * "may sacrifice yourself" is NOT this: measured (lane P) to be an
   * ordinary bar confirm, already handled by `confirmPrompt` above — there
   * is no `'confirm'` selection shape to mount here.
   */
  const selectionKind: SelectionKind = !spectator && !askOpen ? classifySelection(match.selectables, battlefieldCardIds(match.view)) : 'none';
  const selectionPopup = selectionKind === 'off-board' || selectionKind === 'on-board';
  /** T2: gone the instant it is the viewer's move — see `isWaitingForOpponent`'s own note. */
  const waitingForOpponent = isWaitingForOpponent(match);
  /** The fact the T2 banner's sentence is built from — present whenever `waitingForOpponent` is. */
  const theirAsk = theirWaitingOn(match);
  /*
   * W1: the PREGAME half of "waiting for opponent" — the coin toss and
   * either seat's opening mulligan — gets the decision-area pop-up below
   * instead of the small corner line; see `isWaitingForPregameDecision`'s
   * own note for why `view.turn` is the signal. The small line (below) is
   * for the ordinary mid-game case only, so the two are drawn as an
   * if/else of each other, never both at once.
   */
  const pregameWait = isWaitingForPregameDecision(match);
  /*
   * Wave 51: what Forge's bar is, now that the control box only ever draws
   * `Next Phase` and `End Turn` for it (`barRoute`'s own note). Every pop-up
   * above keeps the input it already owned; whatever is left with an enabled
   * button is the decision pop-up, in the same slot.
   */
  const route = spectator
    ? 'none'
    : barRoute(bar, (match.view?.stack.length ?? 0) === 0, askOpen || paying || selectionPopup || pregameWait);
  // The bottom pick (Z2): Forge's own instruction ("Return N card(s) to the bottom of your library") in the
  // decision pop-up, its OK as Forge enables it — off until a card is set aside, on after.
  const mulliganPick = !spectator && bar !== null && choosingMulligan(match) && !isConfirmPrompt(bar);
  /** The one sentence held for the whole bottom pick — see the note below. */
  const mulliganPickText = useRef<string | null>(null);
  /*
   * Forge sends a fresh "Return N card(s)…" sentence after every card set
   * aside or taken back, counting down as the pick narrows ("Return 1…" then "Return 0…"); drawing
   * each one as it arrived read as the pop-up asking a new question each time. The FIRST sentence
   * already says the count to return, so it is held for the whole pick and let go the moment the
   * pick ends (`mulliganPick` turns false).
   *
   * Latched against the sentence itself, not merely against `mulliganPick` turning true: Forge's
   * own `Mulligan` flag can land one frame ahead of this pick's own `showPromptMessage` (the delta
   * and the prompt are two separate frames), so the render in between still carries the PREVIOUS
   * question's text (the Keep/Mulligan confirm) while `mulliganPick` is already true. Holding that
   * one would lock the pop-up onto the wrong sentence for the whole pick.
   */
  if (mulliganPick) {
    const text = decisionMessage(match.prompt ?? '', match.view?.stack[0] ?? null);
    if (mulliganPickText.current === null && MULLIGAN_BOTTOM_PICK.test(text)) mulliganPickText.current = text;
  } else {
    mulliganPickText.current = null;
  }
  // After End Turn, Forge yields the rest of the turn and offers to cancel the yield ("Yielding until
  // end of turn. You may cancel this…", `lblYieldingUntil*`). The operator, 2026-10-07: "i dont need a way to
  // cancel my 'end turn' decision. if i click end turn i'm locked in" — no pop-up for it.
  const yielding = YIELDING.test(match.prompt ?? '');
  const decisionOk = !yielding && ((route === 'decision' && bar !== null && bar.enable1) || mulliganPick);
  // No second button during the bottom pick (the operator: "remove the 'auto' button") — Forge's own `Auto`
  // would otherwise draw beside OK the same way it does for every other decision-area bar.
  const decisionCancel = !yielding && route === 'decision' && bar !== null && bar.enable2 && !offersEndTurn(bar) && offersSecondButton(match) && !mulliganPick;
  const decision = decisionOk || decisionCancel;
  /**
   * Measured (`e2e/w62-condescend.spec.ts`, two real
   * browsers): the server sequences bob's own payment window and alice's
   * scry ask strictly — Forge never computes the second until the first is
   * resolved (`w62-condescend.jvm.test.ts`'s own proof) — but a STALE
   * `theirWaitingOn` fact can still outlive the frame that clears it on
   * THIS seat's own wire, long enough for a render to show both: the
   * caster's own new ask drawn, the pop-out STILL naming the seat whose
   * business that ask is now the resolution of. It is never coherent to
   * tell the viewer to wait for the other seat while this seat has its own
   * live decision open — whichever one the wire's timing drew first, this
   * seat's own is never the stale one. `pregameWait` is not in this list on
   * purpose: it is a DEGENERATE CASE of `waitingForOpponent` itself (every
   * pregame wait implies it), not a competing decision of the viewer's own.
   */
  const myOwnDecisionOpen = askOpen || paying || playOrDraw || confirmPrompt || selectionPopup || decision;
  /*
   * `genuinelyAsked` (`./match.ts`, T9) is now the one place that combines
   * `myOwnDecisionOpen` with the one case it does not cover — a bare "your
   * move, nothing on the stack" pass, Forge's bar simply live with no pop-up
   * over it — and, for the other seat, with `waitingForOpponent` (never both
   * at once: see that flag's own note on staleness). `withGatedPriority`
   * itself is unchanged; this replaces what used to be the inline formula
   * beside its call ("F's seam filter").
   */
  const asked = { ownDecisionOpen: myOwnDecisionOpen, waitingForOpponent: opponentHoldsAWindow(match) };
  const viewerOpen = genuinelyAsked(match, 'you', asked);
  const opponentOpen = genuinelyAsked(match, 'them', asked);
  /* Someone must act with the stack as it is: an ability on it is drawn as its chip (`placed.ts`). */
  const chainHalted = viewerOpen || opponentOpen;
  useEffect(() => setChainHalted(chainHalted), [chainHalted]);
  useEffect(() => () => setChainHalted(null), []);
  const visualView = match.view === null ? null : withGatedPriority(match.view, viewerOpen, opponentOpen);
  /*
   * What the log can put a face to, and whose lines are whose. Both come off the
   * board view the viewer is already looking at — see `cardsNamedInView` for why
   * that is the leak-free source — and both are `null`/empty before the first
   * state frame, which draws the log as plain text.
   */
  const logCards = cardsNamedInView(match.view);
  const logIds = cardIdsNamedInView(match.view);
  const theirName = match.view?.players.find((p) => !p.isViewer)?.name ?? null;
  /** R11: the turn counter moved off the rail and into the logbook. */
  const whoseTurnNow = match.view === null ? 'nobody' : whoseTurn(match.view);
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
     * 13). The fifteen prompts, the payment window, the coin toss, the yes/no
     * pop-up, a selection's own decision-area treatment (W18/W16,
     * `selectionPopup`), the pregame waiting pop-up (W1, `pregameWait`) and
     * the bar's own decision (wave 51, `decision`) all draw in the same column. This is the same set, named once, so the
     * stack cannot disagree with what is actually on screen.
     */
    // A spell on the stack hangs the band from the decision edge too, so it is already there when the pop-up opens.
    questionOpen: askOpen || paying || playOrDraw || confirmPrompt || selectionPopup || pregameWait || decision || (match.view?.stack.length ?? 0) > 0,
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
    refused: match.refused ?? undefined,
    /*
     * The operator, Playtest 10: *"hard to tell when i have a card selected
     * because the background for all cards is green."* Forge's own
     * `setHighlighted` arrives as `match.highlighted` (`./match.ts`) and
     * already rides inside `offered.selectable` (`boardInteraction`'s own
     * fold) — handed over SEPARATELY here too so `Board` can draw a picked
     * card as picked rather than merely offered, the same way
     * `declaringAttackers` is handed over beside `offered` above rather than
     * inferred from it.
     */
    highlighted: pickedOf(match),
    blockFocus: blockFocusOf(match) ?? undefined,
    combatReady: spectator ? undefined : combatCandidates(match),
    /*
     * Item 17.2's staging area: the hand card this seat clicked to cast,
     * while Forge is asking for its target and nothing else is on top of the
     * board (`stagedCardId`'s own note on why an ask or a payment wins the
     * same footprint). `boardCardById` is the one lookup, exported below for
     * its own test. The bar's decision does not block it: while a target is
     * being chosen that pop-up is Forge's `Cancel`, and it draws under the
     * staged card (`data-staged` on its host).
     */
    stagedCardId: stagedHandCardId(match, offered, askOpen || paying || playOrDraw || confirmPrompt || selectionPopup || pregameWait),
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
   * The log closes the way a menu does (the operator, 2026-10-07: "clicking
   * outside of the log should close the log, also clicking ESC could close
   * the log"): a press anywhere outside the panel and its own toggle, or
   * Escape. Capture phase, so the press still goes on to whatever it was
   * on; and Escape is not consumed, so a prompt or a cast that also wants it
   * still gets it (`inspect/index.ts` makes the same call).
   */
  useEffect(() => {
    if (!logOpen) return undefined;
    const outside = (event: PointerEvent): void => {
      const target = eventTarget(event);
      if (!(target instanceof Element)) return;
      if (target.closest(`#${CSS.escape(logbookId)}, [data-testid="live-log-toggle"]`) !== null) return;
      setLogOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLogOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [logOpen, logbookId]);
  /*
   * The logbook is scrollable and keeps the newest line in view. `.live__log`
   * (`live.css`) is the scroll owner — a bounded flex child with
   * `overflow-y: auto`, since its content can outgrow the box — and this is
   * what puts the bottom of it in view whenever the panel opens or a new line
   * lands while it is already open. A closed panel is `hidden` and not
   * rendered, so there is nothing to scroll for it.
   */
  const logListRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!logOpen) return;
    const el = logListRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [logOpen, match.says.length]);

  /*
   * Board layout (item 11): a PROP of `Board`, `single` by default, read from
   * the persisted preference below once it loads. Lives here, not inside
   * `SettingsPanel`, because `<Board>` needs it whether or not Settings is
   * ever opened.
   */
  /*
   * Wave 51: the control box's two game buttons are always drawn, and are
   * enabled only for the one input each is for. `Next Phase` is Forge's button
   * one at the empty-stack priority pass (`barRoute`); `End Turn` is Forge's
   * button two while Forge names it `End Turn` (`InputPassPriority`'s cancel
   * slot, `offersEndTurn`).
   */
  const nextPhaseEnabled = route === 'next-phase';
  const endTurnEnabled = !spectator && !askOpen && offersEndTurn(bar);
  /*
   * R5: End Turn is highlighted when there is nothing left to decide.
   * `nothingToDecide` (`./match.ts`, shape 3) is the one place "nothing left to
   * decide" is answered — no open ask, no open selection, and Forge's own
   * actionable set is the explicit empty one — so the highlight lands on the
   * button that reads `End Turn`, gated on it being pressable at all.
   */
  const highlightEndTurn = endTurnEnabled && nothingToDecide(match);
  const stuck =
    !spectator &&
    status === 'live' &&
    barStuck(match.buttons, yielding, {
      nextPhase: nextPhaseEnabled,
      endTurn: endTurnEnabled,
      decisionOk,
      decisionCancel,
      ask: askOpen,
      payment: paying,
      selection: selectionPopup,
      confirm: confirmPrompt,
      playOrDraw,
      mulliganPick,
      pregame: pregameWait,
      combat: declaringCombat(match),
    });
  useBarStuckReport(match, stuck, () => ({
    route,
    hold: match.barHold?.reason ?? '',
    label1: match.buttons?.label1 ?? '',
    enable1: match.buttons?.enable1 ?? false,
    label2: match.buttons?.label2 ?? '',
    enable2: match.buttons?.enable2 ?? false,
    asks: match.asks.length,
    prompt: (match.prompt ?? '').split('\n').slice(0, 3).join(' / ').slice(0, 80),
    turn: match.view?.turn ?? -1,
  }));
  /*
   * On the other seat's turn the same slot reads Auto Yield / Cancel Yield.
   * Pressable the instant that turn starts, before Forge has shown anything
   * — gated on `whoseTurnNow` alone, never on `bar` or `askOpen`.
   */
  const yieldMode = whoseTurnNow === 'theirs';
  const autoYieldOn = isAutoYieldOn(match);
  const [boardLayout, setBoardLayout] = useState<BoardLayout>(PLAY_PREFS_DEFAULTS.boardLayout);
  const settings = useSettingsPopover();
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
  /*
   * Fast Mode (wave 47), the same shape as board layout above: client-only,
   * so there is no server echo to adopt the way `stopAtEndStep` has one —
   * this is this client's own last word, held here because `<SettingsPanel>`
   * only exists while the popout is open and a toggle set last match still
   * has to reach `./pace.ts`'s wrapper whether or not this seat ever opens
   * it. `match.transport` is `./match.ts`'s own field (unowned, read not
   * written) — `isPacedTransport` narrows it without needing `match.ts` to
   * know pacing exists at all.
   */
  const [fastMode, setFastModeState] = useState<boolean>(PLAY_PREFS_DEFAULTS.fastMode);
  const appliedFastMode = useRef(false);
  useEffect(() => {
    if (appliedFastMode.current || prefs === null) return;
    appliedFastMode.current = true;
    const persisted = prefs.fastMode ?? PLAY_PREFS_DEFAULTS.fastMode;
    setFastModeState(persisted);
    if (isPacedTransport(match.transport)) match.transport.setFast(persisted);
  }, [prefs, match]);
  function handleFastModeChange(next: boolean): void {
    setFastModeState(next);
    if (isPacedTransport(match.transport)) match.transport.setFast(next);
  }
  // The seat's settings, in the match's log: once they have been read, and on every change.
  const settingsReported = useRef(false);
  useEffect(() => {
    if (spectator || prefs === null) return;
    // The first report is of the persisted values, so it waits for the effects above to have put them
    // into state (the same commit they arrive in still holds the defaults). After it, every change.
    if (!settingsReported.current) {
      const persistedLayout = prefs.boardLayout === 'type-separated' ? 'type-separated' : PLAY_PREFS_DEFAULTS.boardLayout;
      if (boardLayout !== persistedLayout || fastMode !== (prefs.fastMode ?? PLAY_PREFS_DEFAULTS.fastMode)) return;
      settingsReported.current = true;
    }
    reportClient(match.transport, match.matchId, 'info', { fastMode, boardLayout, reducedMotion: !motionWanted() });
  }, [match, spectator, prefs, fastMode, boardLayout]);
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
  const fastModeNow = useRef(fastMode);
  fastModeNow.current = fastMode;
  useEffect(() => {
    const canvas = rootRef.current;
    // A watcher's pointer belongs to nobody: no drag, no box, no arrow.
    if (canvas === null || spectator) return undefined;
    // Read through a ref, so toggling Fast Mode mid-match does not tear the layer down mid-gesture.
    const handle = installGestures({ canvas, match, motion: motionWanted, report: (kind, data) => reportClient(match.transport, match.matchId, kind, data) });
    return () => handle.dispose();
  }, [match, spectator]);

  /*
   * The other seat's presence (ledger Z5, `presence.ts`): their pointer, a
   * card back while they hold one, their arrow while they aim — and this
   * seat's own, sent to them. A watcher is shown it and sends nothing (its
   * `seat` is null).
   */
  // Where each seat put its battlefield cards, both ways (`arrangement-sync.ts`).
  const boardLayoutNow = useRef(boardLayout);
  boardLayoutNow.current = boardLayout;
  useEffect(() => {
    const handle = installArrangementSync({
      matchId: match.matchId,
      get seat() {
        return spectator ? null : match.seat;
      },
      transport: match.transport,
      view: () => match.view,
      layout: () => boardLayoutNow.current,
      watch: (onChange) => subscribe(match, onChange),
    });
    return () => handle.dispose();
  }, [match, spectator]);

  useEffect(() => {
    const canvas = rootRef.current;
    if (canvas === null) return undefined;
    const handle = installPresence({
      canvas,
      host: {
        matchId: match.matchId,
        get seat() {
          return spectator ? null : match.seat;
        },
        transport: match.transport,
        opponentName: () => match.view?.players.find((p) => !p.isViewer)?.name ?? null,
        theirPlayerId: () => match.view?.players.find((p) => !p.isViewer)?.id ?? null,
        // `from` (the arrow's tail) is sent only while this seat is actually aiming — the
        // same condition `paint()` (`gestures/install.ts`) already uses for its own arrow.
        aiming: () => match.selectables !== null || stackAsk(match) !== null,
        watch: (onChange) => subscribe(match, onChange),
        theirCards: () => {
          const view = match.view;
          if (view === null) return [];
          const them = view.players.filter((p) => !p.isViewer);
          const mine = view.players.find((p) => p.isViewer)?.name ?? null;
          return [
            ...them.flatMap((p) => p.battlefield.map((c) => c.id)),
            ...view.stack.filter((item) => !item.isAbility && item.sourceCardId !== null && item.controllerName !== mine).map((item) => item.sourceCardId!),
          ];
        },
        theirStackCards: () => {
          const view = match.view;
          if (view === null) return [];
          const mine = view.players.find((p) => p.isViewer)?.name ?? null;
          return view.stack.filter((item) => !item.isAbility && item.sourceCardId !== null && item.controllerName !== mine).map((item) => item.sourceCardId!);
        },
        motion: motionWanted,
        // A watcher sends none (`reportClient`'s own rule).
        report: spectator ? undefined : (kind, data) => reportClient(match.transport, match.matchId, kind, data),
      },
    });
    return () => handle.dispose();
  }, [match, spectator]);

  /*
   * `--live-h`: `.live`'s own real resolved height, in pixels, kept current on
   * this element so `live.css`'s `--rail-row-h` (wave 33 §L1) can read it.
   *
   * Why this exists rather than a CSS length: `.live` is `height: 100dvh` on
   * the bare/dev-harness route, but on the MATCH route (`.shell--match` is an
   * ancestor) `live.css` overrides that to `height: auto` and sizes it by
   * flex instead — under the real header (`AppHeader`, ~80px with its own
   * margin) and, in production, possibly inside watchparty's room frame too.
   * `.live` is shorter than the viewport in both of those real shapes, so a
   * viewport unit (`dvh`) here overshoots: measured on the match route at
   * 1280×800, `.live` resolved to 713px against the 800px viewport, a rail
   * sized from `35dvh` grew tall enough to overlap the control cluster by
   * ~23px (`docs/planning/wave33-evidence/l1-rail-rows.md` has the numbers).
   * Measuring `.live` itself, whatever shape put it there, is the only way to
   * get this right in every shape without hard-coding any of them.
   *
   * Why a CSS custom property and not a `%` one: a `%` stored in a custom
   * property is not resolved where it is declared, it is resolved against
   * whichever box later reads it (`.live__step`, not `.live`) — the bug the
   * first version of this fix hit. `--live-h` holds a LENGTH (`px`), which has
   * no containing block to re-resolve against, so it reaches every descendant
   * meaning the same thing, the same way `dvh` did — just scoped to `.live`
   * instead of the viewport.
   *
   * `ResizeObserver` guarded rather than assumed: jsdom (this file's own unit
   * tests) has no implementation of it, and a throw here would fail every
   * test in the file rather than only the ones about this box.
   */
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    // Synchronous and before paint (`useLayoutEffect`, not `useEffect`): a
    // passive effect runs after the browser has already painted, and a test
    // (or a player) that reads the rail's box on the very first frame would
    // catch the `100dvh` fallback instead of this value — on the match route
    // that is a taller number, not a merely-stale one, so the first frame's
    // row heights would disagree with every later one. Measured live: this
    // is what turned the one-time 23px overlap into a RACE (e2e's "same row
    // height" check read `.live` before and after this effect had run, 2 of
    // 3 times) once `--live-h` existed at all.
    const sync = () => el.style.setProperty('--live-h', `${el.getBoundingClientRect().height}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /*
   * Wave 51 §A.6: `--question-top`, the decision area's top edge, so the stack
   * sits right above whatever is asking. The operator, 2026-10-06: *"why is the
   * stack carousel so much higher than the decision box? thats silly it should
   * be right above the decision box."* A pop-up is centred in its column and
   * its height is its content's, so CSS alone cannot know where its top is;
   * this measures it (`questionTopOf`) and `board.css`'s
   * `.board__mid[data-question]` hangs the band from it. Every render, and on
   * any resize of the root or of what is in the column (a prompt that grows
   * from its own state re-renders nothing here).
   */
  const relayoutFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(relayoutFrame.current), []);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return undefined;
    const sync = (): void => {
      const top = questionTopOf(root);
      // No pop-up to measure: the last measured edge stands, so the band does
      // not jump to the column's top for the frame between a spell reaching
      // the stack and the pop-up that asks about it (the operator,
      // 2026-10-07: the band "was only there briefly" at the top), and stays
      // put when a pop-up closes. Before any pop-up has been measured,
      // `board.css` falls back to where one sits.
      if (top === null) return;
      const value = `${top}px`;
      if (root.style.getPropertyValue('--question-top') === value) return;
      root.style.setProperty('--question-top', value);
      /*
       * The band moved with no frame from Forge: arcs drawn from its thumbnails
       * repaint (`relayout`). On the next frame, never inside this commit: the
       * same wake settles a played card's landing, which measures the card's
       * slot, and `Board` moves a dropped card into its slot in a passive
       * effect that has not run yet here (measured: the landing flew 190px wide).
       */
      cancelAnimationFrame(relayoutFrame.current);
      relayoutFrame.current = requestAnimationFrame(() => relayout(match));
    };
    sync();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    observer?.observe(root);
    for (const el of root.querySelectorAll(QUESTION_SELECTOR)) observer?.observe(el);
    return () => observer?.disconnect();
  });

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
      {visualView !== null && <Board view={visualView} interaction={interaction} boardLayout={boardLayout} onOpenSettings={settings.toggle} />}
      {/* Out of flow, over the board's right edge: it moves no canvas box. */}
      {match.view !== null && <PhaseRail view={match.view} />}
      {/*
       * The logbook (§C.3): Forge's current message and the server's says, a
       * wide overlay over the main view starting at the board's LEFT edge
       * (the side the phase rail vacated) and reaching across to short of the
       * rail-and-controls gutter, hidden until the cluster's `Log` toggle
       * opens it.
       *
       * It is always in the DOM and only `hidden`, which is what makes it a
       * disclosure rather than a thing that comes and goes: the toggle's
       * `aria-controls` points at a node that exists, and a spec reading Forge's
       * message off `live-says` finds it whether the panel is open or not.
       *
       * `pointer-events` is `none` while collapsed and `auto` while open
       * (`live.css`): collapsed, it must not shadow the drag gesture on
       * whatever board it covers, the same reason the phase rail is
       * pointer-transparent; open, it is a scrollable panel the player asked
       * for, and a pointer-transparent box cannot be scrolled by hand.
       */}
      <div className="live__logbook" data-testid="live-logbook" id={logbookId} hidden={!logOpen}>
        {/*
         * The turn counter (R11, wave 35): *"remove the turn counter from the
         * phase bar (the log has it)."* It used to be the rail's own `.live__turn`
         * (§C.2); the rail kept the tight 8.4% column for the thirteen step
         * names and nothing else, and this is where the number went. Same test
         * ids (`live-turn`, `live-turn-n`) as before the move — only the
         * ELEMENT'S PARENT changed, not the name a spec finds it by. `data-whose`
         * is on this element directly (not inherited from `.live__phases`, which
         * it no longer shares a parent with) so `live.css` can still colour the
         * number when it is the viewer's turn.
         */}
        {match.view !== null && (
          <p className="live__turn" data-testid="live-turn" data-whose={whoseTurnNow}>
            <span className="live__turn-n" data-testid="live-turn-n">
              {match.view.turn > 0 ? match.view.turn : 'Start'}
            </span>
          </p>
        )}
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
         * notation is said in words, as every other rules text is. This list is
         * the scroll owner (`overflow-y: auto` in `live.css`); `logListRef`'s
         * effect keeps the newest line in view rather than relying on a flex
         * `justify-content: flex-end` trick, which only works while the whole
         * history fits in the box — not a safe assumption against a history
         * this long.
         */}
        <ul className="live__log" data-testid="live-log" aria-label="Said" ref={logListRef}>
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
       *
       * **R8, wave 35: the button is an icon**, not the word "Log" — a page
       * line and the button that opens it said the same word twice. The
       * accessible name moves to `aria-label` (screen readers announce that
       * over any visible text anyway) and `title` stays for the pointer
       * tooltip; the glyph itself is `aria-hidden`, the same convention every
       * other inline icon in this codebase follows (`Board.tsx`'s mark and
       * count icons).
       */}
      <button
        type="button"
        className="live__log-button"
        data-testid="live-log-toggle"
        aria-expanded={logOpen}
        aria-controls={logbookId}
        aria-label="Log"
        title="The log"
        onClick={() => setLogOpen(!logOpen)}
      >
        <svg className="live__log-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M2.5 3.5h11v1.6h-11Z" />
          <path d="M2.5 7.2h11v1.6h-11Z" />
          <path d="M2.5 10.9h7.4v1.6h-7.4Z" />
        </svg>
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
        {/*
         * Wave 51: the same four buttons every frame, in this order — `Next
         * Phase`, `End Turn`, `Full control`, `Concede`. The operator: *"keep the
         * same 4 buttons in the control box at all times … just grey out the
         * 'Next Phase' and 'End Turn' buttons when they are not relevant."* The
         * labels are ours and never change; every other answer to Forge's bar is
         * the decision pop-up below. `data-highlight` (R5) is End Turn's.
         *
         * The one exception: on the OTHER seat's turn the End Turn slot
         * reads Auto Yield / Cancel Yield instead, same testid and place
         * (`yieldMode`/`autoYieldOn`, above).
         */}
        <button
          type="button"
          className="live__next-phase"
          data-testid="live-button-next-phase"
          disabled={!nextPhaseEnabled}
          onClick={() => pressWithSound(match, 'ok')}
        >
          Next Phase
        </button>
        <button
          type="button"
          className="live__end-turn"
          data-testid="live-button-end-turn"
          data-highlight={!yieldMode && highlightEndTurn ? '' : undefined}
          data-yield={yieldMode ? (autoYieldOn ? 'on' : 'off') : undefined}
          disabled={yieldMode ? spectator : !endTurnEnabled}
          onClick={() => (yieldMode ? setAutoYield(match, !autoYieldOn) : pressWithSound(match, 'cancel'))}
        >
          {yieldMode ? (autoYieldOn ? 'Cancel Yield' : 'Auto Yield') : 'End Turn'}
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
      {match.reveal !== null && (
        <RevealNotice key={match.reveal.callId} reveal={match.reveal} lookup={lookupFromState(match.state)} onDone={dismissReveal.bind(null, match, match.reveal.callId)} />
      )}
      {paying && <PaymentWindow match={match} />}
      {/*
       * R2: the coin toss / play-draw question, in the decision area (shape 2)
       * rather than the control bar — lane G's `g.md` has the full shape.
       * `onPlay`/`onDraw` are `pressButton`, the one sender for Forge's two
       * buttons, so the wire cannot tell where a press came from.
       */}
      {playOrDraw && (
        <div className="live__prompt" data-testid="live-play-or-draw-host">
          {coinToss !== null && <CoinToss {...coinToss} />}
          {!coinFlipping && (
            <ConfirmPrompt
              testId="live-play-or-draw"
              message={promptText(match.prompt ?? '')}
              button1={{ label: PLAY_LABEL, enabled: bar?.enable1 ?? false, testId: 'live-play-or-draw-play', onClick: () => pressWithSound(match, 'ok') }}
              button2={{ label: DRAW_LABEL, enabled: bar?.enable2 ?? false, testId: 'live-play-or-draw-draw', onClick: () => pressWithSound(match, 'cancel') }}
            />
          )}
        </div>
      )}
      {/*
       * T4 (shape 1): every yes/no that is an ANSWER, in the decision area —
       * the operator's *"i hate yes/no on control bar. should always be the
       * big pop up."* `onYes`/`onNo` are `pressButton`, the one sender for
       * Forge's two buttons (`ConfirmPrompt.tsx`'s own header has the
       * precedent). `barRoute` routes this bar nowhere else, so the control
       * box's two game buttons stay greyed while it is up.
       */}
      {confirmPrompt && bar !== null && (
        <div className="live__prompt" data-testid="live-confirm-host">
          <ConfirmPrompt
            testId="live-confirm"
            message={promptText(match.prompt ?? '')}
            button1={{ label: bar.label1, enabled: bar.enable1, testId: 'prompt-confirm-yes', onClick: () => answerTrigger('ok') }}
            button2={{ label: bar.label2, enabled: bar.enable2, testId: 'prompt-confirm-no', onClick: () => answerTrigger('cancel') }}
            check={match.promptTrigger === null ? undefined : { label: 'Always', testId: 'live-confirm-always', checked: always, onChange: setAlways }}
          />
        </div>
      )}
      {/*
       * Wave 51: every other enabled bar button, in the decision area — priority
       * with spells on the stack, attackers or blockers done, a target's
       * `Cancel`, `OK` + `Undo (N)`. Forge's own words on Forge's own buttons,
       * each drawn only where Forge enabled it; `End Turn` is the control box's
       * and is never drawn here, and the attack step's second button is
       * refused as it was on the bar (`offersSecondButton`). The London
       * mulligan's bottom pick is `OK` alone: its message is the one
       * sentence held in `mulliganPickText`, not Forge's current count-down.
       * While a played card is staged for its target the pop-up draws under
       * it (`data-staged`, `live.css`).
       */}
      {decision && bar !== null && (
        <div className="live__prompt" data-testid="live-decision-host" data-staged={interaction.stagedCardId !== undefined || undefined}>
          <ConfirmPrompt
            testId="live-decision"
            message={mulliganPick ? mulliganPickText.current ?? '' : decisionMessage(match.prompt ?? '', match.view?.stack[0] ?? null)}
            button1={decisionOk ? { label: combatDoneLabel(match) ?? bar.label1, enabled: !mulliganPick || bar.enable1, testId: 'live-decision-ok', onClick: () => pressWithSound(match, 'ok') } : undefined}
            button2={decisionCancel ? { label: bar.label2, enabled: true, testId: 'live-decision-cancel', onClick: () => pressWithSound(match, 'cancel') } : undefined}
            check={sameTargetCheck}
          />
        </div>
      )}
      {/* A trigger's target with identical ones waiting and no button of Forge's to draw: the box alone, under Forge's own line. */}
      {sameTargetCheck !== undefined && !(decision && bar !== null) && (
        <div className="live__prompt" data-testid="live-target-host">
          <ConfirmPrompt testId="live-target" message={promptText(match.prompt ?? '')} check={sameTargetCheck} />
        </div>
      )}
      {/*
       * W18 (off-board: Relentless Dead's graveyard target, no board element
       * to click) and W16 (on-board: Worldbreaker's own choice had a legal
       * board target but no prompt text ever explained it). One picker for
       * both — `classifySelection` already told them apart; `SelectionPrompt`
       * draws the same grid either way, with Forge's own prompt line as its
       * title. `done`/`cancel` are Forge's own two bar buttons, omitted
       * (drawing neither) exactly where Forge has not enabled them. Wave 51:
       * Forge enables its OK once enough is picked (or none is needed), and
       * with the bar's OK gone this Done is the only place it can be pressed.
       */}
      {selectionPopup && match.selectables !== null && (
        <div className="live__prompt" data-testid="live-selection-host">
          <SelectionPrompt
            message={promptText(match.prompt ?? '')}
            cards={[...match.selectables.cards]}
            lookup={lookupFromState(match.state)}
            picked={match.highlighted ?? EMPTY_CARD_IDS}
            onPick={(id) => selectCard(match, id)}
            done={bar?.enable1 === true ? { label: bar.label1, enabled: true, onClick: () => pressWithSound(match, 'ok') } : undefined}
            cancel={bar?.enable2 === true ? { label: bar.label2, enabled: true, onClick: () => pressWithSound(match, 'cancel') } : undefined}
          />
        </div>
      )}
      {/*
       * T2 + W1, merged into one pop-out — see `WaitingPop`'s own note.
       * Operator, on the coin toss / mulligan case: *"i think the coinflip
       * prompt should be shown to both players at once. and for the one who
       * lost they get the waiting prompt. same for mulligan…"* Pregame
       * (`pregameWait`) has no Forge text for this moment at all (see
       * `isWaitingForPregameDecision`'s own note), so it gets the plain
       * "Waiting for {name}…" the small line always used; the ordinary
       * mid-game wait gets the server's own fact (`waitingSentence`'s verb
       * table) when there is one. `!viewerOpen`: never drawn while this
       * seat holds a live bar or decision of its own, stale fact or not —
       * the operator, 2026-10-11, under full control, read "Waiting for
       * Hadoku to decide…" over his own live Next Phase / End Turn.
       */}
      {/* The coin is its own fact, told before the lagged `waitingOn` — never gated on it. */}
      {coinToss !== null && !playOrDraw && !myOwnDecisionOpen && !(match.view?.gameOver ?? false) && (
        <div className="live__prompt" data-testid="live-coin-toss-host">
          <CoinToss {...coinToss} waiting={match.seat !== coinToss.winner} />
        </div>
      )}
      {waitingForOpponent && !viewerOpen && coinToss === null && (
        <WaitingPop
          sentence={pregameWait || theirAsk === null ? `Waiting for ${theirName ?? 'the other player'}…` : waitingSentence(theirName ?? 'the other player', theirAsk)}
        />
      )}
      {conceding && !spectator && !over && (
        <ConcedeAsk
          onConcede={() => {
            concede(match);
            setConceding(false);
          }}
          onCancel={() => setConceding(false)}
        />
      )}
      {/* R16: Victory/Defeat/Draw, in place of the toast (`Board`'s old `game over` banner). Over the board, which stays visible behind it. */}
      {match.view !== null && (match.view.gameOver || match.finished) && <GameResultScreen match={match} roomId={roomId} />}
      {/* Cardtable's own settings, opened from the viewer's own face (`../../settings/Settings.tsx`). */}
      {settings.trigger !== null && (
        <SettingsPopover trigger={settings.trigger} onClose={settings.close}>
          <SettingsPanel
            match={match}
            inert={spectator}
            boardLayout={boardLayout}
            onBoardLayoutChange={setBoardLayout}
            fastMode={fastMode}
            onFastModeChange={handleFastModeChange}
            onSave={(patch: Partial<PlayPrefs>) => void savePrefs(patch)}
          />
        </SettingsPopover>
      )}
    </div>
  );
}
