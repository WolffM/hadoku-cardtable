/*
 * `#/replay/<matchId>` — a recorded match, played back through a transport
 * bar (wave 77 §B, `docs/planning/wave77-2026-10-27.md`).
 *
 * Structurally the same shape as `screens/MatchScreen.tsx`: it owns the
 * `LiveMatch` handle's lifetime (built on `./replayTransport.ts` instead of a
 * socket) and opens it on mount, closes it on unmount. It reuses
 * `screens.css`'s `.shell--match` (never edited here) for the SAME reason
 * `MatchScreen` does — `LiveBoard`'s own table-fit math expects that shell —
 * and overlays the transport bar absolutely inside the same relative
 * container `MatchScreen` already uses for its own chrome, rather than
 * taking height away from the board as a flex sibling would. That is what
 * "wrap it, never edit it" means for a CSS file this lane does not own.
 *
 * `roomId` is always `null`: a replay has no room to go back to, and
 * `LiveBoard`'s own "Back to the lobby" fallback is exactly the right answer
 * for it.
 */

import { useEffect, useState } from 'react';

import { LiveBoard } from '../play/live/LiveBoard.tsx';
import { closeMatch, startMatch, type LiveMatch } from '../play/live/match.ts';
import { useChromeShell } from '../chrome/shell.ts';
import { createReplayTransport, type ReplayClock } from './replayTransport.ts';
import { fetchReplay } from './transport.ts';
import { TransportBar } from './TransportBar.tsx';
import './replay.css';

export interface ReplayScreenProps {
  matchId: string;
}

type Loaded = { match: LiveMatch; clock: ReplayClock };

export function ReplayScreen({ matchId }: ReplayScreenProps) {
  const shellRef = useChromeShell('match');
  const [state, setState] = useState<{ loaded: Loaded | null; error: string | null }>({ loaded: null, error: null });

  useEffect(() => {
    setState({ loaded: null, error: null });
    let live = true;
    let built: Loaded | null = null;
    fetchReplay(matchId).then(
      (data) => {
        if (!live) return;
        if (data === null) {
          setState({ loaded: null, error: 'No replay of this match.' });
          return;
        }
        const { transport, clock } = createReplayTransport(data);
        const match = startMatch({ matchId: data.header.matchId, transport });
        built = { match, clock };
        setState({ loaded: built, error: null });
      },
      (err: unknown) => {
        if (live) setState({ loaded: null, error: err instanceof Error ? err.message : 'Could not load the replay.' });
      },
    );
    return () => {
      live = false;
      if (built !== null) {
        closeMatch(built.match);
        built.clock.dispose();
      }
    };
  }, [matchId]);

  return (
    <div ref={shellRef} className="shell shell--match replay-screen" data-testid="replay" style={{ position: 'relative' }}>
      {state.error !== null && <p className="replay-screen__error">{state.error}</p>}
      {state.loaded !== null && (
        <>
          <LiveBoard match={state.loaded.match} roomId={null} />
          <TransportBar clock={state.loaded.clock} className="replay-screen__bar" />
        </>
      )}
    </div>
  );
}
