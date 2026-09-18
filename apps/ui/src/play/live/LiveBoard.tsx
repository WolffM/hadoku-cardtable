/*
 * The board, on a live match.
 *
 * `Board` is drawn exactly as the fixture harness draws it — this component
 * adds only what a live source has and a fixture does not: a connection line,
 * an error line, and the one prompt this wave renders. Everything it shows is
 * read off the `LiveMatch` handle (`./match.ts`), which re-renders it through
 * `useSyncExternalStore` on the handle's revision counter.
 */

import { useSyncExternalStore } from 'react';

import { Board } from '../Board.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { answerConfirm, subscribe, type LiveMatch } from './match.ts';
import './live.css';

/** One line of plain words for where the connection is. */
export function statusLine(match: LiveMatch): string {
  if (!match.connected) return match.everConnected ? 'Disconnected — reconnecting…' : 'Connecting…';
  if (match.awaitingSnapshot) return match.stats.snapshots === 0 ? 'Joining the match…' : 'Catching up…';
  if (match.seat === null) return 'Connected, not seated.';
  return `Seat ${match.seat + 1}, live.`;
}

export function LiveBoard({ match }: { match: LiveMatch }) {
  useSyncExternalStore(
    (listener) => subscribe(match, listener),
    () => match.revision,
  );
  const ask = match.pendingAsk;

  return (
    <div className="live">
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
        <Board view={match.view} />
      )}
      {ask !== null && (
        <ConfirmDialog key={ask.callId} ask={ask} onAnswer={(yes) => answerConfirm(match, ask.callId, yes)} />
      )}
    </div>
  );
}
