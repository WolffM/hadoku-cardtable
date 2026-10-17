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

import { useCallback, useEffect, useRef, useState } from 'react';

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
import { DraftCounters } from './DraftCounters.tsx';
import { PackView, type PackLayout } from './PackView.tsx';
import { PoolView, POOL_ENTER_MS, type PoolEnterRect } from './PoolView.tsx';
import { SeatBar } from './SeatBar.tsx';
import { SpectatorNotice } from './SpectatorNotice.tsx';

/** The same check `play/live/numbers.ts`, `placed.ts` and `departures.ts` each make; not theirs to import from here. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
}: DraftScreenProps) {
  const [localLayout, setLocalLayout] = useState<PackLayout>('fan');
  const layout = layoutProp ?? localLayout;
  const setLayout = onLayoutChange ?? setLocalLayout;

  const [message, setMessage] = useState<string | null>(null);
  const { view } = state;
  const spectating = view.viewer.kind === 'spectator';
  const blocked = pickBlockedBy(state);
  const awaiting = isAwaitingConfirmation(state);
  const complete = isDraftComplete(state);
  // A pick made while the socket is down would be emitted into nothing and
  // then look, to the player, like it was taken. The connection says whether
  // the table is stalled; when it is, the cards do not respond.
  const stalled = connection?.stalled ?? false;

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
    : stalled
      ? 'Reconnecting &mdash; seat held.'
      : awaiting
        ? 'Picked &mdash; waiting for the next pack.'
        : 'This pack is empty.';

  return (
    <div
      className="draft"
      data-testid="draft-screen"
      data-draft-id={view.draftId}
      data-viewer={view.viewer.kind}
      data-complete={complete ? 'true' : 'false'}
    >
      <header className="draft__bar">
        <div className="draft__ident">
          <h1 className="draft__title">Draft</h1>
          <code className="draft__id">{view.draftId}</code>
        </div>
        <DraftCounters view={view} />
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

      {connection && <ConnectionBanner state={connection} />}
      {spectating && <SpectatorNotice seatCount={view.seats.length} />}

      <p className="draft__status" data-testid="status" role="status">
        {spectating
          ? 'Spectating.'
          : awaiting
            ? 'Pick sent.'
            : blocked?.reason === 'not-your-turn'
              ? 'You have already picked from this pack.'
              : `Your pick — ${visiblePack(state).length} cards in the pack.`}
        {message && <span className="draft__error"> {message}</span>}
      </p>

      <div className="draft__body">
        <main className="draft__main" ref={mainRef}>
          {complete ? (
            <DeckView
              draftId={view.draftId}
              pool={visiblePool(state)}
              {...(onDownloadDeck ? { onDownload: onDownloadDeck } : {})}
            />
          ) : (
            <>
              <PackView
                cards={visiblePack(state)}
                layout={layout}
                onPick={handlePick}
                disabled={blocked !== null || stalled}
                emptyNote={emptyNote}
              />
              {!spectating && <PoolView cards={visiblePool(state)} recentlyAdded={recentlyAdded} />}
            </>
          )}
        </main>
        <aside className="draft__aside">
          <SeatBar view={view} />
        </aside>
      </div>
    </div>
  );
}
