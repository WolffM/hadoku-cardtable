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
 * Before any of that, an ask goes past `@hadoku/shared`'s `selfAnswer` —
 * the ONE place it is decided whether a question answers itself (the server
 * reads it too, so the other seat is never told this one is deciding). One case
 * is `getAbilityToPlay` with exactly one ability (never a land card's off the battlefield that does not
 * play it — `oneAbility`): the operator's *"one
 * choice shouldn't require this dialog at all"* (wave 20, item 4), and the
 * whole of their *"'choose ability' often needs the click TWICE"* (item 9),
 * because Forge asks that offer twice for one `selectCard` and both copies now
 * answer themselves. The reply goes through `answerAsk` like any other, and what
 * it played is in Forge's own game log like any cast, so the shortcut is
 * visible; nothing is drawn for it, not even for a frame, full control or not.
 *
 * ## Clicks on the board
 *
 * `Board` gets a `BoardInteraction` built from `drawnOffer(match)` —
 * exactly what Forge named, and nothing else (`./match.ts` says how), held
 * through the silence after a click (`./offer-hold.ts`) — and its callbacks go
 * to `selectCard` / `selectPlayer`, which check the CURRENT state again before
 * sending anything.
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
 * The log is Forge's own game log: every entry Forge writes (a cast and its
 * target, a trigger, damage, life, combat, a land, a discard, a mill, a card
 * dying or exiled, a scry, the mana that paid, a turn), worded for this seat by
 * the bridge (`PlayBridge.GameLogForward`, which keeps a card this seat may not
 * see out of it). They arrive as Tier-A `message` notifies carrying a `log`
 * (`GameLogLineSchema`); `match.says` holds them (`SAYS_KEPT`) and the logbook
 * draws all of them, braces said in words like every other rules text.
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
 * The other six states keep the line, and that is not a hedge: in all but one
 * of them there is no board, so the line is the only thing on the page, and
 * the one that keeps a board (`reconnecting`) is a table nobody can act on until
 * the socket is back. `Match
 * gone.` with nothing under it is a player being told what happened; deleting it
 * would leave them a blank screen with nothing on it at all. What the operator
 * was shown, and rejected, was the line on a LIVE table.
 *
 * ## A payment is a question, so it is drawn as one (wave 25 §C.2)
 *
 * The operator, on a Mana Leak: *"if an effect happens that is necessary, it
 * should popout into its own popover modal on top of the game not in some
 * text box."* A mana payment is not one of Forge's `ask` methods — it is
 * a STATE of the live match, `showPromptMessage` plus `updateButtons`, which is
 * exactly why its text used to land in the corner with the rest of the prose
 * and its answers were the cluster's own two buttons. `match.ts`'s
 * `payingMana` already names that state (four facts, all cited there), so this
 * component draws it in the prompt sheet with Forge's own message and Forge's
 * own two labels. No new words, and nothing in `../prompts/` — there is no ask
 * to have a prompt component for.
 *
 * The control box's `End Turn` stays greyed through a payment: Forge's bar
 * there is `Auto` + `Cancel`, which is not it.
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
 * The one game button is `End Turn`, our words, enabled only for the one
 * input it presses (`offersEndTurn`); every other answer to Forge's bar,
 * passing priority included, is the decision pop-up (`barRoute`).
 * `pressButton` refuses a disabled bar too, so a greyed button that is somehow
 * pressed still sends nothing.
 *
 * On the OTHER seat's turn the End Turn slot is repurposed — Auto Yield /
 * Cancel Yield, a standing preference (`setAutoYield`, `isAutoYieldOn`)
 * rather than an answer to Forge's bar, pressable from the instant the other
 * seat's turn starts. The server acts on it (`match.ts`'s `maybeAutoPass`).
 *
 * **Concede and Settings are in it** (wave 24 §C.4, wave 30 item 7), BELOW End
 * Turn with Full control between them. Neither is an answer to Forge,
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
 * it carries `aria-current="step"`. The rail is out of flow, so it changes no
 * canvas box (the static-canvas rule), and only its rows that can take a stop
 * take the pointer (`PhaseRail`).
 *
 * ## One state, one line
 *
 * The operator, on seeing `forge:join was refused: unknown-match`,
 * `Connected, not seated.` and `Waiting for the game state.` stacked together:
 * *"are these messages coordinated? are they in the right spot? i wonder if it
 * makes sense to show all three."* No — they were three lines for one
 * situation, and two of them were hopeful about a match that was already gone.
 *
 * `liveStatus` is the whole state machine (`LiveStatus`: seven states, the names
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

import { Component, memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { CLIENT_EVENT, selfAnswer, type ClientEvent, type DraftCard } from '@hadoku/shared';
import type { RoomTable as SharedRoomTable } from '@hadoku/shared';
import { YIELDING, type GameLogLine } from '@hadoku/forge-wire';
import { usePrefs } from '@wolffm/prefs-client/react';
import { parseDck } from '@hadoku/carddata/dck';
import { CONSTRUCTED_LIMITS, LIMITED_MIN_MAIN_DECK_SIZE, deckFromDeckFile, type Deck } from '@hadoku/deck';

import { navigate, routeHash } from '../../screens/route.ts';
import { roomsClient, type RoomView } from '../../rooms/api.ts';
import { roomFeed } from '../../rooms/feed.ts';
import { latestReads } from '../../rooms/latest.ts';
import { tablesClient, type RoomTable, type SeatChoice, type StartOutcome, type TablesClient } from '../../screens/tables.ts';
import { DeckEditor, type ReadyState } from '../../deck/DeckEditor.tsx';
import { deckStoreClient } from '../../deck/deckStore.ts';
import { dckTextOf } from '../../draft/deckFromPool.ts';
import { libraryDeckText, namedCardPool } from '../../deck/build.ts';
import { ActionButton } from '../../components/ActionButton.tsx';
import { Avatar } from '../../components/Avatar.tsx';
import { drawnCards, opponentOf, PHASE_LABEL, viewerOf, type BoardPlayer, type BoardView, type StackEntry } from '../adapter.ts';
import { Board, POISON_TO_LOSE, poisonOf, type BoardInteraction, type BoardLayout, type HeldTags } from '../Board.tsx';
import { CheckMark } from '../marks.tsx';
import { lookupFromState, plainRulesText, promptLines, promptText, selectionText, withAbilityLabels } from '../prompts/lookup.ts';
import { RulesText } from '../prompts/RulesText.tsx';
import { ManaPip } from '../../components/ManaPip.tsx';
import { RevealNotice } from '../prompts/RevealNotice.tsx';
import { ConfirmPrompt, DRAW_LABEL, PLAY_LABEL, barRoute, isConfirmPrompt, isPlayOrDrawPrompt, offersEndTurn, type BarRoute } from '../prompts/ConfirmPrompt.tsx';
import { AnswerRow, promptTileFor } from '../prompts/PromptShell.tsx';
import { classifySelection, isPromptMethod, PromptFor, SelectionPrompt, type AskOf, type PromptMethod, type SelectionKind } from '../prompts/index.ts';
import { installGestures } from './gestures/index.ts';
import { attackWith } from './gestures/commit.ts';
import { stackAsk } from './gestures/stack.ts';
import { castLandingWeight } from './gestures/cast.ts';
import { installPresence } from './presence.ts';
import { setChainHalted } from './placed.ts';
import { installArrangementSync } from './arrangement-sync.ts';
import { isPacedTransport } from './pace.ts';
import { boardFacts, watchFrames, type FrameWatch } from './frame-watch.ts';
import { BAR_STUCK_MS, barStuck } from './bar-hold.ts';
import { deriveSoundEvents, thrownSoundEvents } from './sound-events.ts';
import { phaseSoundGate } from './phase-sound.ts';
import { NO_PRIORITY_CUE, nextPriorityCue, type PriorityCue } from './priority-cue.ts';
import { matchStartSounded, openNewMatch } from './matchStart.ts';
import { hoverControl, isMuted, playRole, playSoundEvents, takeUiTally, type DelayedSoundEvent } from '../../sound/index.ts';
import { useMatchMusic } from '../../sound/match-music.ts';
import { boardDrawing, boardSoundsAt, cardImpactAt, exitBeatAt, lifeImpactAt, prefersReducedMotion, whenBoardStill } from '../motion.ts';
import {
  abortAsk,
  answerAsk,
  answerConfirm,
  attackAssignment,
  blockFocusOf,
  damagePreviewOf,
  previewDamage,
  combatCandidates,
  concede,
  currentAsk,
  declaringAttackers,
  drawnOffer,
  declaringBlockers,
  declaringCombat,
  dismissReveal,
  doomAskOf,
  genuinelyAsked,
  isAutoYieldOn,
  liveBar,
  lifePayable,
  lifePayer,
  lifePerPress,
  nothingToDecide,
  choosingMulligan,
  clickCard,
  payingMana,
  payFromPool,
  payWithLife,
  poolChoice,
  poolPays,
  pickedOf,
  pressButton,
  relayout,
  SAYS_KEPT,
  selectCard,
  selectPlayer,
  sendStopPreference,
  setAutoYield,
  flipPerspective,
  otherSeat,
  playerIdOfSeat,
  setFullControl,
  setPhaseStop,
  setSameTarget,
  setTriggerDecision,
  subscribe,
  viewerPlayerIdOf,
  type LiveAsk,
  type LiveClickables,
  type LiveMatch,
  type MatchTransport,
  type Say,
} from './match.ts';
import { getPlayPrefsClient, PLAY_PREFS_DEFAULTS, type PlayPrefs } from './prefs.ts';
import { StopPhaseSchema, stopStep, type StopPhase } from './transport.ts';
import { MistakeBubble } from './MistakeBubble.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { fetchOwnDeck, OwnDeckPeek, type OwnDeck } from './own-deck.tsx';
import { usePopover } from '../../components/Popover.tsx';
import { SettingsPopover } from '../../settings/Settings.tsx';
import { eventTarget } from '../../dom.ts';
import { castForbiddenTip, costTip, flashTip } from '../tip/words.ts';
import './live.css';
import { TossCoin, useCoinFlipping } from './CoinToss.tsx';
import { CoinFlips } from './coin-flip.tsx';
import type { ShownFlip, ShownRoll } from './shown.ts';
import { TurnCue, useYourTurnCue } from './TurnCue.tsx';
import { installDialogMover, QuestionHost, restingTop } from './movable.tsx';

/* ── Where the match is: seven states, one line ───────────────────────── */

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
  | 'reconnecting'
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

/* ── wave 51 §A.6: the stack sits right above the decision area ───────── */

/** What occupies the decision column: a pop-up's sheet, or a card staged for its target. */
const QUESTION_SELECTOR = '.live__prompt > *, .staging__list';

/**
 * The top edge of whatever is in the decision column, in the stack band's own
 * frame (`.board__mid`'s containing block, its `position: relative` parent
 * `.board`), or `null` when nothing is there. The topmost one wins: a card
 * staged for its target sits above its decision pop-up (`data-staged`), and
 * the stack sits above the card. A pop-up the player moved is measured where it would stand unmoved
 * (`restingTop`): the stack keeps its place rather than following it round the table.
 */
export function questionTopOf(root: HTMLElement): number | null {
  const frame = root.querySelector('.board__mid')?.parentElement;
  if (frame == null) return null;
  const tops = Array.from(root.querySelectorAll(QUESTION_SELECTOR))
    .filter((el) => el.getBoundingClientRect().height > 0)
    .map(restingTop);
  return tops.length === 0 ? null : Math.min(...tops) - frame.getBoundingClientRect().top;
}

/**
 * Client telemetry (`@hadoku/shared`'s `telemetry.ts`): the server writes it
 * into the match's log beside its own events. Settings on join and on each
 * change; a played card's landing from the gesture layer. A watcher sends none.
 */
function reportClient(transport: Pick<MatchTransport, 'emit'>, matchId: string, kind: ClientEvent['kind'], data: ClientEvent['data']): void {
  transport.emit(CLIENT_EVENT, { matchId, kind, data } satisfies ClientEvent);
}

/** How often the interface sound counts reach the match's log. */
const UI_TALLY_EVERY_MS = 30_000;

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

/** A die thrown or a coin flipped in the game, as it starts. */
function soundThrow(match: LiveMatch, thrown: ShownRoll | ShownFlip): void {
  const events = thrownSoundEvents(thrown, viewerOf(match.view)?.id ?? null);
  playSoundEvents(events);
  reportSound(match, 'throw', events);
}

/**
 * What the table raised to play, and why, into the match's log: `view` for a
 * board change (the roles, their colour cells, the view's turn and seq),
 * `decision` for a decision window's chime, `priority` for priority handed back
 * (`./priority-cue.ts`), `press` for a bar button, `toss`
 * for the coin toss, `throw` for a die or a coin thrown in the game, `start`
 * for the room's hand-off into a new match. Raised,
 * not heard: the mixer may still drop one (unassigned, collapsed, muted), and
 * `muted` says the last.
 */
function reportSound(match: LiveMatch, why: 'view' | 'phase' | 'decision' | 'priority' | 'press' | 'toss' | 'throw' | 'start', events: readonly DelayedSoundEvent[], extra: ClientEvent['data'] = {}): void {
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

/** Forge's priority status block, which opens every ordinary priority window's prompt. */
const PRIORITY_PROMPT = /^Priority: /;

/** Forge's priority status block with something on the stack: "Priority: … / Turn: … / Phase: … / Stack: N to Resolve." */
const PRIORITY_OVER_STACK = /^Priority: [^\n]*\nTurn: [^\n]*\nPhase: [^\n]*\nStack: \d+ to Resolve\.?$/;

/** Forge's own sentence opening the London mulligan's bottom pick: "Return N card(s) to the bottom of your library." */
const MULLIGAN_BOTTOM_PICK = /^Return \d+ card\(s\) to the bottom of your library\.?$/;

/**
 * What the decision pop-up says. Forge's priority status block is what the
 * log's status line is for; in the pop-up it names what passing does. With
 * something on the stack its OK lets the top resolve, so it names the top of
 * the stack (the operator, 2026-10-08: never a bare "Resolve?"): a trigger or
 * an ability names its SOURCE ("Resolve Bitterblossom's trigger?"), a spell
 * names itself ("Resolve Keiga, the Tide Star?"). `topStack` is
 * `match.view.stack[0]`; while the view has not caught up with the prompt it is
 * `null` and the question stays bare rather than invent a name. With the stack
 * empty its OK moves the game on, so it names the step the rail moves to:
 * "Proceed to Declare blockers?". `next` is that step's name, given only for
 * the empty-stack pass (`barRoute`'s `pass`, `nextStepName`). Every other
 * prompt is Forge's own words, made readable.
 */
export function decisionMessage(prompt: string, topStack: StackEntry | null, next: string | null): string {
  if (PRIORITY_PROMPT.test(prompt) && !PRIORITY_OVER_STACK.test(prompt) && next !== null) return `Proceed to ${next}?`;
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
  const other = otherSeat(match);
  if (other === null || match.waitingOn === null) return null;
  const fact = match.waitingOn.get(other) ?? null;
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
    <QuestionHost>
      <section className="confirm" data-testid="live-waiting-pop" role="status" aria-live="polite">
        <p className="confirm__message">{sentence}</p>
      </section>
    </QuestionHost>
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
  if (match.spectator) return false;
  const view = match.view;
  if (view === null || match.over) return false;
  return theirWaitingOn(match) !== null || theyLeft(match);
}

/**
 * The other seat's player closed the tab or dropped, and is past the server's
 * grace — the rejoin audit, 2026-10-19: the one still at the table read
 * "is choosing to play or draw…" for a player who was gone.
 */
function theyLeft(match: LiveMatch): boolean {
  const other = otherSeat(match);
  return other !== null && match.awaySeats.has(other);
}

/**
 * Whether the other seat holds ANY open window the server reports — a decision OR a plain
 * priority hold. The opponent's priority FLAG reads this, never `isWaitingForOpponent`: the
 * pop-out drops `priority` (it is for decisions), and the flag reading that same filtered fact
 * went dark for every held window after `0670a98` (found by AE16's spec: four windows forwarded
 * to bob, alice's flag for him never lit).
 */
function opponentHoldsAWindow(match: LiveMatch): boolean {
  const other = otherSeat(match);
  if (match.spectator || other === null || match.waitingOn === null) return false;
  const view = match.view;
  if (view === null || view.gameOver) return false;
  return match.waitingOn.has(other);
}

/**
 * The windows open on this screen right now, by identity: the viewer's oldest ask, the viewer's live bar and the
 * other seat's reported window. Each is a fresh object when it opens, which is what lets `./phase-sound.ts` tell a
 * window that opened in this phase from one left over from the phase before.
 */
function openWindows(match: LiveMatch): object[] {
  const open: object[] = [];
  const ask = currentAsk(match);
  if (ask !== null) open.push(ask);
  const bar = liveBar(match);
  if (bar !== null && bar.enable1) open.push(bar);
  const other = otherSeat(match);
  const theirs = other === null ? undefined : match.waitingOn?.get(other);
  if (theirs !== undefined) open.push(theirs);
  return open;
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
 *
 * `reconnecting` is a socket this page HAD and lost — a deploy restarting the
 * server mid-game is the usual one, and the server holds the seat through it.
 * It is not `connecting`: that word is for a page that has never reached the
 * server, and the operator read it over his own open mulligan (2026-10-13).
 */
export function liveStatus(match: LiveMatch): LiveStatus {
  if (isMatchGone(match)) return 'match-gone';
  if (refusalOf(match) !== null) return 'refused';
  if (!match.connected) return match.everConnected ? 'reconnecting' : 'connecting';
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
    case 'reconnecting':
      return 'Reconnecting…';
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
      onPreview={(amounts) => previewDamage(match, ask.callId, amounts)}
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
 * cap is `match.ts`'s own `SAYS_KEPT` — a generously bounded whole game, not a
 * two-line window — and nothing is dropped between what the match holds and
 * what the panel shows.
 */
const SAYS_SHOWN = SAYS_KEPT;

/* ── the log, as something you can read (wave 28 §A.11, render half) ──── */

/**
 * What KIND of thing a log line reports, which `live.css` colours.
 *
 * The operator, 2026-09-28: *"properly color things based on what happened like
 * damage taken … any cardnames should be hoverable and show what card it is."*
 * A line of Forge's own log carries its `GameLogEntryType`, so the kind is read
 * off that and never off the words. The one line that is not Forge's is the
 * seat's own `full control on`/`off` (`control`); anything else Forge says
 * through `message` falls to `said`.
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



const KIND_BY_TYPE: Partial<Record<GameLogLine['type'], LogKind>> = {
  DAMAGE: 'damage',
  LIFE: 'life',
  MANA: 'payment',
  LAND: 'play',
  STACK_ADD: 'play',
};

function logKind(say: Say): LogKind {
  if (say.log === null) return /^full control (on|off)$/.test(say.text) ? 'control' : 'said';
  // A trigger is Forge's cast line too ("<player> triggered <card>"): the one STACK_ADD told apart by its verb.
  if (say.log.type === 'STACK_ADD' && /^\S+ triggered /.test(say.text)) return 'trigger';
  return KIND_BY_TYPE[say.log.type] ?? 'said';
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

/** The held cards an effect forbids this seat to cast, each with what its tooltip says. */
function castForbiddenTips(match: LiveMatch): ReadonlyMap<number, string> | undefined {
  if (match.castForbidden === null || match.castForbidden.size === 0) return undefined;
  const players = match.view?.players ?? [];
  const viewer = players[0]?.id ?? null;
  return new Map([...match.castForbidden].map(([id, why]) => [id, castForbiddenTip(why, players, viewer)]));
}

/** This seat's held cards' tags, each with what its tooltip says. */
function heldTags(match: LiveMatch): ReadonlyMap<number, HeldTags> | undefined {
  if (match.heldChanges === null || match.heldChanges.size === 0) return undefined;
  return new Map(
    [...match.heldChanges].map(([id, h]) => [
      id,
      {
        ...(h.cost === undefined ? {} : { cost: { tokens: h.cost.now, change: h.cost.change, tip: costTip(h.cost) } }),
        ...(h.flashBy === undefined ? {} : { flash: flashTip(h.flashBy) }),
      },
    ]),
  );
}

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
  const viewer = viewerOf(match.view);
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
    for (const c of drawnCards(p)) add(c.card, c.id);
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
    for (const c of drawnCards(p)) add(c.card);
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
 *  - `data-log-type`, Forge's own `GameLogEntryType` for a line of its log.
 *  - `data-log-who`, `them` when the line opens with the OTHER seat's name:
 *    Forge's log names who did a thing first, so a line that opens with the
 *    opponent's name is their doing.
 *  - a card name is HOVERABLE and shows the card — THROUGH THE INSPECTOR, not a
 *    surface of its own (wave 31 P12: *"we shouldn't even create a separate hover
 *    display just use the existing one"*). The name carries `data-inspect-ids`:
 *    for a line of Forge's log, the id of the very card it names first; then
 *    the forge ids of every card of that name in the view; and
 *    `../inspect/index.ts` — which listens on the document — enlarges the tile the
 *    board already drew for the first of them. A name whose cards have no tile
 *    on the page (a zone the board draws as a count, a card hidden from this
 *    seat) shows NOTHING: that is the honest answer, and inventing a face for it
 *    would be the second surface again. The name is `tabindex`-reachable, and the
 *    inspector answers focus as it answers hover.
 *
 * Memoised ({@link sameLogLine}): Forge's log runs to hundreds of lines a game,
 * and the board re-renders on every frame and every gesture.
 */
interface LogLineProps {
  say: Say;
  cards: ReadonlyMap<string, DraftCard>;
  ids: ReadonlyMap<string, readonly number[]>;
  theirName: string | null;
}

const LogLine = memo(function LogLine({ say, cards, ids, theirName }: LogLineProps) {
  const text = plainRulesText(say.text);
  const mine = theirName === null || !text.startsWith(`${theirName} `);
  // A line of Forge's log names its cards by id: those, and only those, are the hover targets.
  const named = say.log === null ? null : new Map(say.log.cards.map((c) => [c.name.toLowerCase(), c]));
  const own = named === null ? cards : new Map([...named.values()].map((c) => [c.name.toLowerCase(), { name: c.name } as DraftCard]));
  const idsOf = (name: string): readonly number[] => {
    const key = name.toLowerCase();
    const ref = named?.get(key);
    return ref === undefined ? (ids.get(key) ?? []) : [ref.id, ...(ids.get(key) ?? []).filter((id) => id !== ref.id)];
  };
  return (
    <li data-log-kind={logKind(say)} data-log-type={say.log?.type} data-log-who={mine ? 'you' : 'them'}>
      {splitLogLine(text, own).map((piece, i) =>
        typeof piece === 'string' ? (
          <span key={i}>{piece}</span>
        ) : (
          <span
            key={i}
            className="live__log-card"
            data-log-card={piece.name}
            data-inspect-ids={idsOf(piece.name).join(',')}
            tabIndex={0}
          >
            {piece.name}
          </span>
        ),
      )}
    </li>
  );
}, sameLogLine);

/**
 * Whether a log line would draw the same again. A line of Forge's log reads the
 * view only for the ids of the cards it names, so a new view redraws it only when
 * one of those changed; any other line reads the whole view.
 */
function sameLogLine(a: LogLineProps, b: LogLineProps): boolean {
  if (a.say !== b.say || a.theirName !== b.theirName) return false;
  if (a.say.log === null) return a.cards === b.cards && a.ids === b.ids;
  return a.say.log.cards.every((c) => {
    const key = c.name.toLowerCase();
    const before = a.ids.get(key) ?? [];
    const after = b.ids.get(key) ?? [];
    return before.length === after.length && before.every((id, i) => id === after[i]);
  });
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

/** A rail row's name. */
function rowLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? (phase === COMBAT_ROW ? 'Combat' : phase);
}

/**
 * The name of the rail row after the current step's, the step passing priority on an empty stack moves to;
 * null off the rail. First-strike damage is never named: Forge runs that step only when a creature in the
 * combat has first strike, so the step after blockers is said as Combat damage.
 */
export function nextStepName(view: BoardView): string | null {
  const at = PHASE_ORDER.findIndex((p) => p.phase === view.phase);
  if (at < 0) return null;
  const rows = railRows(PHASE_ORDER[at]!.group === 'combat');
  const here = rows.findIndex((r) => r.last >= at);
  const next = rows.slice(here + 1).find((r) => r.phase !== 'COMBAT_FIRST_STRIKE_DAMAGE') ?? rows[0]!;
  return rowLabel(next.phase);
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
  // The cooldown outlives the change that armed it: an ordinary change after a crawl must not
  // cancel it, or nothing ever lifts the guard and the rail stops animating for good.
  const cooldown = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(cooldown.current), []);
  useEffect(() => {
    const now = performance.now();
    const previous = lastChangeAt.current;
    lastChangeAt.current = now;
    if (previous !== null && now - previous < CRAWL_GAP_MS) {
      setCrawling(true);
      clearTimeout(cooldown.current);
      cooldown.current = setTimeout(() => setCrawling(false), CRAWL_COOLDOWN_MS);
    }
    // `phase` (not `view`): a prop that changes on every state frame, combat or
    // not, would arm the cooldown for frames that never touch `data-combat` at
    // all (a target or a says-only update), re-arming the timer for no reason
    // this guard cares about.
  }, [phase]);
  return crawling;
}

/**
 * How long End Turn's "nothing left to decide" highlight stays on, unchanged,
 * before it escalates to the bigger nudge (`data-nudge`, `live.css`). The
 * operator, 2026-10-14: *"a bigger visual pulse after ~10s of being 'active'"*.
 */
export const END_TURN_NUDGE_MS = 10_000;

/**
 * True once `on` has held for `after` ms with every value in `state` unchanged
 * (compared by identity, `Object.is`). Any change — `on` dropping, or any
 * `state` entry changing while it holds — clears it at once, in that same
 * render, and starts the wait again from zero.
 */
export function useIdleNudge(on: boolean, state: readonly unknown[], after: number = END_TURN_NUDGE_MS): boolean {
  // Which unchanged span this render belongs to. Advanced during render, not in
  // an effect, so the render that sees a change already reads "not nudged".
  const span = useRef<{ on: boolean; state: readonly unknown[]; n: number }>({ on, state, n: 0 });
  const prev = span.current;
  if (prev.on !== on || prev.state.length !== state.length || prev.state.some((v, i) => !Object.is(v, state[i]))) {
    span.current = { on, state, n: prev.n + 1 };
  }
  const n = span.current.n;
  const [nudgedSpan, setNudgedSpan] = useState(-1);
  useEffect(() => {
    if (!on) return undefined;
    const id = setTimeout(() => setNudgedSpan(n), after);
    return () => clearTimeout(id);
  }, [on, n, after]);
  return on && nudgedSpan === n;
}

/**
 * Who the avatar ring says Forge is waiting on (`Board.tsx`'s `data-priority`,
 * `card.css`'s `.seat__ring`). The operator, 2026-10-13: *"the circle around
 * the avatar should indicate priority."*
 *
 * Not Forge's raw per-frame `HasPriority`: that ping-pongs through every
 * auto-passed priority exchange whether or not either seat is being asked
 * anything (*"i notice priority flashing back and forth in
 * untap/upkeep/draw... can you unify that behavior"*, measured in
 * `docs/planning/wave63-evidence/F/flash.md`). And not Forge's priority player
 * either: while the defender declares blockers, Forge's priority player is
 * still the attacker (`PhaseHandler.java` hands priority to the turn player
 * before it advances a step, and `InputBlock` runs in the new step's begin,
 * before anyone is given priority), but the seat it is waiting on is the
 * defender.
 *
 * So each player's `hasPriority` is replaced by `match.ts`'s own
 * `genuinelyAsked(match, seat, …)`, which the caller passes for both
 * arguments: the viewer's own open decision or live bar, and the server's
 * "waiting for them" fact for the opponent — a fact on the seats channel the
 * pacer never holds, so it is not ~4.8 s late behind an End Turn crawl's phase
 * frames the way a state delta is. The two are mutually exclusive, so at most
 * one ring is ever lit, and an auto-passed window lights none. `view` itself,
 * unchanged, when nothing needs correcting.
 */
export function withGatedPriority(view: BoardView, viewerOpen: boolean, opponentOpen: boolean): BoardView {
  let changed = false;
  const players = view.players.map((p) => {
    const want = p.isViewer ? viewerOpen : opponentOpen;
    if (p.hasPriority === want) return p;
    changed = true;
    return { ...p, hasPriority: want };
  });
  return changed ? { ...view, players } : view;
}

/**
 * The stop a click on a rail row puts the seat's stop on: the row's own — `COMBAT` for the collapsed
 * row, whose step the server picks by whose turn it fires on (`stopStep`). Null for Untap and Cleanup,
 * where Forge opens no window to stop in.
 */
function stopPhaseOf(row: string): StopPhase | null {
  const parsed = StopPhaseSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the rail row stands for the seat's pending stop: the collapsed row holds any combat stop; with
 * combat drawn as its six steps, a `COMBAT` stop is on the step it holds this turn.
 */
function rowHoldsStop(row: string, stop: StopPhase | null, myTurn: boolean): boolean {
  if (stop === null) return false;
  if (row === COMBAT_ROW) return stop === COMBAT_ROW || PHASE_ORDER.some((p) => p.phase === stop && p.group === 'combat');
  return row === stop || (stop === COMBAT_ROW && row === stopStep(stop, myTurn));
}

/**
 * The phase rail. Turn, step and whose turn all come off — turn, step and whose turn all come off
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
 *
 * **A row is also where the seat puts its one-shot stop** (`setPhaseStop`): a
 * click holds the seat's priority the next time that phase comes round, on
 * either turn, and the server clears it once spent. The pending stop is
 * `data-stop` on its row; a second click clears it. A spectator's rail takes no
 * click.
 */
function PhaseRail({ view, stop, onStop }: { view: BoardView; stop: StopPhase | null; onStop: ((phase: StopPhase | null) => void) | null }) {
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
          const target = onStop === null ? null : stopPhaseOf(phase);
          const marked = rowHoldsStop(phase, stop, whose === 'yours');
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
              data-stop={marked ? '' : undefined}
              data-tip={marked ? 'Your stop: the game waits for you at this step' : undefined}
              data-stoppable={target === null ? undefined : ''}
              onClick={target === null ? undefined : () => onStop?.(marked ? null : target)}
            >
              <span className="live__step-name">{rowLabel(phase)}</span>
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
  return (
    <div
      className="live__ask"
      data-testid="live-concede-ask"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <ConfirmPrompt
        testId="live-concede-sheet"
        role="alertdialog"
        title="Concede"
        message="You lose this game."
        button1={{ label: 'Concede', enabled: true, testId: 'live-concede-yes', danger: true, onClick: onConcede }}
        button2={{ label: 'Cancel', enabled: true, testId: 'live-concede-no', isDefault: true, onClick: onCancel }}
      />
    </div>
  );
}

/* ── A payment is a question (wave 25 §C.2) ──────────────────────────── */

/**
 * The pop-up's OK while the seat declares attackers or blockers says what pressing it does —
 * Forge's own label there is a bare "OK", which read as unclear in play. Only the declaration
 * itself: once it is made, the same step's priority stop is a pass (`passLabel`), not a
 * declaration, though the phase has not moved.
 */
function combatDoneLabel(match: LiveMatch, route: BarRoute): string | null {
  if (route !== 'decision') return null;
  if (declaringAttackers(match)) return 'Done Attacking';
  if (declaringBlockers(match)) return 'Done Blocking';
  return null;
}

/**
 * The priority pass's button names what the player agrees to (the operator, 2026-10-24: *"we want our words
 * to be very consistent here about what the player is actually agreeing to"*): `Next Phase` with the stack
 * empty, `Resolve` with something on it. Null for every other bar, which keeps Forge's own label.
 */
function passLabel(route: BarRoute): string | null {
  if (route === 'pass') return 'Next Phase';
  return route === 'resolve' ? 'Resolve' : null;
}

/* ── "All": a macro for the drag, not a new way to attack ─────────────── */

/**
 * The operator, 2026-10-26: *"all attack button on all attackers"*, then *"lets just do 'All' but
 * even when All is clicked we should still be able to manually change the attackers afterwards. All
 * should essentially just function as a macro for dragging the arrows in one click"* — one press
 * declares every legal attacker against the DEFENDING PLAYER (never a planeswalker or battle, even
 * where one is a legal defender), and every arrow it draws stays as editable as one dragged by hand.
 *
 * So this sends nothing of its own: `combatCandidates` is Forge's own actionable set for
 * `InputAttack` (already excluding summoning-sick/no-haste/tapped/already-attacking creatures — the
 * same set `data-selectable` draws from), and `attackWith` (`gestures/commit.ts`) is the exact
 * function a drag's release and a box's aim both call, filtered through `attackAssignment` so only
 * an `'assign'` (never an `'already'`) leaves. A creature "All" cannot legally send is a creature a
 * drag could not have sent either.
 *
 * Null while declare-attackers is not open, or while there is nobody left to declare — the caller
 * uses that to leave button2 undrawn rather than offering a press that would do nothing.
 */
function attackAllTarget(match: LiveMatch): { defenderId: number; ids: number[] } | null {
  if (!declaringAttackers(match)) return null;
  const defender = opponentOf(match.view);
  if (defender === undefined) return null;
  const ids = [...combatCandidates(match)].filter((id) => attackAssignment(match, id, { kind: 'player', id: defender.id }) === 'assign');
  return ids.length === 0 ? null : { defenderId: defender.id, ids };
}

/** Send every id `attackAllTarget` named against the defending player — the drag path's own `playRole('ui.target')` (`commit.ts`), since this bypasses the drag that would otherwise play it. */
function attackAll(match: LiveMatch, target: { defenderId: number; ids: number[] }): void {
  playRole('ui.target');
  attackWith(match, target.ids, { kind: 'player', id: target.defenderId });
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
 * A cost Forge lets the payer pay with life (a Phyrexian shard, black mana
 * under "pay life instead", or Channel's life-for-{C}) gets a third button,
 * labelled with what one press pays: `payWithLife`, one shard or one activation
 * per press, refused while the last press is unanswered.
 *
 * No title. Forge's message is the question, and a heading here would be this
 * lane inventing a word for a window whose whole point is that it says what
 * Forge said.
 */
function PaymentWindow({ match }: { match: LiveMatch }) {
  const messageId = useId();
  const bar = liveBar(match);
  const { question, context } = promptLines(match.prompt ?? '', match.promptParts, match.promptTrigger !== null);
  return (
    <QuestionHost data-testid="live-payment-host">
      <section className="confirm live__payment" data-testid="live-payment" role="dialog" aria-labelledby={messageId}>
        <p className="confirm__message" id={messageId}>
          <RulesText text={question} />
        </p>
        {context !== null && (
          <p className="confirm__context" data-testid="prompt-source-text">
            <RulesText text={context} />
          </p>
        )}
        <AnswerRow
          aside={
            lifePayable(match) && (
              <button
                type="button"
                className="button confirm__button"
                data-testid="live-payment-life"
                disabled={bar === null || lifePayer(match) === null}
                onClick={() => payWithLife(match)}
              >
                <ManaPip token="P" /> {lifePerPress(match)} life
              </button>
            )
          }
        >
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
        </AnswerRow>
      </section>
    </QuestionHost>
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
 * ## How it ended — Forge's own reason
 *
 * The end notice (`finishGame`'s `lost`, `LiveMatch.lost`) carries why each
 * loser lost as Forge decided it (`PlayerOutcome.lossState`), and the sentence
 * words that rule: a player who had to draw with no library left lost to the
 * draw, which is worth saying when a deck that replaces draws (Dredge needs at
 * least its number of cards in the library) is not offered the replacement.
 * A notice without it (written by an older bridge, replayed on resume) falls
 * back to the board: life at or below zero, ten-plus poison counters, an empty
 * library, and otherwise a concede.
 */
export type GameOutcome = 'victory' | 'defeat' | 'draw';

/** Victory/Defeat/Draw, from the viewer's own side. `null` while the game is not over. */
export function gameOutcome(match: LiveMatch): GameOutcome | null {
  const view = match.view;
  // The server's `finishGame` (`match.finished`) is the certain signal; the view's
  // `GameOver` is the same fact when its delta happens to arrive (see
  // `LiveMatch.finished`). Either one ends the game here.
  if (view === null || !(view.gameOver || match.finished)) return null;
  const losers = lostPlayers(match, view);
  const viewerLost = losers.some((p) => p.isViewer);
  const opponentLost = losers.some((p) => !p.isViewer);
  if (viewerLost === opponentLost) return 'draw';
  return viewerLost ? 'defeat' : 'victory';
}

/** The ways the board alone can tell a game ended, for a notice that does not say. */
export type GameEndReason = 'life' | 'poison' | 'decking' | 'concede';

/** Forge's `GameLossReason` names, each as the rule that ended the game. */
const LOSS_WORDS: Readonly<Partial<Record<string, (source: string | undefined) => string>>> = {
  LifeReachedZero: () => 'life total reached 0',
  Poisoned: () => '10 or more poison counters',
  Milled: () => 'had to draw from an empty library',
  Conceded: () => 'conceded',
  SpellEffect: (source) => (source === undefined ? 'lost to an effect' : `lost to ${source}`),
  OpponentWon: (source) => (source === undefined ? 'an opponent won' : `an opponent won with ${source}`),
  CommanderDamage: () => '21 or more commander damage',
  IntentionalDraw: () => 'agreed to a draw',
};

const BOARD_REASON: Readonly<Record<GameEndReason, string>> = {
  life: 'LifeReachedZero',
  poison: 'Poisoned',
  decking: 'Milled',
  concede: 'Conceded',
};

/** Why THIS player lost, read off facts already on their `BoardPlayer`. Exported for its own test. */
export function reasonLost(player: BoardPlayer): GameEndReason {
  if (player.life <= 0) return 'life';
  if (poisonOf(player) >= POISON_TO_LOSE) return 'poison';
  if (player.libraryCount === 0) return 'decking';
  return 'concede';
}

/**
 * Who lost: the end notice's own list when it carries one (`LiveMatch.losers` — this view may never
 * have caught up with the end), each player's `hasLost` otherwise.
 */
function lostPlayers(match: LiveMatch, view: BoardView): BoardPlayer[] {
  return view.players.filter((p) => (match.losers === null ? p.hasLost : match.losers.has(p.id)));
}

/** One sentence per loser (almost always one; a double-loss draw gets both). `null` when nobody lost. */
export function endingSentence(match: LiveMatch, view: BoardView): string | null {
  const losers = lostPlayers(match, view);
  if (losers.length === 0) return null;
  return losers
    .map((p) => {
      const loss = match.lost?.get(p.id);
      const words = LOSS_WORDS[loss?.reason ?? BOARD_REASON[reasonLost(p)]];
      return words === undefined ? p.name : `${p.name} — ${words(loss?.source)}`;
    })
    .join(' · ');
}

const OUTCOME_TITLE: Readonly<Record<GameOutcome, string>> = {
  victory: 'Victory',
  defeat: 'Defeat',
  draw: 'Draw',
};

/**
 * A player's face, for the result screen. Not `Board.tsx`'s `PlayerFace`
 * (unexported, and drawn for a different job — a clickable target with a life
 * badge): the same `Avatar`, sized by `live.css`.
 *
 * `rematch`: this player has pressed Rematch — a check over their face.
 */
function ResultFace({ player, rematch }: { player: BoardPlayer; rematch: boolean }) {
  return (
    <div className="live__result-face" data-testid="game-result-face" data-you={player.isViewer} data-lost={player.hasLost || undefined}>
      <span className="live__result-portrait">
        <Avatar id={player.avatarId} fallback="mark" className="live__result-avatar" fallbackClassName="live__result-avatar" />
        {rematch && (
          <span className="live__result-check" data-testid="game-result-check" role="img" aria-label="Rematch">
            <CheckMark className="live__result-tick" />
          </span>
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
/**
 * The table's next game, once its players have agreed: against the AI the one
 * player's Ready is the agreement. The result screen and the pod room's own
 * sideboard step (`screens/TableSideboard.tsx`) both ask; the server joins
 * two asks for one table into one start.
 */
export function startNextGame(tables: TablesClient, roomId: string, tableId: string | undefined, solo: boolean): Promise<StartOutcome> {
  const start = solo ? tables.startVsBot : tables.startRoom;
  return tableId === undefined ? start(roomId) : start(roomId, tableId);
}

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
 * **Back to room** opens the room's own screen and changes nothing at its
 * table: you stay a member, seated with the deck you played and not ready, so
 * the other screen's Rematch still has you to agree with — readying in the room
 * is the same Ready.
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
 * ready at: Rematch and Back to room are
 * disabled and Main menu goes straight to the lobby.
 *
 * **Series on screen.** Every Constructed series starts as Bo1, and the
 * Rematch agreement is what converts it to Bo3 and MOVES the table to
 * `sideboarding` (`lobby.ts`'s `beginSideboarding`, from `done`); a Bo3
 * reaches `sideboarding` on its own, the instant an undecided game ends
 * (`recordGameResult`). Either way `showSideboard` tracks `phase ===
 * 'sideboarding'` alone, so the sideboard step appears with no second press.
 * Between the games of a series that does not sideboard (`between`, a
 * Gauntlet) the button reads `Next game`, and the next game is set up in the
 * room (a Gauntlet's secret choice of decks), so it opens the room as Back to
 * room does and readies nothing: the room starts that game once it is set up
 * (the operator, 2026-10-21: *"when players select 'Next Game' it should take
 * them back to the deck picker"*). **In a pod room there is no Rematch at
 * all** (`room.pod !== null`), nor once a Gauntlet is decided — Back to room already opens the pod
 * (`#/room/<id>` renders `PodScreen` for a draft room), so there is nothing
 * else for this button to do.
 */
/** The sounds of a permanent leaving the battlefield: each waits for the first exit drawn. */
const EXIT_ROLES: ReadonlySet<string> = new Set(['g.dies', 'g.destroy', 'g.exile', 'g.bounce']);

/** The game's own end: its sound is the result screen's, and plays with it (`useAfterTheBoard`). */
const END_ROLES: ReadonlySet<string> = new Set(['g.win', 'g.lose']);

/**
 * The sounds a hit is the cause of wait for the hit (`motion.ts`'s beat clock, written by `numbers.ts`
 * in the same commit): a life total's, until the first hit on a player lands; a creature's damage,
 * until the first hit on a card lands; a permanent leaving, until the first exit starts.
 */
function afterTheHits(events: readonly DelayedSoundEvent[], seq: number): DelayedSoundEvent[] {
  const now = Date.now();
  const life = lifeImpactAt(seq);
  const card = cardImpactAt(seq);
  const exit = exitBeatAt(seq);
  return events.map((e) => {
    const until =
      e.role === 'g.damage-player' || e.role === 'g.lifegain' ? life : e.role === 'g.damage' ? card : EXIT_ROLES.has(e.role) ? exit : null;
    return until === null || until <= now ? e : { ...e, delayMs: Math.max(e.delayMs ?? 0, until - now) };
  });
}

/** The sounds only the board's drawing knows the moment of (a ram's charge and blow, a spell's hit, a creature cracking), each on its beat. */
function fromTheBoard(seq: number): DelayedSoundEvent[] {
  const now = Date.now();
  return boardSoundsAt(seq).map((s) => ({ role: s.role, seat: s.mine ? 'me' : 'opp', intensity: s.intensity, colourCell: s.colourCell ?? null, delayMs: Math.max(0, s.at - now) }));
}

/**
 * How long the result screen waits for the frame that shows the end (`GameOver`) after the server's notice
 * (`finishGame`) before it goes up without it. The bridge sends the notice first; measured on a busy claw,
 * that frame came 0 to 480 ms behind it (`e2e/cp-lethal-blow.spec.ts`). An end no frame shows at all (a
 * concede during the deal, whose winner Forge never flushes to) is shown this late instead of never.
 */
export const END_UNSHOWN_MS = 2_000;

/** How long the result screen waits for its table and room to agree before it shows anyway. */
export const RESULT_SETTLE_MS = 4_000;

/**
 * Whether the game has ended on this screen: the view shows it — the frame that carries the killing
 * blow — or the server's notice came and no frame showed it within `END_UNSHOWN_MS`. Never the notice
 * alone: it arrives ahead of the blow it announces, and the frames reach the board in the server's order
 * (`pace.ts`'s "The game's end keeps its place").
 */
function useGameEnded(match: LiveMatch): boolean {
  const shown = match.view?.gameOver === true;
  const finished = match.finished;
  const [unshown, setUnshown] = useState(false);
  useEffect(() => {
    if (!finished || shown) {
      setUnshown(false);
      return undefined;
    }
    const timer = setTimeout(() => setUnshown(true), END_UNSHOWN_MS);
    return () => clearTimeout(timer);
  }, [finished, shown]);
  return match.view !== null && (shown || unshown);
}

/**
 * The game's end is the board's last beat: the result screen comes once the board has drawn what ended
 * the game — the bolt that took the last life lands (the operator, 2026-10-15), the last attacker's
 * charge lands and comes home (2026-10-17) — and at once when nothing is playing.
 */
function useAfterTheBoard(over: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!over) {
      setShown(false);
      return undefined;
    }
    return whenBoardStill(() => setShown(true));
  }, [over]);
  return shown;
}

/** The viewer's own held choice at this table — the editor's starting point. */
export function myChoice(table: RoomTable | null): SeatChoice | null {
  return table?.players.find((p) => p.you)?.deck?.choice ?? null;
}

/**
 * THIS match's own table, in a room that may hold several (a pod). Matched
 * by `matchId` while the game is live, or by `series.games[].matchId` once it
 * has ended — `recordGameResult` clears `table.matchId` the instant a game is
 * recorded (wave 72 §P's eager series), so by the time this screen is even
 * drawn the table it belongs to no longer says so directly. Falls back to
 * `tables[0]` only when neither matches (a constructed 1v1 room never has a
 * second table to confuse this with; the fallback is for a room this screen
 * has not yet read, not for a real ambiguity).
 */
function findMyTable(room: RoomView | null, matchId: string): SharedRoomTable | null {
  if (room === null) return null;
  const found = room.tables.find((t) => t.matchId === matchId || t.series.games.some((g) => g.matchId === matchId));
  return found ?? room.tables[0] ?? null;
}

/**
 * The player's current 75, as `.dck` text. The wire only ever hands this
 * screen a REFERENCE to a library pick (`choice.deck.library`, an id), never
 * the deck's own lines, so that half resolves through the catalogue
 * (`GET /tables/decks`) and `libraryDeckText` — the same two-step `DeckScreen`
 * and the room's own picker already take. A drafted pick already carries its
 * text directly.
 */
async function my75Text(choice: SeatChoice, tables: TablesClient): Promise<string | null> {
  const ref = choice.deck;
  if ('dck' in ref) return ref.dck;
  const decks = await tables.decks();
  const found = decks.find((d) => d.id === ref.library);
  return found === undefined ? null : libraryDeckText(found.name, found.main, found.sideboard);
}

/**
 * The sideboard step between two games of a series (wave 72 §Q.4):
 * `DeckEditor` in `sideboard` mode over the player's own 75 — the drafted
 * pool, or a library deck's main plus `[Sideboard]`, resolved by
 * {@link my75Text} either way into the SAME `.dck` text `DeckEditor`'s own
 * `savedDeck` load already knows how to open. It takes the whole match box,
 * not a dialog: it is the same editor a build uses, piles and all.
 *
 * **Faces:** a drafted 75 draws from the drafter's own pool
 * (`GET /api/drafts/:podId/mine`, the cards with their type lines and costs);
 * a library 75, or a pool that read fails, degrades to `namedCardPool` — a
 * cost and art per name from the browser's own tables, the same path
 * `ConstructedScreen.tsx`'s deck peek draws a library card through.
 *
 * **The floor:** a drafted deck's is 40, and basics are free (the server's
 * own sideboard check excludes them on a drafted pool). A constructed 75 has
 * no counters, and its floor is its own opening main deck, up to 60 — the
 * step only re-splits, so it can never ask for more than the deck began with.
 *
 * **Ready is the editor's own way onward**, offered once the deck is at its
 * floor, and it submits the split the editor hands it: `PUT …/deck`, then
 * `ready(true)`. A refusal (the server's 75 check, or the start gate) shows
 * as its own sentence above the editor.
 */
/**
 * What the sideboard step draws from — my 75 and, for a drafted deck, the
 * drafted pool — read BEFORE the step is shown, so it opens whole rather than
 * as a loading box that turns into an editor. `undefined` while either is
 * still being read; `null` choice reads nothing.
 */
export function useSideboardInputs(
  choice: SeatChoice | null,
  tables: TablesClient,
): { text: string | null; draftPool: DraftCard[] | null } | undefined {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (choice === null) return;
    let live = true;
    my75Text(choice, tables).then((t) => {
      if (live) setText(t);
    });
    return () => {
      live = false;
    };
  }, [choice, tables]);

  const draftId = choice !== null && choice.rules.kind === 'draft' ? choice.rules.draftId : null;
  const [draftPool, setDraftPool] = useState<DraftCard[] | null | undefined>(undefined);
  useEffect(() => {
    if (draftId === null) return;
    let live = true;
    deckStoreClient()
      .mine(draftId)
      .then(
        (mine) => {
          if (live) setDraftPool(mine?.pool ?? null);
        },
        () => {
          if (live) setDraftPool(null);
        },
      );
    return () => {
      live = false;
    };
  }, [draftId]);

  if (choice === null || text === undefined || (draftId !== null && draftPool === undefined)) return undefined;
  return { text, draftPool: draftPool ?? null };
}

export function SideboardStep({
  roomId,
  tableId,
  tables,
  choice,
  inputs,
}: {
  roomId: string;
  /** This match's own table (`GameResultScreen`'s `findMyTable`) — a pod's table 2+, never `tables[0]` by default. */
  tableId: string | undefined;
  tables: TablesClient;
  choice: SeatChoice;
  /** Read by `GameResultScreen` before it shows anything (`useSideboardInputs`). */
  inputs: { text: string | null; draftPool: DraftCard[] | null };
}) {
  const { text, draftPool } = inputs;
  const draftId = choice.rules.kind === 'draft' ? choice.rules.draftId : null;

  const parsed = useMemo(() => (typeof text === 'string' ? deckFromDeckFile(parseDck(text)) : null), [text]);
  const pool = useMemo(
    () => draftPool ?? (parsed === null ? [] : namedCardPool([...parsed.main, ...parsed.sideboard].map((e) => e.card.name))),
    [draftPool, parsed],
  );
  const [readyState, setReadyState] = useState<ReadyState>('idle');
  const [refusal, setRefusal] = useState<string | null>(null);

  if (text === null || parsed === null) {
    return (
      <p className="ct-error live__error" role="alert" data-testid="sideboard-unavailable">
        Could not find your deck to sideboard.
      </p>
    );
  }

  const onReady = (deck: Deck): void => {
    setReadyState('busy');
    setRefusal(null);
    const refuse = (reason: string): void => {
      setReadyState('idle');
      setRefusal(reason);
    };
    const onFailure = (err: unknown): void => refuse(err instanceof Error ? err.message : String(err));
    const deckBody = { dck: dckTextOf(deck) };
    (tableId === undefined ? tables.loadDeck(roomId, deckBody) : tables.loadDeck(roomId, deckBody, tableId)).then((loaded) => {
      if (!loaded.ok) {
        refuse(loaded.error);
        return;
      }
      (tableId === undefined ? tables.ready(roomId, true) : tables.ready(roomId, true, tableId)).then((answer) => {
        if (answer.ok) setReadyState('ready');
        else refuse(answer.error);
      }, onFailure);
    }, onFailure);
  };

  const openingMain = parsed.main.reduce((n, e) => n + e.count, 0);
  return (
    <section className="sideboard-step" data-testid="sideboard-step">
      {refusal !== null && (
        <p className="ct-error live__error" role="alert" data-testid="sideboard-refusal">
          {refusal}
        </p>
      )}
      <DeckEditor
        mode="sideboard"
        draftId={roomId}
        pool={pool}
        savedDeck={text}
        allowBasics={draftId !== null}
        minMain={draftId !== null ? LIMITED_MIN_MAIN_DECK_SIZE : Math.min(CONSTRUCTED_LIMITS.minMainDeckSize, openingMain)}
        onReady={onReady}
        readyState={readyState}
      />
    </section>
  );
}

/**
 * The two ways off a match that is over: Back to room, and Main menu (which leaves the room). The
 * result screen and the ended notice both end in them.
 */
function useMatchExits(roomId: string | null): { leaving: boolean; onBackToRoom: () => void; exits: ReactNode } {
  const [leaving, setLeaving] = useState(false);
  // The room itself (the operator, 2026-10-23: back in the room mid-series, "a small box that lets me return"
  // to the table, not the sideboard step there); the table's page is one press from it.
  const onBackToRoom = (): void => {
    if (roomId !== null) navigate({ kind: 'room', roomId });
  };
  const onMainMenu = (): void => {
    setLeaving(true);
    const left: Promise<unknown> = roomId === null ? Promise.resolve() : roomsClient().leave(roomId);
    void left.finally(() => navigate({ kind: 'lobby' }));
  };
  const exits = (
    <>
      <button type="button" className="button" data-testid="game-result-room" disabled={roomId === null || leaving} onClick={onBackToRoom}>
        Back to room
      </button>
      <button type="button" className="button" data-testid="game-result-menu" disabled={leaving} onClick={onMainMenu}>
        Main menu
      </button>
    </>
  );
  return { leaving, onBackToRoom, exits };
}

/**
 * A match that ended with no game result — its JVM died, the server is stopping, anything that ends
 * it from outside the game: the server's own words over the board, and the ways off it. Every such
 * ending reaches the screen as the one notice (`LiveMatch.ended`), so this is the one screen for all
 * of them. Drawn like the result screen, which a game that did finish gets instead.
 */
function MatchEndedNotice({ ended, roomId }: { ended: { title: string; message: string }; roomId: string | null }) {
  const titleId = useId();
  const { exits } = useMatchExits(roomId);
  return (
    <section className="board__over" data-testid="match-ended" role="alertdialog" aria-labelledby={titleId}>
      <div className="confirm live__result">
        <h2 className="confirm__title" id={titleId}>
          {ended.title}
        </h2>
        <p className="confirm__message live__result-ending">{ended.message}</p>
        <div className="confirm__actions answers">{exits}</div>
      </div>
    </section>
  );
}

function GameResultScreen({ match, roomId }: { match: LiveMatch; roomId: string | null }) {
  const view = match.view!;
  const outcome = gameOutcome(match)!;
  const viewer = viewerOf(view);
  const opponent = opponentOf(view);
  const ending = endingSentence(match, view);
  const titleId = useId();
  const { leaving, onBackToRoom, exits } = useMatchExits(roomId);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [table, setTable] = useState<RoomTable | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [alone, setAlone] = useState<boolean | null>(null);
  const [tables] = useState(tablesClient);
  /** A start is in flight: not asked again on every read. */
  const asked = useRef(false);
  const rematch = rematchOf(table, alone === true);

  /**
   * THIS match's own table (wave 71 §D's wire shape, via `@hadoku/shared`) —
   * for `series.phase` and `pod`,
   * none of which `./tables.ts`'s own `RoomTable` (`table`, above) carries,
   * and — in a pod — for the table id every `tables.ts` call below now
   * passes, so a pod player's table 2+ is never addressed as `tables[0]`.
   * See {@link findMyTable}.
   */
  const myTable = findMyTable(room, match.matchId);
  const tableId = myTable?.id;
  const phase = myTable?.series.phase ?? null;
  /**
   * No Rematch in a pod (wave 72 §Q.3), a pod of one against the AI included:
   * Back to room opens the pod, whose rounds decide who plays whom, and whose
   * standings follow the last game. A Rematch there started a new series at a
   * finished table, for ever (the operator, 2026-10-19: *"it seems like it just
   * lets me keep clicking 'next game' forever"*).
   */
  const inPod = room !== null && room.pod !== null;
  /**
   * A Gauntlet is never rematched: between its games the button is Next game,
   * and once it is decided the next Gauntlet is set up in the room (the
   * operator, 2026-10-21: *"when match is finished don't show 'rematch' button"*).
   */
  const rematchable = !inPod && room?.mode !== 'gauntlet';
  /**
   * A room change (mode, pool) since this game interrupted its series: the
   * table is back to a fresh `seating` series without it (ruling 14). Its
   * players stay seated (AF344), so a Rematch would play the new rules on
   * decks that were dropped.
   */
  const interrupted =
    myTable !== null && myTable.series.phase === 'seating' && myTable.matchId !== match.matchId && !myTable.series.games.some((g) => g.matchId === match.matchId);
  /**
   * The table id the reads below address — a ref, not state, because the
   * table-scoped read inside the SAME refresh cycle that learns it has to
   * use what THIS cycle just learned, not last render's.
   */
  const myTableIdRef = useRef<string | undefined>(undefined);

  /**
   * What the table looked like at the last room read — so the next one is
   * skipped unless something actually moved. `aa-polling.spec.ts`'s idle
   * budget (`e2e/aa-polling.spec.ts`, "idle result screen reads the room at
   * most a few times a minute") was written for a screen that read ONE
   * thing per `roomFeed` tick (the table); reading the ROOM too on every
   * tick doubled it. `ready`/`matchId`/`locked`/`phase` are exactly the
   * fields a change worth re-checking the room for would also move — an
   * agreement, a game starting or ending, the table moving into
   * `sideboarding`. `phase` is not optional here: the agreement that begins
   * sideboarding spends both Readys, so a screen that never saw the other
   * press reads the same flags before and after it. A
   * genuinely idle tick (the fallback timer firing with nothing changed)
   * reads this SAME signature and skips the room — the idle case the spec
   * measures never pays the extra read.
   */
  const lastTableSignature = useRef<string | null>(null);

  /** The last room read, for the next tick to compare the table against. */
  const roomRef = useRef<RoomView | null>(null);
  /** A room read has answered — a room, or the server's 404 for one it will not admit to. */
  const [roomAnswered, setRoomAnswered] = useState(false);
  /** The table's reads and this screen's own Rematch writes of it, latest-wins (`../../rooms/latest.ts`). */
  const [tableReads] = useState(latestReads);
  useEffect(() => {
    if (roomId === null) return;
    let live = true;
    // This screen writes no room, so a room read is kept or dropped.
    const roomReads = latestReads();
    /** False when a newer room read overtook this one: that one decides, and the tick that sent this stops. */
    const refreshRoom = (): Promise<boolean> => {
      const landed = roomReads.read();
      return roomsClient()
        .get(roomId)
        .then(
          (answer) => {
            if (!live || landed() !== 'keep') return false;
            setRoomAnswered(true);
            if (answer === null) return true;
            roomRef.current = answer;
            setRoom(answer);
            myTableIdRef.current = findMyTable(answer, match.matchId)?.id;
            return true;
          },
          () => {
            if (!live || landed() !== 'keep') return false;
            setRoomAnswered(true);
            return true;
          },
        );
    };
    const tick = async (): Promise<void> => {
      // The room first, once: it says which of the room's tables is this
      // match's. A table read without it is the room's FIRST table — in a pod,
      // one nobody plays at.
      if (roomRef.current === null && !(await refreshRoom())) return;
      const landed = tableReads.read();
      const answer = await tables.table(roomId, myTableIdRef.current).catch(() => null);
      if (!live) return;
      const verdict = landed();
      if (verdict === 'drop') return;
      if (verdict === 'reread') {
        void tick();
        return;
      }
      // Unreachable for a moment: the last answer stays on screen and the next read asks again.
      if (answer === null || !answer.ok) return;
      setTable(answer.table);
      setAlone((was) => was ?? answer.table.players.length === 1);
      const signature = JSON.stringify({
        matchId: answer.table.room.matchId,
        locked: answer.table.room.locked,
        phase: answer.table.room.phase,
        players: answer.table.players.map((p) => ({ ready: p.ready, legal: p.deck?.legal })),
      });
      // The room again when the table moved, or when the last room read is
      // behind it: read before the game was recorded, it still says `playing`
      // while the table is `sideboarding` — and the sideboard step never opened
      // (w72-pod, claw run 39207516746; the operator's own pod, 2026-10-19).
      const behind = roomRef.current !== null && findMyTable(roomRef.current, match.matchId)?.series.phase !== answer.table.room.phase;
      if (signature !== lastTableSignature.current || behind) {
        lastTableSignature.current = signature;
        await refreshRoom();
      }
    };
    const stopFollowing = roomFeed().follow({ room: roomId }, () => void tick());
    return () => {
      live = false;
      stopFollowing();
    };
  }, [roomId, tables, tableReads, match.matchId]);

  /**
   * Nothing is drawn until what it would show is settled (the operator,
   * 2026-10-19: *"never show UI until its ready"* — a Rematch that flashed and
   * turned into something else): the table read, and a room read that has
   * answered and, when it found the room, agrees with the table on this
   * table's phase. A server that never lets them agree still gets the screen,
   * late, rather than none.
   */
  const showSideboard = phase === 'sideboarding';
  // By content: every table read is a fresh object, and the 75 is read once per choice, not once per read.
  const choiceKey = showSideboard ? JSON.stringify(myChoice(table)) : null;
  const sideboardChoice = useMemo(() => (choiceKey === null ? null : (JSON.parse(choiceKey) as SeatChoice | null)), [choiceKey]);
  const sideboardInputs = useSideboardInputs(sideboardChoice, tables);
  const settled =
    roomId === null ||
    (table !== null &&
      roomAnswered &&
      (myTable == null || myTable.series.phase === table.room.phase) &&
      // The sideboard step opens whole: its 75 (and drafted pool) already read.
      (!showSideboard || myChoice(table) === null || sideboardInputs !== undefined));
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setWaitedOut(true), RESULT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settled]);
  // Only the first showing waits: once up, the screen stays up while a later
  // read catches the room up, rather than vanishing and coming back.
  const shownOnce = useRef(false);
  if (settled || waitedOut) shownOnce.current = true;

  // The room's next match, whichever screen asked for it.
  const next = table?.room.matchId ?? null;
  useEffect(() => {
    if (next !== null && next !== match.matchId) openNewMatch(next);
  }, [next, match.matchId]);

  const refused = (error: string): void => {
    asked.current = false;
    setBusy(false);
    setRefusal(error);
  };
  const started = (answer: StartOutcome): void => {
    if (answer.ok) openNewMatch(answer.matchId);
    else refused(answer.error);
  };
  const unreachable = (err: unknown): void => refused(err instanceof Error ? err.message : String(err));

  // Against the AI there is nobody to agree with: my sideboard step's Ready
  // is the whole agreement, and the next game is the bot's.
  const soloNext = alone === true && rematch.mine && phase === 'sideboarding';
  useEffect(() => {
    if ((!rematch.agreed && !soloNext) || roomId === null || asked.current) return;
    asked.current = true;
    startNextGame(tables, roomId, tableId, soloNext).then(started, unreachable);
  }, [rematch.agreed, soloNext, roomId, tables, tableId]);

  const onRematch = (): void => {
    if (roomId === null) return;
    setRefusal(null);
    setBusy(true);
    // The agreement (`beginSideboarding`'s own door, server-side). Once every
    // seat has pressed it a finished Bo1 converts and the table moves to
    // `sideboarding`, and the sideboard step below appears on its own the
    // moment `phase` says so — no second press. Against the AI the one press
    // is the agreement: a series that did not convert starts the next bot game.
    const ready = alone === true || !rematch.mine;
    tables.ready(roomId, ready, tableId, ready ? { rematch: true } : undefined).then((answer) => {
      if (!answer.ok) {
        setBusy(false);
        setRefusal(answer.error);
        return;
      }
      tableReads.wrote();
      setTable(answer.table);
      if (alone !== true || answer.table.room.phase === 'sideboarding') {
        setBusy(false);
        return;
      }
      asked.current = true;
      tables.startVsBot(roomId, tableId, { rematch: true }).then(started, unreachable);
    }, unreachable);
  };

  /** The next game is set up in the room, not agreed here (`between`). */
  const nextInRoom = phase === 'between';

  const choice = myChoice(table);
  /**
   * The outcome is shown first, and Next opens the sideboard step — the
   * operator, 2026-10-19: *"victory screen should show when winning a match in
   * pod. it seems to immediately go into sideboarding. let's let the player
   * click 'next' which takes them to side-boarding."*
   */
  const [nextPressed, setNextPressed] = useState(false);

  if (!shownOnce.current) return null;

  // Between games the result gives way to the sideboard step, which takes
  // the whole match box: the outcome shrinks to a line above the editor.
  if (showSideboard && nextPressed && roomId !== null && choice !== null) {
    return (
      <section
        className="board__over board__over--sideboard"
        data-testid="game-result"
        data-result={outcome}
        role="dialog"
        aria-labelledby={titleId}
      >
        <div className="live__sideboard ct-panel">
          <div className="live__sideboard-head">
            <h2 className="confirm__title" id={titleId}>
              {OUTCOME_TITLE[outcome]}
            </h2>
            {refusal !== null && (
              <p className="ct-error live__error" role="alert">
                {refusal}
              </p>
            )}
            <span className="live__sideboard-spacer" />
            {exits}
          </div>
          {sideboardInputs !== undefined && <SideboardStep roomId={roomId} tableId={tableId} tables={tables} choice={choice} inputs={sideboardInputs} />}
        </div>
      </section>
    );
  }

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
          <p className="ct-error live__error" role="alert">
            {refusal}
          </p>
        )}
        <div className="confirm__actions answers">
          {showSideboard && roomId !== null && choice !== null && (
            <button type="button" className="button" data-testid="game-result-next" data-highlight="true" disabled={leaving} onClick={() => setNextPressed(true)}>
              Next
            </button>
          )}
          {!showSideboard && (nextInRoom ? !inPod : rematchable) && (
            <ActionButton
              action={nextInRoom ? 'next-game' : rematch.mine ? 'rematch-withdraw' : 'rematch'}
              className="button"
              data-testid="game-result-rematch"
              aria-pressed={nextInRoom ? undefined : rematch.mine}
              data-highlight={nextInRoom || rematch.highlight ? 'true' : undefined}
              disabled={nextInRoom ? roomId === null || leaving : !rematch.possible || interrupted || busy || leaving}
              onPress={nextInRoom ? onBackToRoom : onRematch}
            >
              {nextInRoom ? 'Next game' : 'Rematch'}
            </ActionButton>
          )}
          {exits}
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

/**
 * The turn an End Turn press was made on, per match, until the turn changes. While it is set the rest of the
 * turn goes by without a stop per phase: the pacer lets phase-only frames straight through
 * (`setEndingTurn`) and no `g.phase` sounds. Telemetry before this: five phase sounds 250 ms apart, and the
 * opponent's turn 2.2 s after the press, every time.
 */
const endingTurnFrom = new WeakMap<LiveMatch, { turn: number; at: number; phase: string | null; phases: number }>();

function endTurn(match: LiveMatch): void {
  if (!pressWithSound(match, 'cancel')) return;
  endingTurnFrom.set(match, { turn: match.view?.turn ?? 0, at: Date.now(), phase: match.view?.phase ?? null, phases: 0 });
  if (isPacedTransport(match.transport)) match.transport.setEndingTurn(true);
}

/**
 * Whether `view` is still the turn End Turn was pressed on; clears the mark (and the pacer's) once it is not,
 * and logs how long the rest of the turn took and how many phases it passed — the phases make no sound now,
 * so the sound telemetry no longer shows them.
 */
function stillEndingTurn(match: LiveMatch, view: BoardView): boolean {
  const ending = endingTurnFrom.get(match);
  if (ending === undefined) return false;
  if (view.turn === ending.turn && !view.gameOver) {
    if (view.phase !== ending.phase) {
      ending.phase = view.phase;
      ending.phases += 1;
    }
    return true;
  }
  endingTurnFrom.delete(match);
  if (isPacedTransport(match.transport)) match.transport.setEndingTurn(false);
  reportClient(match.transport, match.matchId, 'info', { what: 'end-turn', ms: Date.now() - ending.at, phases: ending.phases, turn: view.turn });
  return false;
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

/** The board draws this card whole: a permanent on a battlefield, or a spell on the stack. */
function drawnWhole(view: BoardView, cardId: number): boolean {
  return battlefieldCardIds(view).has(cardId) || view.stack.some((e) => e.sourceCardId === cardId);
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
  const spectator = match.spectator;
  const watcher = match.watcher;
  const over = match.over;
  const pending = currentAsk(match);
  /*
   * The table's sound: every view the pacer releases is diffed against the one
   * before it (`./sound-events.ts`), so a sound starts with the change on screen.
   * A watching window stays silent: the seat's own window is already playing it.
   */
  // The match's music: one of your deck's colours, once the server has said which (`../../sound/match-music.ts`).
  useMatchMusic(match.matchId, match.deckColors);
  const soundView = match.view;
  // The result screen waits for the board to finish drawing what ended the game.
  const resultShown = useAfterTheBoard(useGameEnded(match));
  const lastSoundView = useRef<BoardView | null>(null);
  /** The game's end sound, from the view that ended it, held for the result screen. */
  const endSound = useRef<{ events: DelayedSoundEvent[]; prevSeq: number } | null>(null);
  // A phase's sound waits for the phase to hold, so a step Forge passes straight through makes none (./phase-sound.ts).
  const phaseSound = useMemo(
    () =>
      phaseSoundGate((event, phase, how) => {
        playSoundEvents([event]);
        reportSound(match, 'phase', [event], { phase, how });
      }),
    [match],
  );
  useEffect(() => () => phaseSound.drop(), [phaseSound]);
  useEffect(() => {
    if (soundView === null) return;
    const prev = lastSoundView.current;
    lastSoundView.current = soundView;
    if (spectator && !watcher) return;
    try {
      const ending = stillEndingTurn(match, soundView);
      const all = deriveSoundEvents(prev, soundView);
      const phase = all.find((e) => e.role === 'g.phase');
      if (ending || (prev !== null && soundView.turn !== prev.turn)) phaseSound.drop();
      if (phase !== undefined && !ending) phaseSound.enter(soundView.phase ?? '', phase, openWindows(match));
      const end = all.filter((e) => END_ROLES.has(e.role));
      if (end.length > 0) endSound.current = { events: end, prevSeq: prev?.seq ?? -1 };
      const events = [
        ...afterTheHits(
          all.filter((e) => e.role !== 'g.phase' && !END_ROLES.has(e.role)),
          soundView.seq,
        ),
        ...fromTheBoard(soundView.seq),
      ];
      playSoundEvents(events);
      reportSound(match, 'view', events, { prevSeq: prev?.seq ?? -1 });
    } catch (err) {
      // Sound must never take the board down; say so in the console instead.
      console.error('[cardtable] sound events for this view failed', err);
    }
  }, [soundView, spectator, watcher, match]);
  // The game's end sounds with its result screen, once the board has drawn what ended it.
  useEffect(() => {
    const end = endSound.current;
    if (!resultShown || end === null) return;
    endSound.current = null;
    playSoundEvents(end.events);
    reportSound(match, 'view', end.events, { prevSeq: end.prevSeq, end: true });
  }, [resultShown, soundView, match]);
  // Every redraw: a window that opened since the phase began is the phase holding, and its sound plays now.
  useEffect(() => {
    phaseSound.hold(openWindows(match));
  });
  /*
   * One answer is no question (§B, items 4 and 9). `@hadoku/shared`'s `selfAnswer`
   * is the only place that decides it — the server reads the same rule for the other seat's banner; here it is sent, and the prompt that
   * would have asked is never drawn, in full control too: one answer is no choice in any mode.
   */
  const auto = pending === null || spectator ? null : selfAnswer(pending);
  const autoCallId = auto === null || pending === null ? null : pending.callId;
  useEffect(() => {
    if (autoCallId === null || auto === null || pending === null) return;
    // `answerAsk` refuses a callId that is no longer open, so a re-render
    // between the reply and the frame that closes it cannot answer twice.
    answerAsk(match, autoCallId, auto.method, auto.reply);
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
  // The room's hand-off sounded `g.match-start` before this screen existed; the log hears of it once the match is reachable.
  useEffect(() => {
    if (!spectator && matchStartSounded(match.matchId)) reportSound(match, 'start', [{ role: 'g.match-start' }]);
  }, [match.matchId]);
  const tossAt = coinToss?.at ?? null;
  // The winner's Play/Draw question waits for the coin to land (the operator, 2026-10-11:
  // "can we make it so the cointoss finishes before showing the prompt of who goes first?").
  const coinFlipping = useCoinFlipping(tossAt);
  const tossTurn = match.view?.turn ?? 0;
  useEffect(() => {
    if ((spectator && !watcher) || !tossSounds(tossAt, tossTurn, Date.now())) return;
    playRole('g.game-start');
    reportSound(match, 'toss', [{ role: 'g.game-start' }]);
    // Once per toss: the turn moving on later must not sound it again.
  }, [tossAt]);
  // The interface sounds this screen raised, folded into the log every half minute and when it closes (`takeUiTally`).
  useEffect(() => {
    takeUiTally(); // the lobby's clicks are not this match's
    if (spectator) return;
    const flush = (): void => {
      const tally = takeUiTally();
      if (Object.keys(tally).length === 0) return;
      reportClient(match.transport, match.matchId, 'sound', { why: 'tally', ...tally, turn: match.view?.turn ?? -1, muted: isMuted() });
    };
    const timer = setInterval(flush, UI_TALLY_EVERY_MS);
    return () => {
      clearInterval(timer);
      flush();
    };
  }, [match.matchId]);
  // The frame rate, in the match's log (`./frame-watch.ts`): its bad stretches, what the board was doing, and a summary every few turns.
  const frameWatch = useRef<FrameWatch | null>(null);
  useEffect(() => {
    if (spectator) return undefined;
    const watch = watchFrames({
      report: (data) => reportClient(match.transport, match.matchId, 'perf', data),
      board: () => ({
        ...boardFacts(match.view),
        beats: boardDrawing(),
        paceQueue: isPacedTransport(match.transport) ? match.transport.queued() : -1,
        ui: __HADOKU_UI_VERSION__,
      }),
    });
    frameWatch.current = watch;
    return () => {
      frameWatch.current = null;
      watch.dispose();
    };
  }, [match, spectator]);
  const frameTurn = match.view?.turn ?? -1;
  useEffect(() => {
    if (frameTurn >= 0) frameWatch.current?.noteTurn(frameTurn);
  }, [frameTurn]);
  const framePhase = match.view?.phase ?? 'none';
  useEffect(() => {
    frameWatch.current?.notePhase(framePhase);
  }, [framePhase]);
  const frameOver = match.view?.gameOver === true;
  useEffect(() => {
    if (frameOver) frameWatch.current?.noteGameOver();
  }, [frameOver]);
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
  /*
   * A yes/no about a card the board does not draw whole draws it in the window: a scry 1's library
   * card, the card cascade or discover offers to cast from exile (the operator, 2026-10-22: "effects
   * like discover/cascade must [show] the full card that they are casting. at the moment it just
   * shows text"), a card in a hand or a graveyard. A permanent or a spell on the stack the board
   * already draws: the window points at it there, as an optional trigger's source always has.
   */
  const confirmCardId = confirmPrompt ? match.promptCard : null;
  const confirmCard =
    confirmCardId !== null && match.view !== null && !drawnWhole(match.view, confirmCardId)
      ? { id: confirmCardId, tile: promptTileFor(lookupFromState(match.state), confirmCardId) }
      : undefined;
  /* "Your move": a decision window opened for this seat — an ask, or a yes/no in the decision area. */
  const decisionKey = ask !== null ? `ask:${ask.callId}` : confirmPrompt || playOrDraw ? `bar:${bar?.label1 ?? ''}` : null;
  useEffect(() => {
    if (decisionKey === null) return;
    playRole('ui.prompt');
    reportSound(match, 'decision', [{ role: 'ui.prompt' }], { key: decisionKey.slice(0, 80) });
  }, [decisionKey, match]);
  /* "Priority is back with you": a live priority bar of this seat's own, past the first of its own turn (`./priority-cue.ts`). */
  const priorityCue = useRef<PriorityCue>(NO_PRIORITY_CUE);
  const priorityTurn = match.view?.turn ?? -1;
  const priorityMine = match.view !== null && whoseTurn(match.view) === 'yours';
  const priorityLive = !spectator && !askOpen && PRIORITY_PROMPT.test(match.prompt ?? '') && bar !== null && bar.enable1;
  useEffect(() => {
    const next = nextPriorityCue(priorityCue.current, { turn: priorityTurn, mine: priorityMine, live: priorityLive });
    priorityCue.current = next.cue;
    if (!next.sound) return;
    playRole('ui.priority');
    reportSound(match, 'priority', [{ role: 'ui.priority' }], { held: next.cue.held });
  }, [priorityLive, priorityTurn, priorityMine, match]);
  /* An optional trigger's "Always" box: ticked, the Yes or No pressed is the answer Forge keeps giving. Unticked for each new confirm. */
  const [always, setAlways] = useState(false);
  useEffect(() => {
    if (!confirmPrompt) setAlways(false);
  }, [confirmPrompt]);
  /* "Same target for all" on a trigger's or a spell copy's target question while identical ones wait behind it (the operator, 2026-10-11 and 2026-10-14). */
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
   * What Forge's bar is, now that the control box only ever draws `End Turn`
   * for it (`barRoute`'s own note). Every pop-up
   * above keeps the input it already owned; whatever is left with an enabled
   * button is the decision pop-up, in the same slot.
   */
  const route = spectator
    ? 'none'
    : barRoute(bar, (match.view?.stack.length ?? 0) === 0, askOpen || paying || selectionPopup || pregameWait);
  // The bottom pick (Z2): Forge's own instruction ("Return N card(s) to the bottom of your library") in the
  // decision pop-up, its OK as Forge enables it — off until a card is set aside, on after.
  /** Forge's message, an exact pick's count said as one (`selectionText`). Every place below that words the open decision reads this. */
  const prompt = selectionText(match.prompt ?? '', match.selectables);
  /** What every decision sheet below says: the question alone, and the ability's text under it where needed (`promptLines`). */
  const lines = promptLines(match.prompt ?? '', match.promptParts, match.promptTrigger !== null);
  const question = selectionText(lines.question, match.selectables);
  const context = lines.context === null ? null : promptText(lines.context);
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
    const text = decisionMessage(prompt, match.view?.stack[0] ?? null, null);
    if (mulliganPickText.current === null && MULLIGAN_BOTTOM_PICK.test(text)) mulliganPickText.current = text;
  } else {
    mulliganPickText.current = null;
  }
  // After End Turn, Forge yields the rest of the turn and offers to cancel the yield ("Yielding until
  // end of turn. You may cancel this…", `lblYieldingUntil*`). The operator, 2026-10-07: "i dont need a way to
  // cancel my 'end turn' decision. if i click end turn i'm locked in" — no pop-up for it.
  const yielding = YIELDING.test(match.prompt ?? '');
  const decisionOk = !yielding && ((route !== 'none' && bar !== null && bar.enable1) || mulliganPick);
  // No second button during the bottom pick (the operator: "remove the 'auto' button") — Forge's own `Auto`
  // would otherwise draw beside OK the same way it does for every other decision-area bar.
  const decisionCancel = !yielding && (route === 'decision' || route === 'resolve') && bar !== null && bar.enable2 && !offersEndTurn(bar) && offersSecondButton(match) && !mulliganPick;
  const decision = decisionOk || decisionCancel;
  const combatDone = combatDoneLabel(match, route);
  /** Null while there is nobody left for "All" to declare, or outside declare-attackers — {@link attackAllTarget}. */
  const allTarget = attackAllTarget(match);
  /*
   * The operator, 2026-10-20 (m-b752a3424b43): Tinker's sacrifice "never popped up on my screen" until a
   * reload, and no repro failed to draw it (`e2e/tk-tinker.spec.ts`). What the board draws for a pick, and
   * every condition that decides it, as the pick opens and again 3 s later.
   */
  const pickKey = spectator || match.selectables === null ? null : `${match.prompt ?? ''}|${[...match.selectables.cards].join(',')}`;
  const pickFacts = useRef<() => ClientEvent['data']>(() => ({}));
  pickFacts.current = () => {
    const barText = (b: typeof bar): string => (b === null ? 'none' : `${b.label1}:${b.enable1}|${b.label2}:${b.enable2}`);
    const host = ['live-selection-host', 'live-decision-host']
      .map((id) => [id, document.querySelector(`[data-testid="${id}"]`)] as const)
      .find(([, el]) => el !== null);
    const box = host?.[1]?.getBoundingClientRect();
    return {
      selection: selectionKind,
      popup: selectionPopup,
      decision,
      route,
      ask: pending?.method ?? '-',
      paying,
      bar: barText(bar),
      buttons: barText(match.buttons),
      held: match.barHold?.reason ?? '-',
      live: match.inputLive,
      cards: listField([...(match.selectables?.cards ?? [])].map(String)),
      host: host === undefined || box === undefined ? 'none' : `${host[0].slice(5, -5)}@${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}x${Math.round(box.height)}`,
    };
  };
  useEffect(() => {
    if (pickKey === null) return;
    const report = (at: string): void => reportClient(match.transport, match.matchId, 'info', { what: 'pick-drawn', at, ...pickFacts.current() });
    report('open');
    const later = setTimeout(() => report('3s'), 3_000);
    return () => clearTimeout(later);
  }, [pickKey, match]);
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
   * turns the two into the avatar ring.
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
  const theirName = opponentOf(match.view)?.name ?? null;
  /** R11: the turn counter moved off the rail and into the logbook. */
  const whoseTurnNow = match.view === null ? 'nobody' : whoseTurn(match.view);
  const turnCue = useYourTurnCue(match.view, !spectator, match.matchId);
  // What is DRAWN offered: Forge's offer, held through the silence after a click (`./offer-hold.ts`).
  // The callbacks below send through `boardInteraction`, Forge's real state, whatever is drawn.
  const offered = spectator ? INERT_CLICKABLES : drawnOffer(match);
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
    castForbidden: spectator ? undefined : castForbiddenTips(match),
    held: spectator ? undefined : heldTags(match),
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
    damagePreview: damagePreviewOf(match),
    combatReady: spectator ? undefined : combatCandidates(match),
    /*
     * AF397's doom marking: what the open choice in front of this seat would send off the
     * battlefield as it now stands (`./match.ts`'s `doomAskOf`'s own note). A spectator has no
     * choice open on their own account, so nothing of theirs is at stake either.
     */
    doomAsk: spectator ? undefined : doomAskOf(match),
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
      if (!spectator) clickCard(match, cardId);
    },
    onSelectPlayer: (playerId) => {
      if (!spectator) selectPlayer(match, playerId);
    },
    poolPays: spectator ? undefined : poolPays(match),
    poolChoice: !spectator && poolChoice(match),
    onPayFromPool: (color) => {
      if (!spectator) payFromPool(match, color);
    },
  };

  const rootRef = useRef<HTMLDivElement>(null);
  // Every floating dialog over the board can be moved by the player (`./movable.tsx`).
  useEffect(() => {
    const root = rootRef.current;
    return root === null ? undefined : installDialogMover(root);
  }, []);
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
   * The control box's one game button, `End Turn`, is always drawn and enabled
   * only while Forge names its button two `End Turn` (`InputPassPriority`'s
   * cancel slot, `offersEndTurn`).
   */
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
  const endTurnHighlighted = !yieldMode && highlightEndTurn;
  /*
   * The highlight held unchanged for `END_TURN_NUDGE_MS` escalates to the
   * bigger pulse — never while a pop-up of this seat's own is open (a
   * pass-to-resolve decision can sit under the highlight). The empty-stack
   * pass's own pop-up is not one: it is up whenever End Turn is, and it is
   * the other way on to the same place. Unchanged means the same Forge state
   * (`forgeSeq`), the same actionable set and the same bar: a new delta, a new
   * input or a press restarts the wait.
   */
  const nudgeEndTurn = useIdleNudge(endTurnHighlighted && (!myOwnDecisionOpen || route === 'pass'), [
    match.forgeSeq,
    match.weaklySelectable,
    match.buttons,
    match.barHold,
  ]);
  const [boardLayout, setBoardLayout] = useState<BoardLayout>(PLAY_PREFS_DEFAULTS.boardLayout);
  const settings = usePopover();
  const [ownDeck, setOwnDeck] = useState<{ deck: OwnDeck; from: Element } | null>(null);
  const closeOwnDeck = useMemo(() => () => setOwnDeck(null), []);
  const toggleOwnDeck = (from: Element): void => {
    if (ownDeck !== null) {
      setOwnDeck(null);
      return;
    }
    fetchOwnDeck(match.matchId).then(
      (deck) => setOwnDeck(deck === null ? null : { deck, from }),
      (error: unknown) => reportClient(match.transport, match.matchId, 'info', { what: 'own-deck', error: String(error) }),
    );
  };
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
   * client's own initial value (`true`) while the server still needs telling —
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
  // Whose acts go out as Forge sends them (`./pace.ts`, "The seat's own acts"): this seat's player, never a watcher's.
  useEffect(() => {
    if (isPacedTransport(match.transport)) match.transport.setSeatPlayer(() => (match.spectator ? null : match.playerId));
  }, [match]);
  function handleFastModeChange(next: boolean): void {
    setFastModeState(next);
    if (isPacedTransport(match.transport)) match.transport.setFast(next);
  }
  // "Say my mistakes": client-only, read once from the persisted prefs like Fast Mode above.
  const [mistakeBubbles, setMistakeBubblesState] = useState<boolean>(PLAY_PREFS_DEFAULTS.mistakeBubbles);
  const appliedMistakeBubbles = useRef(false);
  useEffect(() => {
    if (appliedMistakeBubbles.current || prefs === null) return;
    appliedMistakeBubbles.current = true;
    setMistakeBubblesState(prefs.mistakeBubbles ?? PLAY_PREFS_DEFAULTS.mistakeBubbles);
  }, [prefs]);
  // The seat's settings, in the match's log: once they have been read, and on every change — with the
  // window they are laid out in, so a layout report is read from the log rather than guessed.
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
    reportClient(match.transport, match.matchId, 'info', { ui: __HADOKU_UI_VERSION__, fastMode, boardLayout, reducedMotion: prefersReducedMotion(), window: `${window.innerWidth}x${window.innerHeight}` });
  }, [match, spectator, prefs, fastMode, boardLayout]);
  useEffect(() => {
    // `snapshots === 0` is "no join has completed yet" — sending before that
    // would fire on mount, before the socket has so much as connected, and
    // then fire AGAIN the moment the real join lands (`stats.snapshots`
    // 0 → 1), which is a real double-send and not merely a wasted one.
    if (spectator || prefs === null || match.stats.snapshots === 0) return;
    sendStopPreference(match, prefs.endStepStop ?? PLAY_PREFS_DEFAULTS.endStepStop, true);
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
    const handle = installGestures({ canvas, match, report: (kind, data) => reportClient(match.transport, match.matchId, kind, data) });
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
      playerOfSeat: (seat) => playerIdOfSeat(match, seat),
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
        opponentName: () => opponentOf(match.view)?.name ?? null,
        theirPlayerId: () => opponentOf(match.view)?.id ?? null,
        playerOfSeat: (seat) => playerIdOfSeat(match, seat),
        viewerPlayerId: () => viewerPlayerIdOf(match),
        // `from` (the arrow's tail) is sent only while this seat is actually aiming — the
        // same condition `paint()` (`gestures/install.ts`) already uses for its own arrow.
        aiming: () => match.selectables !== null || stackAsk(match) !== null,
        watch: (onChange) => subscribe(match, onChange),
        theirCards: () => {
          const view = match.view;
          if (view === null) return [];
          const them = view.players.filter((p) => !p.isViewer);
          const mine = viewerOf(view)?.name ?? null;
          return [
            ...them.flatMap((p) => p.battlefield.map((c) => c.id)),
            ...view.stack.filter((item) => !item.isAbility && item.sourceCardId !== null && item.controllerName !== mine).map((item) => item.sourceCardId!),
          ];
        },
        theirStackCards: () => {
          const view = match.view;
          if (view === null) return [];
          const mine = viewerOf(view)?.name ?? null;
          return view.stack.filter((item) => !item.isAbility && item.sourceCardId !== null && item.controllerName !== mine).map((item) => item.sourceCardId!);
        },
        landingWeightOf: (cardId) => castLandingWeight(match.view, cardId),
        // A watcher sends none (`reportClient`'s own rule).
        report: spectator ? undefined : (kind, data) => reportClient(match.transport, match.matchId, kind, data),
      },
    });
    return () => handle.dispose();
  }, [match, spectator]);

  /*
   * `--live-h`: `.live`'s own real resolved height, in pixels, kept current on
   * this element so `live.css`'s `--rail-row-h` (wave 33 §L1) can read it; and
   * `--live-w`, its width, which the decision column's `--live-col-x` /
   * `--live-col-w` are fractions of wherever they are read.
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
    const sync = () => {
      const box = el.getBoundingClientRect();
      el.style.setProperty('--live-h', `${box.height}px`);
      el.style.setProperty('--live-w', `${box.width}px`);
    };
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
   * `.board__mid[data-question]` hangs the band from it. On a resize of the
   * root or of anything in the column, never on a render: one observer, made
   * once, and each render only hands it the sheets it has not seen (a new
   * sheet is reported once it is observed; a prompt that grows from its own
   * state re-renders nothing here, and its resize reports it).
   */
  const relayoutFrame = useRef(0);
  const questions = useRef<{ observer: ResizeObserver; sheets: Set<Element> } | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const top = questionTopOf(root);
      // No pop-up to measure: the last measured edge stands, so the band neither flashes at the column's
      // top before the pop-up that asks opens (the operator, 2026-10-07: it "was only there briefly") nor
      // moves when one closes. Before any is measured, `board.css` falls back to where one sits.
      if (top === null) return;
      const value = `${top}px`;
      if (root.style.getPropertyValue('--question-top') === value) return;
      root.style.setProperty('--question-top', value);
      // The band moved with no frame from Forge: arcs drawn from its thumbnails repaint (`relayout`), on the
      // next frame: the same wake settles a played card's landing, which must measure its slot after `Board`
      // moves a dropped card into it (measured: inside the commit, the landing flew 190px wide).
      cancelAnimationFrame(relayoutFrame.current);
      relayoutFrame.current = requestAnimationFrame(() => relayout(match));
    });
    observer.observe(root);
    questions.current = { observer, sheets: new Set() };
    return () => {
      cancelAnimationFrame(relayoutFrame.current);
      observer.disconnect();
      questions.current = null;
    };
  }, [match]);
  useLayoutEffect(() => {
    const q = questions.current;
    const root = rootRef.current;
    if (q === null || root === null) return;
    for (const el of q.sheets) {
      if (el.isConnected) continue;
      q.observer.unobserve(el);
      q.sheets.delete(el);
    }
    for (const el of root.querySelectorAll(QUESTION_SELECTOR)) {
      if (q.sheets.has(el)) continue;
      q.sheets.add(el);
      q.observer.observe(el);
    }
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
      data-role={watcher ? 'watcher' : undefined}
      onPointerOver={hoverControl}
      // The board's own arranging drag is HTML5 and is lane A's; a watcher's
      // window refuses it here, at the root, rather than teaching the board.
      onDragStartCapture={spectator ? (event) => event.preventDefault() : undefined}
    >
      {spectator && !watcher && (
        <p className="live__spectator" role="status" data-testid="live-spectator">
          Watching: this seat is being played in another window
        </p>
      )}
      {/*
       * No seat (2026-10-12): the one word, and the one control a watcher has —
       * turning the table around. `flipPerspective` is client-only; the public
       * projection holds nothing hidden, so which side is at the bottom is the
       * watcher's to choose. Same perch as the wave-31 banner, which it replaces
       * for this role.
       */}
      {watcher && (
        <p className="live__spectator live__spectator--watcher" role="status" data-testid="watcher-status" data-role="watcher">
          <span>Watching</span>
          <button
            type="button"
            className="live__flip"
            data-testid="perspective-flip"
            aria-label="Switch sides"
            title="Switch sides"
            disabled={match.view === null}
            onClick={() => flipPerspective(match)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M3 5.5h7.2L8.6 3.9 9.7 2.8 13.2 6.3 9.7 9.8 8.6 8.7l1.6-1.6H3Z" />
              <path d="M13 10.5H5.8l1.6 1.6-1.1 1.1L2.8 9.7 6.3 6.2l1.1 1.1-1.6 1.6H13Z" />
            </svg>
          </button>
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
       * state and nothing is rendered. Every other state keeps it: with no board
       * this line is the whole page, and over a board (`reconnecting`, or an
       * outcome arriving on a table already up) it is the one thing that changed.
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
        <p className="ct-error live__error" role="alert" data-testid="live-error" data-live-line="">
          {alert}
        </p>
      )}
      {visualView !== null && (
        <Board
          view={visualView}
          interaction={interaction}
          revealed={match.revealed}
          rolls={match.rolls}
          onRoll={(roll) => soundThrow(match, roll)}
          boardLayout={boardLayout}
          fastMode={fastMode}
          onOpenSettings={settings.toggle}
          onOpenDeck={spectator ? undefined : toggleOwnDeck}
          // A watcher sends none (`reportClient`'s own rule).
          onEffect={spectator ? undefined : (data) => reportClient(match.transport, match.matchId, 'effect', data)}
        />
      )}
      {/* The seat's own avatar says what it got wrong; a spectator or watcher has no mistakes to say. */}
      {visualView !== null && !spectator && <MistakeBubble mistake={match.mistake} enabled={mistakeBubbles} />}
      {turnCue !== null && <TurnCue turn={turnCue} />}
      {/* Out of flow, over the board's right edge: it moves no canvas box. */}
      {match.view !== null && (
        <PhaseRail view={match.view} stop={match.phaseStop} onStop={spectator ? null : (phase) => setPhaseStop(match, phase)} />
      )}
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
      <div className="live__logbook ct-panel" data-testid="live-logbook" id={logbookId} hidden={!logOpen}>
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
          {plainRulesText(prompt)}
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
          {match.says.slice(-SAYS_SHOWN).map((say, i) => (
            <LogLine key={i} say={say} cards={logCards} ids={logIds} theirName={theirName} />
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
        {/* Three equal blocks (the operator, 2026-10-17: "Log icon is ugly, should be three equally sized blockes"). */}
        <svg className="live__log-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="2.5" y="2.5" width="11" height="2.6" rx="0.6" />
          <rect x="2.5" y="6.7" width="11" height="2.6" rx="0.6" />
          <rect x="2.5" y="10.9" width="11" height="2.6" rx="0.6" />
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
      {/* A watcher has no seat, so no control box at all: not greyed, absent (2026-10-12). */}
      {!watcher && (
      <div className="live__buttons" data-testid="live-buttons">
        {/*
         * The same three buttons every frame, in this order — `End Turn`, `Full
         * control`, `Concede` — greyed when they do not apply. Passing priority
         * is the decision pop-up's (`barRoute`'s `pass`): the operator,
         * 2026-10-24, *"the 'next phase' button must go"*. The labels are ours
         * and never change. `data-highlight` (R5) is End Turn's, and
         * `data-nudge` its escalation once that has held (`useIdleNudge`).
         *
         * The one exception: on the OTHER seat's turn the End Turn slot
         * reads Auto Yield / Cancel Yield instead, same testid and place
         * (`yieldMode`/`autoYieldOn`, above).
         */}
        <ActionButton
          action={yieldMode ? (autoYieldOn ? 'yield-cancel' : 'yield') : 'end-turn'}
          className="live__end-turn"
          data-testid="live-button-end-turn"
          data-highlight={endTurnHighlighted ? '' : undefined}
          data-nudge={nudgeEndTurn ? '' : undefined}
          data-yield={yieldMode ? (autoYieldOn ? 'on' : 'off') : undefined}
          disabled={yieldMode ? spectator : !endTurnEnabled}
          onPress={() => (yieldMode ? setAutoYield(match, !autoYieldOn) : endTurn(match))}
        >
          {yieldMode ? (autoYieldOn ? 'Cancel Yield' : 'Auto Yield') : 'End Turn'}
        </ActionButton>
        <ActionButton
          action={match.fullControl ? 'full-control-off' : 'full-control-on'}
          className="live__toggle"
          data-testid="live-full-control"
          aria-pressed={match.fullControl}
          disabled={spectator}
          onPress={() => setFullControl(match, !match.fullControl)}
        >
          Full control
        </ActionButton>
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
          onClick={() => setConceding(true)}
        >
          Concede
        </button>
      </div>
      )}
      {ask !== null && (
        <QuestionHost data-testid="live-prompt" data-call-id={ask.callId} data-method={ask.method}>
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
        </QuestionHost>
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
        <QuestionHost data-testid="live-play-or-draw-host">
          {coinToss !== null && <TossCoin toss={coinToss} />}
          {!coinFlipping && (
            <ConfirmPrompt
              testId="live-play-or-draw"
              message={promptText(prompt)}
              button1={{ label: PLAY_LABEL, enabled: bar?.enable1 ?? false, testId: 'live-play-or-draw-play', onClick: () => pressWithSound(match, 'ok') }}
              button2={{ label: DRAW_LABEL, enabled: bar?.enable2 ?? false, testId: 'live-play-or-draw-draw', onClick: () => pressWithSound(match, 'cancel') }}
            />
          )}
        </QuestionHost>
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
        <QuestionHost data-testid="live-confirm-host">
          <ConfirmPrompt
            testId="live-confirm"
            message={promptText(question)}
            context={context}
            button1={{ label: bar.label1, enabled: bar.enable1, testId: 'prompt-confirm-yes', onClick: () => answerTrigger('ok') }}
            button2={{ label: bar.label2, enabled: bar.enable2, testId: 'prompt-confirm-no', onClick: () => answerTrigger('cancel') }}
            check={match.promptTrigger === null ? undefined : { label: 'Always', testId: 'live-confirm-always', checked: always, onChange: setAlways }}
            card={confirmCard}
          />
        </QuestionHost>
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
       * it (`data-staged`, `live.css`), and opens there whatever spot the
       * player last moved a question to (`spot`).
       *
       * Wave 76 §C: button2's slot is never Forge's own second button
       * during declare-attackers (`offersSecondButton` refuses it outright, so
       * `decisionCancel` is always false there) — so "All" takes that same
       * slot, the one place `ConfirmPrompt`'s own `AnswerRow` already lays out
       * a button beside "Done Attacking". `decisionCancel` and `allTarget` can
       * never both hold (the first requires `offersSecondButton`, the second
       * requires its negation), so this never contests Forge's own Cancel.
       */}
      {decision && bar !== null && (
        <QuestionHost
          data-testid="live-decision-host"
          data-staged={interaction.stagedCardId !== undefined || undefined}
          data-pass={route === 'pass' || undefined}
          spot={interaction.stagedCardId !== undefined ? 'staged' : undefined}
        >
          <ConfirmPrompt
            testId="live-decision"
            message={
              mulliganPick
                ? mulliganPickText.current ?? ''
                : decisionMessage(question, match.view?.stack[0] ?? null, route === 'pass' && match.view !== null ? nextStepName(match.view) : null)
            }
            context={mulliganPick ? null : context}
            start={combatDone !== null}
            button1={
              decisionOk
                ? {
                    label: combatDone ?? passLabel(route) ?? bar.label1,
                    enabled: (!mulliganPick || bar.enable1) && bar.refusal1 === undefined,
                    ...(bar.refusal1 === undefined ? {} : { tip: promptText(bar.refusal1) }),
                    testId: 'live-decision-ok',
                    onClick: () => pressWithSound(match, 'ok'),
                  }
                : undefined
            }
            button2={
              decisionCancel
                ? { label: bar.label2, enabled: true, testId: 'live-decision-cancel', onClick: () => pressWithSound(match, 'cancel') }
                : allTarget !== null
                ? { label: 'All', enabled: true, testId: 'live-attack-all', onClick: () => attackAll(match, allTarget) }
                : undefined
            }
            check={sameTargetCheck}
          />
        </QuestionHost>
      )}
      {/* A trigger's target with identical ones waiting and no button of Forge's to draw: the box alone, under Forge's own line. */}
      {sameTargetCheck !== undefined && !(decision && bar !== null) && (
        <QuestionHost data-testid="live-target-host">
          <ConfirmPrompt testId="live-target" message={promptText(question)} context={context} check={sameTargetCheck} />
        </QuestionHost>
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
        <QuestionHost data-testid="live-selection-host" data-on-board={selectionKind === 'on-board' || undefined}>
          <SelectionPrompt
            message={promptText(question)}
            context={lines.context}
            source={match.promptCard}
            cards={[...match.selectables.cards]}
            lookup={lookupFromState(match.state)}
            picked={match.highlighted ?? EMPTY_CARD_IDS}
            onPick={(id) => selectCard(match, id)}
            done={bar?.enable1 === true ? { label: bar.label1, enabled: true, onClick: () => pressWithSound(match, 'ok') } : undefined}
            cancel={bar?.enable2 === true ? { label: bar.label2, enabled: true, onClick: () => pressWithSound(match, 'cancel') } : undefined}
          />
        </QuestionHost>
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
       * Hadoku to decide…" over his own live pass / End Turn.
       */}
      {/* A coin flipped in the game: the same coin, landing on Forge's face (`coin-flip.tsx`). */}
      <CoinFlips flips={match.flips} viewer={viewerOf(match.view)?.id ?? null} onFlip={(flip) => soundThrow(match, flip)} />
      {/* The coin is its own fact, told before the lagged `waitingOn` — never gated on it. */}
      {coinToss !== null && !playOrDraw && !myOwnDecisionOpen && !(match.view?.gameOver ?? false) && (
        <QuestionHost data-testid="live-coin-toss-host">
          <TossCoin toss={coinToss} waiting={match.seat !== coinToss.winner} />
        </QuestionHost>
      )}
      {waitingForOpponent && !viewerOpen && coinToss === null && (
        <WaitingPop
          sentence={
            theyLeft(match)
              ? `Waiting for ${theirName ?? 'the other player'} to reconnect…`
              : pregameWait || theirAsk === null
                ? `Waiting for ${theirName ?? 'the other player'}…`
                : waitingSentence(theirName ?? 'the other player', theirAsk)
          }
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
      {resultShown && match.view !== null && <GameResultScreen match={match} roomId={roomId} />}
      {match.ended !== null && gameOutcome(match) === null && <MatchEndedNotice ended={match.ended} roomId={roomId} />}
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
            mistakeBubbles={mistakeBubbles}
            onMistakeBubblesChange={setMistakeBubblesState}
            onSave={(patch: Partial<PlayPrefs>) => void savePrefs(patch)}
          />
        </SettingsPopover>
      )}
      {ownDeck !== null && <OwnDeckPeek deck={ownDeck.deck} from={ownDeck.from} onClose={closeOwnDeck} />}
    </div>
  );
}
