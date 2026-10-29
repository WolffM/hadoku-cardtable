/*
 * `#/replay/<matchId>` — a recorded match, played back through a transport
 * bar (wave 77 §B, `docs/planning/wave77-2026-10-27.md`).
 *
 * Structurally the same shape as `screens/MatchScreen.tsx`: it owns the
 * `LiveMatch` handle's lifetime (a read-only board fed by `./player.ts`, not a
 * socket) and opens it on mount, closes it on unmount. Nothing is drawn until
 * the first board and its art are ready (`./load.ts`): a replay never reads
 * "Connecting…". It reuses
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

import { closeMatch, type LiveMatch } from '../play/live/match.ts';
import { useChromeShell } from '../chrome/shell.ts';
import { readyPlayer } from './load.ts';
import { ReplayBoard } from './ReplayBoard.tsx';
import type { ReplayClock } from './player.ts';
import { fetchReplay, reportReplayTrouble } from './transport.ts';
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
    fetchReplay(matchId)
      .then(async (data) => {
        if (!live) return;
        if (data === null) {
          setState({ loaded: null, error: 'No replay of this match.' });
          return;
        }
        const player = await readyPlayer(data);
        built = player;
        if (!live) {
          closeMatch(player.match);
          player.clock.dispose();
          return;
        }
        player.clock.play();
        setState({ loaded: player, error: null });
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : 'Could not load the replay.';
        reportReplayTrouble('load-failed', matchId, { error });
        if (live) setState({ loaded: null, error });
      });
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
          <ReplayBoard match={state.loaded.match} clock={state.loaded.clock} />
          <TransportBar clock={state.loaded.clock} className="replay-screen__bar" />
        </>
      )}
    </div>
  );
}
