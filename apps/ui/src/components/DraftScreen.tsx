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
 */

import { useState } from 'react';

import type { DraftView } from '../draft/types.ts';
import {
  explainRejection,
  isAwaitingConfirmation,
  pick,
  pickBlockedBy,
  visiblePack,
  visiblePool,
  type TableState,
} from '../draft/table.ts';
import { DraftCounters } from './DraftCounters.tsx';
import { PackView, type PackLayout } from './PackView.tsx';
import { PoolView } from './PoolView.tsx';
import { SeatBar } from './SeatBar.tsx';

export interface DraftScreenProps {
  state: TableState;
  onChange: (next: TableState) => void;
  /** The next authoritative payload, when the fixture stream has one. */
  nextPayload?: DraftView | null;
  onAdvance?: () => void;
  layout?: PackLayout;
  onLayoutChange?: (layout: PackLayout) => void;
}

export function DraftScreen({
  state,
  onChange,
  nextPayload = null,
  onAdvance,
  layout: layoutProp,
  onLayoutChange,
}: DraftScreenProps) {
  const [localLayout, setLocalLayout] = useState<PackLayout>('fan');
  const layout = layoutProp ?? localLayout;
  const setLayout = onLayoutChange ?? setLocalLayout;

  const [message, setMessage] = useState<string | null>(null);
  const { view } = state;
  const spectating = view.viewer.kind === 'spectator';
  const blocked = pickBlockedBy(state);
  const awaiting = isAwaitingConfirmation(state);

  const handlePick = (cardId: string): void => {
    const result = pick(state, cardId);
    if (!result.ok) {
      setMessage(explainRejection(result.rejection));
      return;
    }
    setMessage(null);
    onChange(result.state);
  };

  const emptyNote = spectating
    ? 'Spectating — a spectator payload carries no pack.'
    : awaiting
      ? 'Picked. The pack has moved on; waiting for the next one.'
      : 'This pack is empty.';

  return (
    <div className="draft" data-testid="draft-screen" data-draft-id={view.draftId}>
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

      <p className="draft__status" data-testid="status" role="status">
        {spectating
          ? 'You are spectating. No pack, no pool — by construction.'
          : awaiting
            ? 'Pick sent. Waiting for the next payload.'
            : blocked?.reason === 'not-your-turn'
              ? 'You have already picked from this pack.'
              : `Your pick — ${visiblePack(state).length} cards in the pack.`}
        {message && <span className="draft__error"> {message}</span>}
      </p>

      <div className="draft__body">
        <main className="draft__main">
          <PackView
            cards={visiblePack(state)}
            layout={layout}
            onPick={handlePick}
            disabled={blocked !== null}
            emptyNote={emptyNote}
          />
          {!spectating && <PoolView cards={visiblePool(state)} />}
        </main>
        <aside className="draft__aside">
          <SeatBar view={view} />
        </aside>
      </div>
    </div>
  );
}
