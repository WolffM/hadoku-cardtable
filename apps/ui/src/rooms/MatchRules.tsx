/*
 * A room's rules, behind a Room settings button on the title row beside Close (the operator,
 * 2026-10-22, on the bar's rule buttons: "they all feel kind of clunky and disorganized"; and
 * 2026-11-02: "create a room settings button and put it on the same row as the 'Close' button").
 * It is Close's own button family, never a chip, and names no rule: the popover does.
 *
 * The popover holds the switches, drawn as they were on the bar
 * (`ActionButton` + `.ct-toggle`, the same test ids), and a tournament's deck policy (`RadioCards`,
 * `tournament-decks`). A rule that does not apply to the room's mode is not drawn. The leader edits;
 * everybody else opens the same popover and reads it, disabled.
 *
 * ## The popover's own rows, label | switch (item 2, `screens.css`'s `.lobby__rules-list`)
 *
 * Each row is TWO direct children of the grid — a plain `<span>` naming the rule, then its switch —
 * never a wrapper `<div>` around the pair: a wrapper would be the grid's own item, one cell wide, and
 * every row's switch would sit wherever that row's OWN label happened to end rather than lining up
 * under the others. Two children per row, same two grid columns every time, is what makes
 * `.lobby__rules-list`'s `grid-template-columns: max-content 1fr` put every switch's left edge at the
 * same x — the widest label decides where that is, not each row for itself.
 */

import type { TournamentDecks } from '@hadoku/shared';
import { TOURNAMENT_DECK_POLICIES } from '@hadoku/shared';

import type { ReactNode } from 'react';
import { Icon } from '@wolffm/themes';

import { ActionButton } from '../components/ActionButton.tsx';
import { Popover, usePopover } from '../components/Popover.tsx';
import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';
import { uiLength } from '../settings/ui-scale.ts';
import './CloseRoom.css';

/** A rule that is on or off. */
export interface RuleSwitch {
  on: boolean;
  onToggle: () => void;
  /** Fixed for now, whoever is asking: a rule the room's seats have already been dealt under. */
  locked?: boolean;
}

const DECKS_LABEL: Readonly<Record<TournamentDecks, string>> = { locked: 'Locked for the event', 'per-round': 'Re-pick each round' };
const DECKS_CARDS: readonly RadioCard<TournamentDecks>[] = TOURNAMENT_DECK_POLICIES.map((value) => ({ value, label: DECKS_LABEL[value] }));

/** One row's two grid cells: the rule's name, then its switch (or its own group of cards). */
function RuleRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="lobby__rules-label">{label}</span>
      {children}
    </>
  );
}

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
  if (handSmoothing === undefined && freePick === undefined && lockDecks === undefined && tournamentDecks === undefined && clock === undefined) return null;
  return (
    <>
      <button type="button" className="room-close" aria-expanded={trigger !== null} data-testid="match-rules" onClick={(event) => toggle(event.currentTarget)}>
        <Icon name="gear" size={uiLength('0.9rem')} />
        Room settings
      </button>
      {trigger !== null && (
        <Popover trigger={trigger} onClose={close} title="Match rules" testId="match-rules-popover">
          <div className="lobby__rules-list">
            {handSmoothing !== undefined && (
              // The opening hand nearer the deck's land ratio, each mulligan weighted toward it.
              <RuleRow label="Hand smoothing">
                <ActionButton
                  action={handSmoothing.on ? 'hand-smoothing-off' : 'hand-smoothing-on'}
                  className="lobby__free-pick lobby__rules-switch ct-toggle"
                  aria-pressed={handSmoothing.on}
                  data-testid="hand-smoothing"
                  disabled={off || handSmoothing.locked === true}
                  onPress={handSmoothing.onToggle}
                >
                  {handSmoothing.on ? 'On' : 'Off'}
                </ActionButton>
              </RuleRow>
            )}
            {freePick !== undefined && (
              // On, the whole library is the pool and everyone browses it by format; off, the leader's tabs pick the era.
              <RuleRow label="Free pick">
                <ActionButton
                  action={freePick.on ? 'free-pick-off' : 'free-pick-on'}
                  className="lobby__free-pick lobby__rules-switch ct-toggle"
                  aria-pressed={freePick.on}
                  data-testid="free-pick"
                  disabled={off || freePick.locked === true}
                  onPress={freePick.onToggle}
                >
                  {freePick.on ? 'On' : 'Off'}
                </ActionButton>
              </RuleRow>
            )}
            {lockDecks !== undefined && (
              <RuleRow label="Lock decks">
                <ActionButton
                  action={lockDecks.on ? 'random-unlock' : 'random-lock'}
                  className="lobby__free-pick lobby__rules-switch ct-toggle"
                  aria-pressed={lockDecks.on}
                  data-testid="random-lock"
                  disabled={off || lockDecks.locked === true}
                  onPress={lockDecks.onToggle}
                >
                  {lockDecks.on ? 'On' : 'Off'}
                </ActionButton>
              </RuleRow>
            )}
            {clock !== undefined && (
              <RuleRow label="Chess clock">
                <ActionButton
                  action={clock.on ? 'clock-off' : 'clock-on'}
                  className="lobby__free-pick lobby__rules-switch ct-toggle"
                  aria-pressed={clock.on}
                  data-testid="chess-clock"
                  disabled={off || clock.locked === true}
                  onPress={clock.onToggle}
                >
                  {clock.on ? 'On' : 'Off'}
                </ActionButton>
              </RuleRow>
            )}
            {tournamentDecks !== undefined && (
              <RuleRow label="Tournament decks">
                <RadioCards
                  name="tournament-decks"
                  label="Tournament decks"
                  options={DECKS_CARDS}
                  value={tournamentDecks.value}
                  disabled={off || tournamentDecks.locked}
                  onChange={tournamentDecks.onChange}
                  testId="tournament-decks"
                  className="lobby__rules-switch"
                />
              </RuleRow>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
