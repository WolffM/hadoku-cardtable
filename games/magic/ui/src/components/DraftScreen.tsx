/**
 * The whole draft surface: counters, seats, pack, pool.
 *
 * ## This is the interior of the canvas slot, and nothing else
 *
 * D6 puts the draft inside the room's central canvas slot. What that means here
 * is a hard boundary: this component renders a draft and takes a payload as a
 * prop. There is no socket, no room chrome, no participant list, no chat, and
 * no dependency on watchparty's UI package. When this is embedded in a later
 * wave, the thing that changes is where `view` comes from.
 *
 * The package names are spelled out nowhere in `apps/ui` on purpose: the ban on
 * importing them is checked with a grep, and a grep cannot tell a comment
 * promising not to import something from an import.
 *
 * ## Why the pack empties on a pick instead of advancing
 *
 * `table.ts` holds the pending pick; see its header. The short version is that
 * this client does not know the next pack, so it says so rather than inventing
 * one. The pool updates immediately, the counters do not — a pick is not
 * complete until the server says it is.
 *
 * ## A pick is a transform, not a pop — a FLIP, on the real tile
 *
 * The state update is instant — the card has to leave the pack the moment it
 * is clicked, so a second click never lands on a card already gone. What is
 * NOT instant is how the pool reads it: `handlePick` reads the clicked pack
 * slot's own `getBoundingClientRect()` BEFORE the state change removes it, and
 * hands that rect to `PoolView` as `recentlyAdded`. The pool draws the new
 * card where it belongs, in its colour bucket, and `PoolView`'s own tile then
 * positions ITSELF at the pack's old rect with no transition, forces layout,
 * and transitions back to `transform: none` — a First-Last-Invert-Play on the
 * one real element, never a second ghost element flown across the screen.
 *
 * No animation at all when the pack slot cannot be found (a picked card
 * restored from a snapshot rather than clicked — a refresh lands here) or the
 * viewer has asked for less motion: `recentlyAdded` is `null` in both cases,
 * and a `null` `from` is `PoolView`'s whole "skip it" signal.
 *
 * A card dragged out of the pack (`packDrag.ts`) is the same pick, flown from
 * where its copy was let go instead of from its slot. Let go over the
 * sideboard, it is filed there before it is first painted, so it flies
 * straight to the sideboard's pile and is never seen in the deck's.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { usePrefs } from '@wolffm/prefs-client/react';

import type { ConnectionState } from '../draft/connection.ts';
import { viewerSeat, type DraftView } from '../draft/types.ts';
import {
  explainRejection,
  isAwaitingConfirmation,
  isDraftComplete,
  pick,
  pickBlockedBy,
  visiblePack,
  visiblePool,
  type ExtraPick,
  type TableState,
} from '../draft/table.ts';
import { ConnectionBanner } from '@hadoku/game-ui/components/ConnectionBanner.tsx';
import { DeckView } from './DeckView.tsx';
import { CARD_RATIO, cssPx, fitGrid, smallestFitHeight, useBox, useFitScale } from './cardFit.ts';
import { useNewPackSound } from '../draft/packSound.ts';
import { FAN_MIN_WIDTH, fanGeometry, fanLayer, fanX, MAX_CARD_H, packFitStyle, packRowHeight, PackView, phoneFanGeometry, PickRope, POOL_MIN_H, usePhoneLayout, type PackDrop, type PackLayout } from './PackView.tsx';
import { Icon } from '@wolffm/themes';
import { Popover, usePopover } from '@hadoku/game-ui/components/Popover.tsx';
import type { Area } from '../deck/dragMove.tsx';
import { PoolView, POOL_ENTER_MS, type PoolEnterRect } from './PoolView.tsx';
import { useDraftBuild, type DraftBuildStore } from '../deck/useDraftBuild.ts';
import { Ghost, SeatBar, SeatBarSkeleton } from './SeatBar.tsx';
import { SpectatorNotice } from './SpectatorNotice.tsx';
import { prefersReducedMotion } from '@hadoku/ui-shell/motion';
import { getPlayPrefsClient, PLAY_PREFS_DEFAULTS } from '../play/live/prefs.ts';
import { uiLength, uiPx } from '@hadoku/ui-shell/settings';
import './draft.css';

const rectOf = (r: DOMRect): PoolEnterRect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

export interface DraftScreenProps {
  state: TableState;
  onChange: (next: TableState) => void;
  /** The next authoritative payload, when the fixture stream has one. */
  nextPayload?: DraftView | null;
  /**
   * Told that the local player took a card, after the optimistic update.
   *
   * The screen still applies the pick to its own state first, so the pool
   * updates the instant it is clicked whatever the source is doing. This is
   * what a live source uses to send the pick on — in-process today, over a
   * socket later. Absent for a fixture source, where nothing can be sent.
   * `extra` is the second card of a two-card pick and the face-up card that
   * pays for it.
   */
  onPick?: (cardId: string, extra?: ExtraPick) => void;
  /** The card this seat would take if its timed pick ran out (`PackView`'s `onLean`); absent where nothing listens. */
  onLean?: (cardId: string | null) => void;
  onAdvance?: () => void;
  /**
   * What the connection is doing, for the banner above the table.
   *
   * Optional, and absent means "do not render one" rather than "assume
   * healthy" — the in-process and fixture sources have no connection to report
   * on and should not claim one. Compute it with `connectionState()` over
   * `connectionFacts(draft)`; see `draft/connection.ts`.
   */
  connection?: ConnectionState | null;
  /**
   * Where the finished deck's `.dck` goes. Absent means the browser downloads
   * it, which is what production wants; a test passes one to read the bytes.
   */
  onDownloadDeck?: (filename: string, text: string) => void;
  /** The room's name, drawn when there is no `side` to name it. A screen with no room says Draft. */
  title?: string;
  /** The room's own bar, drawn at the top of the side column (`PodScreen`). */
  side?: ReactNode;
  /** A spectator's choice of whose pack and picks to watch. Absent: the seats are not pressable. */
  onWatch?: (seatId: number) => void;
  /** Where the drafter's build is kept (`useDraftBuild`). Absent: the split lives in this screen only. */
  buildStore?: DraftBuildStore | null;
  /** The view arrived whole (a join, a rejoin, a watch), not as the draft's next step: the pod is drawn still (`SeatBar`). */
  arrivedWhole?: boolean;
}

/** The nearest ancestor of `el` that scrolls vertically, if any. */
function scrollBoxOf(el: HTMLElement): HTMLElement | null {
  for (let a = el.parentElement; a !== null && a !== document.body; a = a.parentElement) {
    if (/^(auto|scroll)$/.test(getComputedStyle(a).overflowY)) return a;
  }
  return null;
}

/**
 * The draft body's ref: exactly as tall as the window below it, so the two
 * rows fill the screen and the page itself never scrolls (`draft.css`,
 * layout), and the pack's row out of that height (`packRowHeight`), fan or
 * grid, leaving the picks' row at least what the pod's column beside them
 * needs at its smallest fit. The pod's skeleton (`PodScreen.tsx`) wears it
 * too, so the draft lands on the same lines.
 */
export function fitToWindow(el: HTMLDivElement | null): (() => void) | undefined {
  if (el === null || typeof window === 'undefined') return undefined;
  const aside = el.querySelector<HTMLElement>(':scope > .draft__aside');
  // The box the screen scrolls in when it is not the page: a room's, pinned to the window beside its chat (`chrome.css`).
  const box = scrollBoxOf(el);
  const fit = (): void => {
    // Everything from the body's top to the window's bottom, less whatever
    // that pushes off the page or out of its box (the shell's padding,
    // anything after the body): set, measure the overflow, take it back.
    // Always from the full height, so a window that grows gets the room back.
    const full = Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY + (box?.scrollTop ?? 0)));
    el.style.setProperty('--draft-h', `${Math.max(300, full)}px`);
    const style = getComputedStyle(el);
    // A phone's column (`draft.css`) scrolls with the page on purpose: there the row is the window's, not what is left of it.
    const rows = style.display === 'grid';
    const over = rows ? Math.max(document.documentElement.scrollHeight - window.innerHeight, box === null ? 0 : box.scrollHeight - box.clientHeight) : 0;
    const height = over > 0 ? Math.max(300, full - over) : Math.max(300, full);
    if (over > 0) el.style.setProperty('--draft-h', `${height}px`);
    const inner = height - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0) - (parseFloat(style.rowGap) || 0);
    const unit = uiPx(1, el);
    // Beside the picks, the pod's column must still be whole at its smallest fit: the room's bar is as tall as its room makes it.
    const keep = Math.max(POOL_MIN_H * unit, rows && aside !== null ? smallestFitHeight(aside) : 0);
    const packRow = packRowHeight(inner, unit, keep);
    el.style.setProperty('--pack-row', `${packRow.toFixed(1)}px`);
    el.style.setProperty('--picks-row', `${(inner - packRow).toFixed(1)}px`);
  };
  fit();
  window.addEventListener('resize', fit);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
  observer?.observe(document.body);
  // In a pinned box the page never grows: a line drawn above the body (the room's error) is seen by the screen's own size.
  if (el.parentElement !== null) observer?.observe(el.parentElement);
  // The column's own parts (a watcher joins the room's bar): measured again on the next frame, not inside
  // this delivery, where a row that changed would resize the column already reported this frame.
  let frame = 0;
  const parts = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  });
  for (const part of aside?.children ?? []) parts?.observe(part);
  return () => {
    window.removeEventListener('resize', fit);
    observer?.disconnect();
    parts?.disconnect();
    cancelAnimationFrame(frame);
  };
}

/** The pack's layout: the player's own, wherever they draft next (`play/live/prefs.ts`). */
export function usePackLayout(): [PackLayout, (layout: PackLayout) => void] {
  const { prefs, save } = usePrefs(getPlayPrefsClient());
  return [prefs?.packLayout ?? PLAY_PREFS_DEFAULTS.packLayout, (packLayout) => void save({ packLayout })];
}

export function PackLayoutControl({ layout, onLayout }: { layout: PackLayout; onLayout: (layout: PackLayout) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Pack layout">
      {(['fan', 'grid'] as const).map((option) => (
        <button key={option} type="button" className={layout === option ? 'segmented__on' : ''} aria-pressed={layout === option} onClick={() => onLayout(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

/**
 * The draft's controls, listed in a panel the (i) button opens. The operator, 2026-11-19: *"show an
 * (i) button that makes a popout modal explaining the controls of the draft: the arrow keys,
 * hovering to expand, mouse-wheel to see transforms, and enter to select."* This is their asked-for
 * exception to "no explanatory UI text": keep it, and keep it to the list of controls — each one the
 * pack answers to, the two drags (`packDrag.ts`) among them, and nothing else.
 */
const PACK_CONTROLS: readonly (readonly [control: string, does: string])[] = [
  ['Arrow keys', 'Move along the pack'],
  ['Hover', 'Enlarge a card'],
  ['Mouse wheel', 'Turn an enlarged card to its other faces'],
  ['Enter', 'Take the card'],
  ['Drag a card onto your pool', 'Take it'],
  ['Drag a card onto the sideboard', 'Take it into your sideboard'],
  ['Drag the fan sideways', 'Scroll it'],
];

function PackHelp() {
  const { trigger, toggle, close } = usePopover();
  return (
    <>
      <button type="button" className="pack__help" aria-label="Draft controls" aria-expanded={trigger !== null} data-testid="pack-help" onClick={(event) => toggle(event.currentTarget)}>
        <Icon name="info" size={uiLength('0.95rem')} />
      </button>
      {trigger !== null && (
        <Popover trigger={trigger} onClose={close} title="Draft controls" testId="pack-controls">
          <dl className="pack__controls">
            {PACK_CONTROLS.map(([control, does]) => (
              <div key={control} className="pack__control">
                <dt>{control}</dt>
                <dd>{does}</dd>
              </div>
            ))}
          </dl>
        </Popover>
      )}
    </>
  );
}

/**
 * The pack's own controls: the controls list and fan or grid. Not in the pack's box, which is all
 * cards (the operator, 2026-11-19: *"can we put the fan|grid and info buttons next to the close button
 * so we dont lose any space in the drafting area?"*): whoever draws the room's bar puts them in it,
 * beside Close (`PodScreen`), and a draft with no room draws them under its own title.
 */
export function PackTools({ skeleton = false }: { skeleton?: boolean }) {
  const [layout, setLayout] = usePackLayout();
  return (
    <div className="pack__tools" data-testid="pack-tools" data-skeleton={skeleton ? 'controls' : undefined}>
      <PackHelp />
      <PackLayoutControl layout={layout} onLayout={setLayout} />
    </div>
  );
}

export function DraftScreen({
  state,
  onChange,
  nextPayload = null,
  onPick,
  onLean,
  onAdvance,
  connection = null,
  onDownloadDeck,
  title = 'Draft',
  side,
  onWatch,
  buildStore = null,
  arrivedWhole = false,
}: DraftScreenProps) {
  const [layout] = usePackLayout();
  const fitAside = useFitScale();

  const [message, setMessage] = useState<string | null>(null);
  const { view } = state;
  useNewPackSound(view);
  const spectating = view.viewer.kind === 'spectator';
  const watching = view.viewer.kind === 'watcher';
  const blocked = pickBlockedBy(state);
  const awaiting = isAwaitingConfirmation(state);
  const complete = isDraftComplete(state);
  // A pick made while the socket is down would be emitted into nothing and
  // then look, to the player, like it was taken. The connection says whether
  // the table is stalled; when it is, the cards do not respond.
  const stalled = connection?.stalled ?? false;
  // Picked, and the pack not yet passed: the cards left in it are not this
  // seat's to take, so the pack gives way to the wait rather than sitting dimmed.
  const waiting = blocked?.reason === 'not-your-turn';
  // The rope burns over the pick in front of the seat: gone once it is made, and for nobody's seat.
  const rope = view.viewer.kind === 'spectator' || waiting || (!watching && blocked !== null) ? undefined : view.viewer.timer;

  // The viewer's own picks are their build; a watched drafter's are only looked at.
  const pool = useMemo(() => visiblePool(state), [state]);
  const build = useDraftBuild(view.draftId, pool, watching ? null : buildStore, !awaiting);

  // Referentially stable, because `CardTile` is memoised and this is the prop
  // it compares. A fresh closure per render would make every tile re-render on
  // every pick and quietly undo the memo — the failure would be invisible in
  // tests and visible only as lag late in a draft.
  // The callback must not close over `state`, which changes on every pick —
  // that was the first attempt and it did nothing, because the new closure
  // identity defeated the memo just as surely as no memo at all. A ref gives
  // the handler the current state without making the handler itself change.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Where the just-picked card's pack slot was, read off the real DOM — the
  // FLIP's "first". Cleared by its own effect rather than inline in
  // `handlePick`, so a pick that lands while the previous one is still
  // animating restarts the timer against the NEW card, not the old one.
  const [recentlyAdded, setRecentlyAdded] = useState<{ cardId: string; from: PoolEnterRect } | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (recentlyAdded === null) return;
    const timer = setTimeout(() => setRecentlyAdded(null), POOL_ENTER_MS);
    return () => clearTimeout(timer);
  }, [recentlyAdded]);

  // A face-up card of the seat's own that buys a second card from this pack
  // (the view's `extraPick`). Pressed, the next card pressed is held as the
  // first of the two and the one after it sends both.
  const extraWith = watching ? undefined : viewerSeat(view)?.extraPick?.[0];
  const extraCard = extraWith === undefined ? undefined : pool.find((c) => c.cardId === extraWith);
  const [extraArmed, setExtraArmed] = useState(false);
  const [extraFirst, setExtraFirst] = useState<string | null>(null);
  const extraRef = useRef<{ with: string; first: string | null } | null>(null);
  extraRef.current = extraArmed && extraWith !== undefined ? { with: extraWith, first: extraFirst } : null;
  /** The button that arms it, in the pod's column while this seat has a pack to take from. */
  const extraShown = waiting || awaiting ? undefined : extraCard;
  // A new pack starts with nothing pressed and nothing held.
  const pickKey = `${view.packNumber}:${view.pickNumber}`;
  useEffect(() => {
    setExtraArmed(false);
    setExtraFirst(null);
  }, [pickKey]);

  /** A card dragged out of the pack, in the air: the area it would land in is lit (`PoolView`). */
  const [lift, setLift] = useState<{ over: Area | null } | null>(null);
  /** The pick let go over the sideboard: filed there once the pool holds it, before it is painted in the deck. */
  const [toSideboard, setToSideboard] = useState<string | null>(null);
  const moveBuild = build.move;
  useLayoutEffect(() => {
    if (toSideboard === null || !pool.some((c) => c.cardId === toSideboard)) return;
    moveBuild(toSideboard, 'pool');
    setToSideboard(null);
  }, [toSideboard, pool, moveBuild]);

  const handlePick = useCallback(
    (cardId: string, drop?: PackDrop): void => {
      const two = extraRef.current;
      if (two !== null && (two.first === null || two.first === cardId)) {
        setExtraFirst(two.first === null ? cardId : null);
        return;
      }
      const first = two?.first ?? cardId;
      const extra = two === null ? undefined : { cardId, with: two.with };
      const result = pick(stateRef.current, first, extra);
      if (!result.ok) {
        setMessage(explainRejection(result.rejection));
        return;
      }
      setMessage(null);
      // Read the clicked tile's rect NOW, synchronously, before `onChange`
      // below schedules the re-render that removes it from the pack — this is
      // the one moment the DOM still shows where it was. Neither a snapshot
      // restore nor a reduced-motion viewer reaches this call with a real
      // rect, and both read as "no animation" the same way: `null`.
      const tile = prefersReducedMotion()
        ? null
        : mainRef.current?.querySelector<HTMLElement>(`.pack [data-testid="card"][data-card-id="${CSS.escape(cardId)}"]`);
      // A dragged card flies from where it was let go, not from the slot it left.
      setRecentlyAdded(tile ? { cardId, from: drop?.from ?? rectOf(tile.getBoundingClientRect()) } : null);
      setToSideboard(drop?.to === 'pool' ? cardId : null);
      onChange(result.state);
      onPick?.(first, extra);
    },
    [onChange, onPick],
  );


  const emptyNote = spectating
    ? 'Spectating.'
    : watching
      ? 'Waiting for the next pack.'
      : stalled
        ? 'Reconnecting — seat held.'
        : awaiting || waiting
          ? 'Waiting for the next pack.'
          : 'This pack is empty.';

  return (
    <div
      className="draft"
      data-testid="draft-screen"
      data-draft-id={view.draftId}
      data-viewer={view.viewer.kind}
      data-complete={complete ? 'true' : 'false'}
    >
      {connection && <ConnectionBanner state={connection} />}
      {spectating && <SpectatorNotice seatCount={view.seats.length} />}

      {message && (
        <p className="draft__status" data-testid="draft-refused" role="alert">
          <span className="ct-error">{message}</span>
        </p>
      )}

      <div className={complete ? 'draft__body draft__body--complete' : 'draft__body'} ref={fitToWindow}>
        <main className="draft__main" ref={mainRef}>
          {complete ? (
            <DeckView
              draftId={view.draftId}
              pool={pool}
              {...(onDownloadDeck ? { onDownload: onDownloadDeck } : {})}
            />
          ) : (
            <>
              {rope !== undefined && <PickRope timer={rope} pickKey={`${view.packNumber}:${view.pickNumber}`} />}
              <PackView
                cards={waiting ? [] : visiblePack(state)}
                layout={layout}
                onPick={watching ? undefined : handlePick}
                onLift={setLift}
                // Only a timed pick of the seat's own has anything to lean toward.
                onLean={watching || rope === undefined ? undefined : onLean}
                disabled={!watching && (blocked !== null || stalled)}
                emptyNote={emptyNote}
                chosen={extraFirst}
              />
              {!spectating && (
                <PoolView
                  cards={pool}
                  recentlyAdded={recentlyAdded}
                  {...(watching ? {} : { sideboard: build.sideboard, onMove: build.move, dropping: lift })}
                  owner={view.viewer.kind === 'watcher' ? (view.seats[view.viewer.seatId]?.displayName ?? null) : null}
                />
              )}
            </>
          )}
        </main>
        {/* One column: the room's bar and the pod as a circle with the pack and pick at its
            centre (the operator, 2026-10-19: "we could reclaim a lot of vertical space in that
            way"; 2026-10-21: the pod as a circle). Under the pack, beside the picks, in either
            layout (`draft.css`). */}
        <aside className="draft__aside fit-scale" ref={fitAside}>
          {side}
          {/* The room's bar names the room already. */}
          {side === undefined && (
            <header className="draft__bar">
              <h1 className="draft__title" data-testid="draft-title">
                {title}
              </h1>
              <div className="draft__controls">
                <PackTools />
              </div>
            </header>
          )}
          <SeatBar view={view} onWatch={onWatch} arrivedWhole={arrivedWhole} />
          <FaceUpCards view={view} />
          {(extraShown !== undefined || onAdvance) && (
            <header className="draft__bar">
              <div className="draft__controls">
                {extraShown !== undefined && (
                  <button
                    type="button"
                    className="button"
                    data-testid="extra-pick"
                    aria-pressed={extraArmed}
                    disabled={blocked !== null || stalled}
                    onClick={() => {
                      setExtraArmed((on) => !on);
                      setExtraFirst(null);
                    }}
                  >
                    {extraShown.name}
                  </button>
                )}
                {onAdvance && (
                  <button type="button" className="button" data-testid="advance" disabled={nextPayload === null} onClick={onAdvance}>
                    {nextPayload ? `Next payload (seq ${nextPayload.seq})` : 'No further payload'}
                  </button>
                )}
              </div>
            </header>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The cards drafted face up, by seat: public to the whole table (`DraftSeatView.faceUp`). Nothing when no seat has one. */
function FaceUpCards({ view }: { view: DraftView }) {
  const seats = view.seats.filter((s) => (s.faceUp?.length ?? 0) > 0);
  if (seats.length === 0) return null;
  return (
    <ul className="draft__faceup" data-testid="face-up">
      {seats.map((s) => (
        <li key={s.id} data-testid={`face-up-${s.id}`}>
          {s.displayName}: {s.faceUp?.map((c) => c.name).join(', ')}
        </li>
      ))}
    </ul>
  );
}

/* ── until the draft's table arrives ──────────────────────────────────── */

/** How many backs the skeleton's pack is dealt: a pack's worth, as many as the fan draws. */
export const GHOST_PACK = 15;

/**
 * The draft's own layout with nothing in it yet (`PodScreen`, until the
 * table arrives): the pack as backs in the places its cards will take, the
 * picks' header, the pod's ring with its faces and counters, and the pack's
 * controls, each in the box the draft draws it in, so the draft lands on
 * the same lines and the page changes once (the operator, 2026-10-20: *"can we
 * add a loading skeleton while this is still loading so i dont see the page
 * change so many times?"*; 2026-10-28: *"improve the loading skeleton so it
 * looks a bit better"*). `seats` is the pod's size, when the room knows it.
 */
export function DraftSkeleton({ side, seats = 8 }: { side?: ReactNode; seats?: number }) {
  const [layout] = usePackLayout();
  const fitAside = useFitScale();
  return (
    <div className="draft draft--skeleton" data-testid="pod-waiting" aria-busy="true">
      <div className="draft__body" ref={fitToWindow}>
        <main className="draft__main">
          <PackSkeleton layout={layout} />
          <section className="pool" data-skeleton="pool" aria-hidden="true">
            <header className="pool__head" data-skeleton="pool-head">
              {/* The real title's own line: a heading with its count, whose 16px line sets the header's height. */}
              <h2 className="pool__title">
                <Ghost em={7} />
                <span>{'\u00a0'}</span>
              </h2>
              <span className="pool__colors">
                {Array.from({ length: 5 }, (_, i) => (
                  <span key={i} className="pool__color">
                    <span className="draft-ghost draft-ghost--pip" />
                  </span>
                ))}
              </span>
            </header>
          </section>
        </main>
        <aside className="draft__aside fit-scale" ref={fitAside}>
          {side}
          {side === undefined && (
            <header className="draft__bar">
              <div className="draft__controls">
                <PackTools skeleton />
              </div>
            </header>
          )}
          <SeatBarSkeleton seats={seats} />
        </aside>
      </div>
    </div>
  );
}

/**
 * The pack as `PackView` lays it out, dealt face down: the same slots, fan or grid, at the same sizes
 * — the phone grid included (`usePhoneLayout`), which is plain CSS and needs no box measured at all.
 * The phone FAN is measured, the same as the desktop fan, just through `phoneFanGeometry` instead of
 * `fanGeometry` (`PackView.tsx`'s header has the real card's own version of this split).
 */
export function PackSkeleton({ layout }: { layout: PackLayout }) {
  const [measure, box, root] = useBox<HTMLDivElement>();
  const measured = box.width > 0 && box.height > 0;
  const maxH = uiPx(MAX_CARD_H, root);
  const phone = usePhoneLayout();
  const desktopFan = !phone && layout === 'fan' && measured && box.width >= FAN_MIN_WIDTH ? fanGeometry(box.width, box.height, maxH) : null;
  const desktopGrid = !phone && desktopFan === null && measured ? fitGrid(GHOST_PACK, box, cssPx(root, 'column-gap', 10), maxH * CARD_RATIO) : null;
  const phoneFan = phone && layout === 'fan' && measured ? phoneFanGeometry(box.width, box.height, maxH) : null;
  const mode: PackLayout = phone ? layout : !measured ? (layout === 'fan' ? 'fan' : 'grid') : desktopFan !== null ? 'fan' : 'grid';
  const style = packFitStyle(desktopFan ?? phoneFan, desktopGrid);
  return (
    <div className={`pack pack--${mode}`} data-skeleton="pack" aria-hidden="true" ref={measure} style={style}>
      {measured &&
        Array.from({ length: GHOST_PACK }, (_, i) => {
          const x = desktopFan === null ? null : fanX(desktopFan, i, 0, GHOST_PACK);
          if (desktopFan !== null && x === null) return null;
          return (
            <div
              key={i}
              className="pack__slot"
              data-focused={mode === 'fan' && i === 0 ? '' : undefined}
              style={x === null ? undefined : ({ '--fan-x': `${x.toFixed(1)}px`, zIndex: fanLayer(i, 0, GHOST_PACK) } as CSSProperties)}
            >
              <span className="card-back draft-ghost__card" />
            </div>
          );
        })}
    </div>
  );
}
