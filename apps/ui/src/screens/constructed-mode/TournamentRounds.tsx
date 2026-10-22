/*
 * A Constructed room's tournament rounds and final standings —
 * `docs/planning/tournament-mode-plan.md`'s "Rounds, standings, end": *"the
 * bracket view and standings come from the pod components"*.
 *
 * REUSES `PodBracket`/`PodStandings` verbatim (held by session
 * hadoku-cardtable-5a; this lane does not edit them). What a draft pod's own
 * rounds additionally draw at the top — the sideboard step, a start refusal —
 * are slots the caller (`ConstructedScreen.tsx`) fills, because each needs
 * state (the room's client, the match-starting effects) this presentational
 * component has no business holding; `PodScreen.tsx`'s `PodRoom` draws the
 * same shape for a draft pod's rounds and is the layout this mirrors.
 *
 * No Gauntlet slot: tournaments with `mode: 'gauntlet'` are refused
 * server-side (`tournament-mode-unsupported`, a per-table Gauntlet-state
 * follow-up lane's own gap) — `ConstructedScreen.tsx` never lets the two
 * combine, so this never has a Gauntlet entrant's own choose step to draw.
 */

import type { ReactNode } from 'react';

import { PodBracket, type PodBracketProps } from '../pod/PodBracket.tsx';
import { PodStandings } from '../pod/PodStandings.tsx';
import type { PodView } from '../pod/wire.ts';

export function TournamentRounds({
  pod,
  tables,
  myMemberId,
  nameOf,
  avatarOf,
  onPlay,
  startTableError,
  deckPicker,
  sideboard,
}: Pick<PodBracketProps, 'tables' | 'myMemberId' | 'nameOf' | 'avatarOf' | 'onPlay'> & {
  pod: PodView;
  startTableError: string | null;
  /** Classic, `tournamentDecks: 'per-round'` only: the re-pick before this round's game 1. */
  deckPicker?: ReactNode;
  /** Between games of my series: the room's own sideboard step (`TableSideboard`). */
  sideboard?: ReactNode;
}) {
  return (
    <div className="pod__room">
      <div className="pod__rounds" data-testid={pod.phase === 'done' ? 'pod-final' : 'pod-rounds'}>
        {pod.phase === 'done' ? <h1>Standings</h1> : <h2 data-testid="pod-round">Round {pod.round} of {pod.rounds}</h2>}
        {startTableError !== null && (
          <p className="ct-error" role="alert" data-testid="pod-table-start-error">
            {startTableError}
          </p>
        )}
        {deckPicker}
        {sideboard}
        <div className="pod__board">
          <PodBracket pod={pod} tables={tables} myMemberId={myMemberId} nameOf={nameOf} avatarOf={avatarOf} onPlay={onPlay} />
          <PodStandings rows={pod.standings} results={pod.results} nameOf={nameOf} myMemberId={myMemberId} />
        </div>
      </div>
    </div>
  );
}
