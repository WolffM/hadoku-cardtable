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
 */

import { Component, useSyncExternalStore, type ReactNode } from 'react';

import { Board } from '../Board.tsx';
import { PromptFor, isPromptMethod, lookupFromState, type AskOf, type PromptMethod } from '../prompts/index.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { abortAsk, answerAsk, answerConfirm, currentAsk, pressButton, subscribe, type LiveAsk, type LiveMatch } from './match.ts';
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
      lookup={lookupFromState(match.state)}
      onAnswer={(reply) => answerAsk(match, ask.callId, ask.method, reply)}
    />
  );
}

export function LiveBoard({ match }: { match: LiveMatch }) {
  useSyncExternalStore(
    (listener) => subscribe(match, listener),
    () => match.revision,
  );
  const ask = currentAsk(match);

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
      {ask === null && match.buttons !== null && (match.buttons.enable1 || match.buttons.enable2) && (
        <div className="live__buttons" data-testid="live-buttons">
          {match.prompt !== null && (
            <p className="live__says" data-testid="live-says">
              {match.prompt}
            </p>
          )}
          <button
            type="button"
            data-testid="live-button-ok"
            disabled={!match.buttons.enable1}
            onClick={() => pressButton(match, 'ok')}
          >
            {match.buttons.label1}
          </button>
          <button
            type="button"
            data-testid="live-button-cancel"
            disabled={!match.buttons.enable2}
            onClick={() => pressButton(match, 'cancel')}
          >
            {match.buttons.label2}
          </button>
        </div>
      )}
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
