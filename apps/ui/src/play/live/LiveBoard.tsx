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
 * ## The says, and the full-control toggle
 *
 * Lane C's server says a thing to the seat when it acts for it —
 * "auto-passed Upkeep step", "paid U — Volcanic Island" — because an
 * auto-pass nobody can see is indistinguishable from a board that froze
 * (§C.2), and a cast that shows no payment looks free (#8). Those arrive as
 * Tier-A `message` notifies; `match.says` holds the last few and the control
 * cluster draws the newest two, always in a slot of its own so the table never
 * moves
 * ("nothing comes and goes"). A say is a state, not prose — it is rendered
 * exactly as sent, braces said in words like every other rules text.
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
 * too: a longer say scrolls inside its own slot and moves nothing. A cluster
 * that appeared when Forge asked would fail that spec, and it would be the
 * *"appearing and disappearing"* the operator called ugly in the first place.
 *
 * A button is disabled unless Forge enabled it AND no question is open;
 * `pressButton` refuses the same cases, so a disabled button that is somehow
 * pressed still sends nothing. With no bar from Forge yet, the buttons carry
 * neutral labels.
 *
 * **Leave and Concede are in it** (wave 22 §F.1, wave 24 §C.4), on the row
 * BELOW OK and Cancel. They are the two controls that are not answers to
 * Forge, and giving them their own row is what keeps a reach for one from
 * being a misclick on the other.
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
 * Forge's thirteen `PhaseType` steps as a column at the left edge, grouped the
 * way a turn is, with the step the game is on named and the rest as marks.
 * Presentation only — every value comes off `match.view`, which already
 * carried all three, and nothing new goes on the wire.
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

import { PHASE_LABEL, type BoardView } from '../adapter.ts';
import { Board, type BoardInteraction } from '../Board.tsx';
import { lookupFromState, plainRulesText, withAbilityLabels } from '../prompts/lookup.ts';
import { autoAnswer } from '../prompts/rules.ts';
import { isPromptMethod, PromptFor, type AskOf, type PromptMethod } from '../prompts/index.ts';
import { navigate } from '../../screens/route.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { installGestures } from './gestures/index.ts';
import {
  abortAsk,
  answerAsk,
  answerConfirm,
  boardInteraction,
  concede,
  currentAsk,
  noteAutoAnswered,
  pressButton,
  selectCard,
  selectPlayer,
  setFullControl,
  subscribe,
  type LiveAsk,
  type LiveMatch,
} from './match.ts';
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
 * The one line, in the operator's register: a state, and no prose about it.
 *
 * `Seat N, live.` is unchanged because three playwright specs wait on that
 * exact string, and a seat number is the one number here that names something
 * the player can see on the table.
 */
export function statusText(match: LiveMatch): string {
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
      return `${seat}, live.`;
    case 'refused':
      return `Refused: ${refusalOf(match) ?? ''}`;
    case 'match-gone':
      return 'Match gone.';
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

/** How many of the held says the control cluster draws. The slot is always this tall. */
export const SAYS_SHOWN = 2;

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

/**
 * The phase rail. Presentation only — turn, step and whose turn all come off
 * the view that was already on screen (see the module header).
 *
 * A step before the current one carries `data-past`, so the column reads as a
 * turn in progress rather than a menu. A phase Forge sends that is not one of
 * the thirteen leaves nothing current: `PHASE_LABEL` has no word for it either,
 * and inventing one here would be this lane guessing at the engine.
 */
function PhaseRail({ view }: { view: BoardView }) {
  const at = PHASE_ORDER.findIndex((p) => p.phase === view.phase);
  const whose = whoseTurn(view);
  return (
    <div className="live__phases" data-testid="live-phases" data-whose={whose} data-phase={view.phase ?? ''}>
      <p className="live__turn" data-testid="live-turn">
        <span className="live__turn-n">{view.turn}</span>
        <span className="live__turn-who">{whose}</span>
      </p>
      <ol className="live__steps" aria-label="Phase">
        {PHASE_ORDER.map(({ phase, group }, i) => (
          <li
            key={phase}
            className="live__step"
            data-phase={phase}
            data-group={group}
            data-current={i === at ? '' : undefined}
            data-past={at >= 0 && i < at ? '' : undefined}
            data-group-start={i === 0 || PHASE_ORDER[i - 1]!.group !== group ? '' : undefined}
            aria-current={i === at ? 'step' : undefined}
          >
            <span className="live__mark" aria-hidden="true" />
            <span className="live__step-name">{PHASE_LABEL[phase] ?? phase}</span>
          </li>
        ))}
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

export interface LiveBoardProps {
  match: LiveMatch;
  /**
   * What Leave does. Defaults to the lobby, which is where leaving a match
   * goes; a test or a harness passes its own.
   */
  onLeave?: () => void;
}

export function LiveBoard({ match, onLeave }: LiveBoardProps) {
  useSyncExternalStore(
    (listener) => subscribe(match, listener),
    () => match.revision,
  );
  const pending = currentAsk(match);
  /*
   * One answer is no question (§B, items 4 and 9). `rules.ts`'s `autoAnswer`
   * is the only place that decides it; here it is sent, and the prompt that
   * would have asked is never drawn. Full control turns it off, and then the
   * picker comes back for one ability as it does for two.
   */
  const auto = pending === null || match.fullControl ? null : autoAnswer(pending);
  const autoCallId = auto === null || pending === null ? null : pending.callId;
  useEffect(() => {
    if (autoCallId === null || auto === null) return;
    // `answerAsk` refuses a callId that is no longer open, so a re-render
    // between the reply and the frame that closes it cannot answer twice.
    if (answerAsk(match, autoCallId, auto.method, auto.reply)) noteAutoAnswered(match, auto.why);
  }, [match, autoCallId, auto]);
  /* Nothing renders for an ask that answers itself — not even for a frame. */
  const ask = auto === null ? pending : null;
  const bar = match.buttons;
  const status = liveStatus(match);
  /*
   * The status line is the only line about WHERE the match is. `lastError`
   * draws its own row only while the board is live, where it is a failure
   * inside a match rather than the match's state — every other case has
   * already been said above, and saying it twice is the bug §F.2 names.
   */
  const alert = status === 'live' ? match.lastError : null;
  const offered = boardInteraction(match);
  const interaction: BoardInteraction = {
    ...offered,
    onSelectCard: (cardId) => selectCard(match, cardId),
    onSelectPlayer: (playerId) => selectPlayer(match, playerId),
  };

  const rootRef = useRef<HTMLDivElement>(null);
  /*
   * Concede's confirmation is open. Local state, not a `LiveMatch` field: it
   * is this component's own question, nothing on the wire is waiting on it,
   * and a resync must not answer it.
   */
  const [conceding, setConceding] = useState(false);

  /*
   * The pointer layer is lane B's (`./gestures/`), and the element is the whole
   * contract: `installGestures` is handed `.live` and finds the board, the
   * cards and lane A's overlay root under it. No `onChange` — the board redraws
   * off `match.revision` above, and the arrow is drawn in the overlay by the
   * gesture layer itself, so there is nothing here for a callback to do.
   */
  useEffect(() => {
    const canvas = rootRef.current;
    if (canvas === null) return undefined;
    const handle = installGestures({ canvas, match });
    return () => handle.dispose();
  }, [match]);

  return (
    <div className="live" ref={rootRef}>
      {/*
       * `data-live-line` marks every row of text this component draws about
       * itself, so a test can count them: three at once was the bug.
       * `data-perch` is where the line sits — in the turn bar's corner with a
       * table under it, or in the table's own space when there is none.
       */}
      <p
        className="live__status"
        role="status"
        data-testid="live-status"
        data-live-line=""
        data-status={status}
        data-perch={match.view === null ? 'table' : 'corner'}
        title={status === 'live' ? undefined : (match.lastError ?? undefined)}
      >
        {statusText(match)}
      </p>
      {alert !== null && (
        <p className="live__error" role="alert" data-testid="live-error" data-live-line="">
          {alert}
        </p>
      )}
      {match.view !== null && <Board view={match.view} interaction={interaction} />}
      {/* Out of flow, over the board's left edge: it moves no canvas box. */}
      {match.view !== null && <PhaseRail view={match.view} />}
      {/*
       * The control cluster (§C.1). One container, every frame, the same
       * children and the same box — `e2e/table-fit.spec.ts` measures all four
       * on every animation frame of a real match. `live.css` pins it in the
       * bottom-right corner over the board; it is in no flex flow and costs
       * the table no height.
       */}
      <div className="live__buttons" data-testid="live-buttons">
        {/*
         * Leave: the match's own control, on the row below Forge's answers.
         * Not a link, because leaving is an action on this match and not a
         * place — and a button is the tab stop a person expects.
         */}
        <button
          type="button"
          className="live__leave"
          data-testid="live-leave"
          data-urgent={status === 'match-gone' ? true : undefined}
          onClick={() => {
            if (onLeave !== undefined) onLeave();
            else navigate({ kind: 'lobby' });
          }}
        >
          Leave
        </button>
        <p className="live__says" data-testid="live-says">
          {match.prompt ?? ''}
        </p>
        {/*
         * The says, newest at the bottom. Always rendered, always two lines
         * tall: an empty log is an empty slot, never a cluster that changed
         * shape. Brace notation is said in words, as every other rules text is.
         */}
        <ul className="live__log" data-testid="live-log" aria-label="Said">
          {match.says.slice(-SAYS_SHOWN).map((line, i) => (
            <li key={i}>{plainRulesText(line)}</li>
          ))}
        </ul>
        <button
          type="button"
          className="live__toggle"
          data-testid="live-full-control"
          aria-pressed={match.fullControl}
          onClick={() => setFullControl(match, !match.fullControl)}
        >
          Full control
        </button>
        <button
          type="button"
          className="live__ok"
          data-testid="live-button-ok"
          disabled={ask !== null || bar === null || !bar.enable1}
          onClick={() => pressButton(match, 'ok')}
        >
          {bar === null || bar.label1 === '' ? 'OK' : bar.label1}
        </button>
        <button
          type="button"
          className="live__cancel"
          data-testid="live-button-cancel"
          disabled={ask !== null || bar === null || !bar.enable2}
          onClick={() => pressButton(match, 'cancel')}
        >
          {bar === null || bar.label2 === '' ? 'Cancel' : bar.label2}
        </button>
        {/*
         * Concede (§C.4). It sends NOTHING: it opens the confirmation, and only
         * that dialog's own yes reaches `concede`. Pressable with a question
         * open, like Leave — giving up is not an answer to what Forge asked.
         */}
        <button
          type="button"
          className="live__concede"
          data-testid="live-concede"
          aria-expanded={conceding}
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
      {conceding && (
        <ConcedeAsk
          onConcede={() => {
            concede(match);
            setConceding(false);
          }}
          onCancel={() => setConceding(false)}
        />
      )}
    </div>
  );
}
