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
 * ## Dragging, and the targeter arrow
 *
 * The operator, 2026-09-24: *"i need like a targeter arrow that helps me pick
 * a target, and i dont even know how to select the opponent"*, and *"cards are
 * not dragable"*. Both are one gesture, handled here, and **neither invents a
 * wire method**: a drag ends in the same `selectCard` / `selectPlayer` senders
 * a click uses, and the click path is untouched.
 *
 * The gesture is delegated from `.live` itself rather than from a wrapper,
 * because `live.css` styles `.live > .board` directly and an extra element
 * between them would silently change the table's layout. It listens on
 * `window` for the move and the release (no pointer capture), so the event's
 * own `target` is the element under the pointer — jsdom has no
 * `elementFromPoint`, and a captured pointer would report the source anyway.
 *
 *  - **It starts** on a card `boardInteraction` offers. While a selection is
 *    live it also starts on anything else on the table, with no source: that
 *    is the pure pointing gesture, drag from the spell to the thing you mean.
 *  - **It draws** an arrow into lane A's overlay root, `[data-board-overlay]`,
 *    in that element's own coordinates. If the overlay is absent NOTHING is
 *    drawn and the gesture still works — the arrow is guidance, not the
 *    mechanism.
 *  - **It snaps** to whatever legal target is under the pointer: an offered
 *    card, or an offered player's face. A STACK ITEM is neither, on purpose:
 *    it carries `data-source-card` rather than `data-card-id` (lane A's note
 *    in `Board.tsx` — an ability on the stack whose card is still in play
 *    would otherwise name that id twice), so the id would not anchor the arrow
 *    to the thing the pointer is actually over. Stack items stay click-only,
 *    and `Board` still draws them as buttons when Forge offers their source.
 * A drag needs no click suppression, and does not do any: a browser fires the
 * trailing `click` only when the press and the release share an element, which
 * is the drop-on-the-source case — and that has already sent `selectCard`, so
 * the source is `spent` and the click sends nothing (`./match.ts`). A press
 * that never passed the slop is a plain click and the gesture stays out of it.
 *
 *  - **On release** it sends, and what it sends is Forge's answer:
 *      · dropped on the source itself → `selectCard(source)`, a click;
 *      · dropped on another legal target → `selectCard(source)` then the
 *        target's send — EXCEPT while a selection whose `max` is one is live,
 *        where Forge wants a single thing and the drop is the thing the player
 *        pointed at, so only the target is sent. `max` is Forge's own number
 *        (`setSelectables`), not a rule of ours;
 *      · dropped on no target, outside a selection, but inside a zone →
 *        `selectCard(source)`. The single frame the card's own face sends: it
 *        is the card being used, which is all the priority input takes.
 *        Dragging a land onto the table is #6's whole point.
 *      · anything else → nothing, and nothing said.
 *
 * ## The says, and the full-control toggle
 *
 * Lane C's server says a thing to the seat when it acts for it —
 * "auto-passed Upkeep step", "paid U — Volcanic Island" — because an
 * auto-pass nobody can see is indistinguishable from a board that froze
 * (§C.2), and a cast that shows no payment looks free (#8). Those arrive as
 * Tier-A `message` notifies; `match.says` holds the last few and the bar
 * draws the newest two, always in a slot of its own so the table never moves
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
 * ## The button bar never comes and goes
 *
 * It is drawn in every frame, with the same children, so the table does not
 * jump when Forge asks or stops asking. A button is disabled unless Forge
 * enabled it AND no question is open; `pressButton` refuses the same cases, so
 * a disabled button that is somehow pressed still sends nothing. With no bar
 * from Forge yet, the buttons carry neutral labels.
 */

import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { Board, type BoardInteraction } from '../Board.tsx';
import { lookupFromState, plainRulesText, withAbilityLabels } from '../prompts/lookup.ts';
import { autoAnswer } from '../prompts/rules.ts';
import { isPromptMethod, PromptFor, type AskOf, type PromptMethod } from '../prompts/index.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import {
  abortAsk,
  answerAsk,
  answerConfirm,
  boardInteraction,
  currentAsk,
  noteAutoAnswered,
  pressButton,
  selectCard,
  selectPlayer,
  setFullControl,
  subscribe,
  type LiveAsk,
  type LiveClickables,
  type LiveMatch,
} from './match.ts';
import './live.css';

/** One line of plain words for where the connection is. */
export function statusLine(match: LiveMatch): string {
  if (!match.connected) return match.everConnected ? 'Disconnected — reconnecting…' : 'Connecting…';
  if (match.awaitingSnapshot) return match.stats.snapshots === 0 ? 'Joining the match…' : 'Catching up…';
  if (match.seat === null) return 'Connected, not seated.';
  return `Seat ${match.seat + 1}, live.`;
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

/** How many of the held says the bar draws. The slot is always this tall. */
export const SAYS_SHOWN = 2;

/* ── The drag gesture and the targeter arrow ─────────────────────────── */

/**
 * How far the pointer must travel before a press is a DRAG rather than a
 * click. Below it the card's own button handles the click, exactly as before.
 */
export const DRAG_SLOP_PX = 6;

/** What the pointer is over, when Forge has offered it. */
type DropTarget = { kind: 'card'; id: number } | { kind: 'player'; id: number };

interface DragState {
  /** The card the gesture started on. Null: a pointing gesture inside a selection. */
  source: number | null;
  /**
   * Where the pointer went down, in client coordinates. The slop is measured
   * from HERE and not from `from`: a press near a card's edge is already
   * several pixels from its centre, and measuring from the centre would call
   * that press a drag before the pointer had moved at all.
   */
  press: { x: number; y: number };
  /** Where the arrow starts, in client coordinates: the source's centre. */
  from: { x: number; y: number };
  /** Where the pointer is, in client coordinates. */
  at: { x: number; y: number };
  target: DropTarget | null;
  /** The pointer has travelled past `DRAG_SLOP_PX`. */
  moved: boolean;
}

function centreOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * A card's box. `data-board-card` first, `data-card-id` (lane A's name, same
 * value on the same element) second. Both are on the `<li>`, so either finds
 * the whole card rather than something inside it.
 */
function cardBox(root: ParentNode, id: number): Element | null {
  return root.querySelector(`[data-board-card="${id}"]`) ?? root.querySelector(`[data-card-id="${id}"]`);
}

/** A player's face. Lane A's `data-player-face`, with the seat section as the fallback. */
function faceBox(root: ParentNode, id: number): Element | null {
  return (
    root.querySelector(`[data-player-face][data-player-id="${id}"]`) ??
    root.querySelector(`[data-testid="player"][data-player-id="${id}"]`)
  );
}

function boxOf(root: ParentNode, target: DropTarget): Element | null {
  return target.kind === 'card' ? cardBox(root, target.id) : faceBox(root, target.id);
}

/** A board id: digits only. See `boardId` on why that matters. */
const BOARD_ID = /^\d+$/;

/**
 * An id attribute's value, when it is one of OUR ids.
 *
 * `CardTile` (`Board.tsx`'s own note) draws a `data-card-id` of its own in the
 * DRAFT's namespace — `w<forge id>` — and it is a descendant of the board
 * card's `<li>`. A walk up from a pointer event meets the tile first, so an id
 * that is not a plain integer means "not this lane's attribute, keep walking"
 * rather than "a card Forge did not offer".
 */
function boardId(el: Element, ...names: string[]): number | null {
  for (const name of names) {
    const raw = el.getAttribute(name);
    if (raw !== null && BOARD_ID.test(raw)) return Number(raw);
  }
  return null;
}

/**
 * The nearest thing under `node` that Forge has offered, or null.
 *
 * Nearest wins, walking up: a card inside a seat section is the card, not the
 * seat. A card or face Forge did NOT offer stops the walk — dropping on an
 * inert thing is not a drop on whatever contains it.
 */
function targetUnder(node: EventTarget | null, offered: LiveClickables): DropTarget | null {
  let el = node instanceof Element ? node : null;
  while (el !== null) {
    const cardId = boardId(el, 'data-board-card', 'data-card-id');
    if (cardId !== null) {
      return offered.selectable.has(cardId) ? { kind: 'card', id: cardId } : null;
    }
    if (el.hasAttribute('data-player-face') || el.getAttribute('data-testid') === 'player') {
      const id = boardId(el, 'data-player-id');
      return id !== null && offered.selectablePlayers.has(id) ? { kind: 'player', id } : null;
    }
    el = el.parentElement;
  }
  return null;
}

/** Everything a release can mean. Exported for `./LiveBoard.test.ts`; see the module header. */
export function commitDrag(match: LiveMatch, drag: DragState, node: EventTarget | null): void {
  const offered = boardInteraction(match);
  const source = drag.source !== null && offered.selectable.has(drag.source) ? drag.source : null;
  const target = targetUnder(node, offered);

  if (target === null) {
    // Nothing Forge named is under the pointer. A drop inside a zone is the
    // card being used — the same single frame its own face sends — whenever
    // Forge currently offers it, selection open or not: `source` is null for
    // a card Forge did not name, and `selectCard` re-checks the offer before
    // anything leaves, so this can never invent an affordance. A drop
    // outside every zone does nothing and says nothing.
    if (source === null) return;
    if (!(node instanceof Element) || node.closest('[data-zone]') === null) return;
    selectCard(match, source);
    return;
  }
  if (target.kind === 'card' && target.id === source) {
    selectCard(match, source);
    return;
  }
  // Forge's own `max`: one thing wanted, so the drop is the thing meant.
  const single = match.selectables !== null && match.selectables.max <= 1;
  if (source !== null && !single && !selectCard(match, source)) return;
  if (target.kind === 'card') selectCard(match, target.id);
  else selectPlayer(match, target.id);
}

/**
 * The arrow. Ours: a tapered shaft and a plain head, no card frame, no mana
 * symbol, no tap symbol — nothing of WotC's (`CLAUDE.md`).
 *
 * Drawn in the overlay's own coordinates, so it is correct wherever lane A
 * puts the overlay, and `pointer-events: none` throughout so it can never
 * become the thing under the pointer.
 */
function Targeter({ overlay, drag, root }: { overlay: HTMLElement; drag: DragState; root: ParentNode }) {
  const box = overlay.getBoundingClientRect();
  const snap = drag.target === null ? null : boxOf(root, drag.target);
  const tip = snap === null ? drag.at : centreOf(snap);
  const x1 = drag.from.x - box.left;
  const y1 = drag.from.y - box.top;
  const x2 = tip.x - box.left;
  const y2 = tip.y - box.top;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 13;
  const spread = 0.42;
  const points = [
    `${x2},${y2}`,
    `${x2 - head * Math.cos(angle - spread)},${y2 - head * Math.sin(angle - spread)}`,
    `${x2 - head * Math.cos(angle + spread)},${y2 - head * Math.sin(angle + spread)}`,
  ].join(' ');

  return createPortal(
    <svg
      className="targeter"
      data-testid="targeter"
      data-source={drag.source ?? undefined}
      data-target={drag.target === null ? undefined : `${drag.target.kind}:${drag.target.id}`}
      data-snapped={snap === null ? undefined : true}
      aria-hidden="true"
    >
      <line className="targeter__shaft" x1={x1} y1={y1} x2={x2} y2={y2} />
      <polygon className="targeter__head" points={points} />
    </svg>,
    overlay,
  );
}

export function LiveBoard({ match }: { match: LiveMatch }) {
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
  const offered = boardInteraction(match);
  const interaction: BoardInteraction = {
    ...offered,
    onSelectCard: (cardId) => selectCard(match, cardId),
    onSelectPlayer: (playerId) => selectPlayer(match, playerId),
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // The live handle: window listeners are registered once per gesture and must
  // see the CURRENT drag, not the one they closed over.
  const dragRef = useRef<DragState | null>(null);

  // Lane A's overlay root, looked up after every render: it is not ours to
  // render, it may not exist at all, and when it does not the arrow is simply
  // not drawn. Same-value writes are dropped, so this does not loop.
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const found = rootRef.current?.querySelector<HTMLElement>('[data-board-overlay]') ?? null;
    setOverlay((previous) => (previous === found ? previous : found));
  });

  function update(next: DragState | null): void {
    dragRef.current = next;
    setDrag(next);
  }

  useLayoutEffect(() => {
    if (drag === null) return undefined;
    const move = (event: PointerEvent): void => {
      const held = dragRef.current;
      if (held === null) return;
      const at = { x: event.clientX, y: event.clientY };
      const moved = held.moved || Math.hypot(at.x - held.press.x, at.y - held.press.y) >= DRAG_SLOP_PX;
      update({ ...held, at, moved, target: targetUnder(event.target, boardInteraction(match)) });
    };
    const up = (event: PointerEvent): void => {
      const held = dragRef.current;
      update(null);
      if (held === null || !held.moved) return;
      commitDrag(match, held, event.target);
    };
    const cancel = (): void => update(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [drag === null, match]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    // Left button only: a right-click is Forge's own menu on the desktop and
    // is not this gesture's to take.
    if (event.button !== 0) return;
    const at = { x: event.clientX, y: event.clientY };
    const under = targetUnder(event.target, offered);
    if (under !== null && under.kind === 'card') {
      const box = rootRef.current === null ? null : cardBox(rootRef.current, under.id);
      update({ source: under.id, press: at, from: box === null ? at : centreOf(box), at, target: under, moved: false });
      return;
    }
    // Inside a selection the gesture may start anywhere on the table: the
    // spell doing the targeting is not itself one of Forge's choices, so
    // there is often no offered card to drag FROM.
    if (match.selectables === null) return;
    if (!(event.target instanceof Element) || event.target.closest('.board') === null) return;
    update({ source: null, press: at, from: at, at, target: under, moved: false });
  }

  return (
    <div
      className="live"
      ref={rootRef}
      onPointerDown={onPointerDown}
      data-dragging={drag !== null && drag.moved ? true : undefined}
    >
      {overlay !== null && drag !== null && drag.moved && (
        <Targeter overlay={overlay} drag={drag} root={rootRef.current ?? document} />
      )}
      <p className="live__status" role="status" data-testid="live-status">
        {statusLine(match)}
      </p>
      {match.lastError !== null && (
        <p className="live__error" role="alert" data-testid="live-error">
          {match.lastError}
        </p>
      )}
      {match.view === null ? (
        <p className="live__waiting">Waiting for the game state.</p>
      ) : (
        <Board view={match.view} interaction={interaction} />
      )}
      <div className="live__buttons" data-testid="live-buttons">
        <p className="live__says" data-testid="live-says">
          {match.prompt ?? ''}
        </p>
        {/*
         * The says, newest at the bottom. Always rendered, always two lines
         * tall: an empty log is an empty slot, never a bar that changed shape.
         * Brace notation is said in words, as every other rules text is.
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
          data-testid="live-button-ok"
          disabled={ask !== null || bar === null || !bar.enable1}
          onClick={() => pressButton(match, 'ok')}
        >
          {bar === null || bar.label1 === '' ? 'OK' : bar.label1}
        </button>
        <button
          type="button"
          data-testid="live-button-cancel"
          disabled={ask !== null || bar === null || !bar.enable2}
          onClick={() => pressButton(match, 'cancel')}
        >
          {bar === null || bar.label2 === '' ? 'Cancel' : bar.label2}
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
    </div>
  );
}
