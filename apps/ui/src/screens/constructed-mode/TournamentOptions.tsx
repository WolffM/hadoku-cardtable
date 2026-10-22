/*
 * A Constructed room's Tournament toggle and, once it is on, its Decks
 * toggle — `docs/planning/tournament-mode-plan.md`'s "Entry point" and
 * "Decks" rulings: *"a toggle in a Constructed room"*, and, verbatim, *"For
 * now make it a toggle. in tournament mode. either lock deck or re-pick each
 * round."*
 *
 * Ported styling, not a new pattern: Tournament is a binary switch, drawn
 * exactly like `ClassicOptions.tsx`'s Free pick / Hand smoothing
 * (`ActionButton` + `.ct-toggle`); Decks is a named choice of two, drawn
 * exactly like `ModeRow.tsx`'s mode row (`RadioCards`, small size only — this
 * is never the room's own whole-screen choice the way Mode can be).
 *
 * The leader edits; everybody else reads the same controls disabled, same as
 * every other room setting on this row. Both lock once the pod's seats do
 * (`disabled`, passed in by the caller — `ConstructedScreen.tsx` computes it
 * from `pod.phase`).
 */

import { TOURNAMENT_DECK_POLICIES, type TournamentDecks } from '@hadoku/shared';

import { ActionButton } from '../../components/ActionButton.tsx';
import { RadioCards, type RadioCard } from '../../components/RadioCards.tsx';

export type { TournamentDecks };

const DECKS_LABEL: Readonly<Record<TournamentDecks, string>> = { locked: 'Locked', 'per-round': 'Each round' };
const DECKS_CARDS: readonly RadioCard<TournamentDecks>[] = TOURNAMENT_DECK_POLICIES.map((value) => ({ value, label: DECKS_LABEL[value] }));

export function TournamentOptions({
  tournament,
  tournamentDecks,
  leader,
  disabled,
  onTournament,
  onDecks,
}: {
  tournament: boolean;
  tournamentDecks: TournamentDecks;
  /** Only the leader moves either control; everybody else reads the same state, disabled. */
  leader: boolean;
  /** The pod's seats are locked, or a start/write is already in flight. */
  disabled: boolean;
  onTournament: (on: boolean) => void;
  onDecks: (decks: TournamentDecks) => void;
}) {
  return (
    <span className="lobby__switches">
      <ActionButton
        action={tournament ? 'tournament-off' : 'tournament-on'}
        className="lobby__free-pick ct-toggle"
        aria-pressed={tournament}
        data-testid="tournament-toggle"
        disabled={!leader || disabled}
        onPress={() => onTournament(!tournament)}
      >
        Tournament
      </ActionButton>
      {tournament && (
        <RadioCards
          name="tournament-decks"
          label="Decks"
          options={DECKS_CARDS}
          value={tournamentDecks}
          disabled={!leader || disabled}
          onChange={onDecks}
          testId="tournament-decks"
        />
      )}
    </span>
  );
}
