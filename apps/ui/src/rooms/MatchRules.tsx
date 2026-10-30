/*
 * A room's rules, behind one button at the end of its first row (the operator, 2026-10-22, on the
 * bar's "free pick", "hand smoothing", "tournament", "locked", "each round" buttons: "they all feel
 * kind of clunky and disorganized"; concept A, with "the locked rule" and "freepick also" folded in, and
 * All Random's Lock decks: "yes, put all random lock decks in match rules too").
 *
 * The button names the rules that are on; the popover holds the switches, drawn as they were on the
 * bar (`ActionButton` + `.ct-toggle`, the same test ids), and a tournament's deck policy (`RadioCards`,
 * `tournament-decks`). A rule that does not apply to the room's mode is not drawn. The leader edits;
 * everybody else opens the same popover and reads it, disabled.
 */

import type { TournamentDecks } from '@hadoku/shared';
import { TOURNAMENT_DECK_POLICIES } from '@hadoku/shared';

import { ActionButton } from '../components/ActionButton.tsx';
import { Popover, usePopover } from '../components/Popover.tsx';
import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';

/** A rule that is on or off. */
export interface RuleSwitch {
  on: boolean;
  onToggle: () => void;
  /** Fixed for now, whoever is asking: a rule the room's seats have already been dealt under. */
  locked?: boolean;
}

const DECKS_LABEL: Readonly<Record<TournamentDecks, string>> = { locked: 'Locked for the event', 'per-round': 'Re-pick each round' };
const DECKS_CARDS: readonly RadioCard<TournamentDecks>[] = TOURNAMENT_DECK_POLICIES.map((value) => ({ value, label: DECKS_LABEL[value] }));

export function MatchRules({
  leader,
  disabled,
  handSmoothing,
  freePick,
  lockDecks,
  tournamentDecks,
  clock,
}: {
  /** Only the leader moves a rule; everybody else reads them. */
  leader: boolean;
  /** A start is in flight or a match is live. */
  disabled: boolean;
  /** Classic's: absent in a mode it does not apply to. */
  handSmoothing?: RuleSwitch;
  freePick?: RuleSwitch;
  /** All Random's: on, a table plays its first deal every series; off, every new series deals fresh. */
  lockDecks?: RuleSwitch;
  /** A tournament's deck policy: absent when the room is not a tournament. */
  tournamentDecks?: { value: TournamentDecks; locked: boolean; onChange: (decks: TournamentDecks) => void };
  /** The chess clock: 20 minutes a player for a series, on by itself in a tournament. */
  clock?: RuleSwitch;
}) {
  const { trigger, toggle, close } = usePopover();
  const off = !leader || disabled;
  // A tournament of All Random can lock its decks twice over; the button names it once.
  const on = [...new Set([handSmoothing?.on === true && 'Hand smoothing', freePick?.on === true && 'Free pick', lockDecks?.on === true && 'Decks locked', tournamentDecks !== undefined && (tournamentDecks.value === 'locked' ? 'Decks locked' : 'Re-pick'), clock?.on === true && 'Chess clock'])].filter(
    (name): name is string => typeof name === 'string',
  );
  if (handSmoothing === undefined && freePick === undefined && lockDecks === undefined && tournamentDecks === undefined && clock === undefined) return null;
  return (
    <>
      <button type="button" className="lobby__rules ct-toggle" aria-expanded={trigger !== null} data-testid="match-rules" onClick={(event) => toggle(event.currentTarget)}>
        Match rules
        {on.length > 0 && <span className="lobby__rules-on">{on.join(' · ')}</span>}
      </button>
      {trigger !== null && (
        <Popover trigger={trigger} onClose={close} title="Match rules" testId="match-rules-popover">
          <div className="lobby__rules-list">
            {handSmoothing !== undefined && (
              // The opening hand nearer the deck's land ratio, each mulligan weighted toward it.
              <ActionButton
                action={handSmoothing.on ? 'hand-smoothing-off' : 'hand-smoothing-on'}
                className="lobby__free-pick ct-toggle"
                aria-pressed={handSmoothing.on}
                data-testid="hand-smoothing"
                disabled={off || handSmoothing.locked === true}
                onPress={handSmoothing.onToggle}
              >
                Hand smoothing
              </ActionButton>
            )}
            {freePick !== undefined && (
              // On, the whole library is the pool and everyone browses it by format; off, the leader's tabs pick the era.
              <ActionButton
                action={freePick.on ? 'free-pick-off' : 'free-pick-on'}
                className="lobby__free-pick ct-toggle"
                aria-pressed={freePick.on}
                data-testid="free-pick"
                disabled={off || freePick.locked === true}
                onPress={freePick.onToggle}
              >
                Free pick
              </ActionButton>
            )}
            {lockDecks !== undefined && (
              <ActionButton
                action={lockDecks.on ? 'random-unlock' : 'random-lock'}
                className="lobby__free-pick ct-toggle"
                aria-pressed={lockDecks.on}
                data-testid="random-lock"
                disabled={off || lockDecks.locked === true}
                onPress={lockDecks.onToggle}
              >
                Lock decks
              </ActionButton>
            )}
            {clock !== undefined && (
              <ActionButton
                action={clock.on ? 'clock-off' : 'clock-on'}
                className="lobby__free-pick ct-toggle"
                aria-pressed={clock.on}
                data-testid="chess-clock"
                disabled={off || clock.locked === true}
                onPress={clock.onToggle}
              >
                Chess clock
              </ActionButton>
            )}
            {tournamentDecks !== undefined && (
              <RadioCards
                name="tournament-decks"
                label="Tournament decks"
                options={DECKS_CARDS}
                value={tournamentDecks.value}
                disabled={off || tournamentDecks.locked}
                onChange={tournamentDecks.onChange}
                testId="tournament-decks"
              />
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
