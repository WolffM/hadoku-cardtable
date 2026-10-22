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
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ConnectionState } from '../draft/connection.ts';
import type { DraftView } from '../draft/types.ts';
import {
  explainRejection,
  isAwaitingConfirmation,
  isDraftComplete,
  pick,
  pickBlockedBy,
  visiblePack,
  visiblePool,
  type TableState,
} from '../draft/table.ts';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { DeckView } from './DeckView.tsx';
import { useFitScale } from './cardFit.ts';
import { useNewPackSound } from '../draft/packSound.ts';
import { PackView, type PackLayout } from './PackView.tsx';
import { PoolView, POOL_ENTER_MS, type PoolEnterRect } from './PoolView.tsx';
import type { GroupBy } from '../deck/cardOrder.ts';
import { useDraftBuild, type DraftBuildStore } from '../deck/useDraftBuild.ts';
import { SeatBar } from './SeatBar.tsx';
import { SpectatorNotice } from './SpectatorNotice.tsx';
import { prefersReducedMotion } from '../play/motion.ts';
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
   */
  onPick?: (cardId: string) => void;
  onAdvance?: () => void;
  layout?: PackLayout;
  onLayoutChange?: (layout: PackLayout) => void;
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
  /** The room's name, drawn when there is no `side` to name it. A screen with no room (the debug harness) says Draft. */
  title?: string;
  /** The room's own bar, drawn at the top of the side column (`PodScreen`). */
  side?: ReactNode;
  /** A spectator's choice of whose pack and picks to watch. Absent: the seats are not pressable. */
  onWatch?: (seatId: number) => void;
  /** Where the drafter's build is kept (`useDraftBuild`). Absent: the split lives in this screen only (the debug harness). */
  buildStore?: DraftBuildStore | null;
}

/**
 * The draft body's ref: exactly as tall as the window below it, so the two
 * halves fill the screen and the page itself never scrolls (`draft.css`,
 * layout). The pod's skeleton (`PodScreen.tsx`) wears it too, so the draft
 * lands on the same lines.
 */
export function fitToWindow(el: HTMLDivElement | null): (() => void) | undefined {
  if (el === null || typeof window === 'undefined') return undefined;
  const fit = (): void => {
    // Everything from the body's top to the window's bottom, less whatever
    // that pushes off the page (the shell's padding, anything after the
    // body): set, measure the overflow, take it back. Always from the full
    // height, so a window that grows gets the room back.
    const full = Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY));
    el.style.setProperty('--draft-h', `${Math.max(300, full)}px`);
    const over = document.documentElement.scrollHeight - window.innerHeight;
    if (over > 0) el.style.setProperty('--draft-h', `${Math.max(300, full - over)}px`);
  };
  fit();
  window.addEventListener('resize', fit);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
  observer?.observe(document.body);
  return () => {
    window.removeEventListener('resize', fit);
    observer?.disconnect();
  };
}

export function DraftScreen({
  state,
  onChange,
  nextPayload = null,
  onPick,
  onAdvance,
  layout: layoutProp,
  onLayoutChange,
  connection = null,
  onDownloadDeck,
  title = 'Draft',
  side,
  onWatch,
  buildStore = null,
}: DraftScreenProps) {
  const [localLayout, setLocalLayout] = useState<PackLayout>('fan');
  const fitAside = useFitScale();
  const layout = layoutProp ?? localLayout;
  const setLayout = onLayoutChange ?? setLocalLayout;

  const [message, setMessage] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('color');
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

  // The viewer's own picks are their build; a watched drafter's are only looked at.
  const pool = useMemo(() => visiblePool(state), [state]);
  const build = useDraftBuild(view.draftId, pool, watching ? null : buildStore);

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

  const handlePick = useCallback(
    (cardId: string): void => {
      const result = pick(stateRef.current, cardId);
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
      setRecentlyAdded(tile ? { cardId, from: rectOf(tile.getBoundingClientRect()) } : null);
      onChange(result.state);
      onPick?.(cardId);
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
        <p className="draft__status draft__error" data-testid="draft-refused" role="alert">
          {message}
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
              <PackView
                cards={waiting ? [] : visiblePack(state)}
                layout={layout}
                onPick={watching ? undefined : handlePick}
                disabled={!watching && (blocked !== null || stalled)}
                emptyNote={emptyNote}
              />
              {!spectating && (
                <PoolView
                  cards={pool}
                  recentlyAdded={recentlyAdded}
                  groupBy={groupBy}
                  onGroupBy={setGroupBy}
                  {...(watching ? {} : { sideboard: build.sideboard, onMove: build.move })}
                  owner={view.viewer.kind === 'watcher' ? (view.seats[view.viewer.seatId]?.displayName ?? null) : null}
                />
              )}
            </>
          )}
        </main>
        {/* One column beside the pack and the picks, the whole height: the room's bar,
            the pod as a circle with the pack and pick at its centre, and the pack's
            layout (the operator, 2026-10-19: "we could reclaim a lot of vertical space
            in that way"; 2026-10-21: the pod as a circle). */}
        <aside className="draft__aside fit-scale" ref={fitAside}>
          {side}
          {/* The room's bar names the room already. */}
          {side === undefined && (
            <h1 className="draft__title" data-testid="draft-title">
              {title}
            </h1>
          )}
          <SeatBar view={view} onWatch={onWatch} />
          <header className="draft__bar">
            <div className="draft__controls">
              <div className="segmented" role="group" aria-label="Pack layout">
                {(['fan', 'grid'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={layout === option ? 'segmented__on' : ''}
                    aria-pressed={layout === option}
                    onClick={() => setLayout(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
              {onAdvance && (
                <button
                  type="button"
                  className="button"
                  data-testid="advance"
                  disabled={nextPayload === null}
                  onClick={onAdvance}
                >
                  {nextPayload ? `Next payload (seq ${nextPayload.seq})` : 'No further payload'}
                </button>
              )}
            </div>
          </header>
        </aside>
      </div>
    </div>
  );
}
