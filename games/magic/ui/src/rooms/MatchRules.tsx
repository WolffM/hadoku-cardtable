/*
 * A room's rules, behind a Room settings button on the title row beside Close (the operator,
 * 2026-10-22, on the bar's rule buttons: "they all feel kind of clunky and disorganized"; and
 * 2026-11-02: "create a room settings button and put it on the same row as the 'Close' button").
 * It is Close's own button family, never a chip, and names no rule: the popover does.
 *
 * Every room type opens this one popover — a constructed room's mode rules and a draft room's pick
 * timer and bots alike (the operator, 2026-11-07: "unify room settings to properly use the same UI
 * modal regardless of room type"). It holds the switches (`ActionButton` + `.ct-toggle`) and the
 * choices (`RadioCards`: a tournament's deck policy, the pick timer's speed, the bots). A rule that
 * does not apply to the room is not drawn. The leader edits; everybody else opens the same popover
 * and reads it, disabled.
 *
 * ## Built from the platform's panel (`@hadoku/game-ui/components/RoomSettings.tsx`)
 *
 * The popover, its rows and its controls are the kit's, the same any game's settings get. The
 * settings the declaration can draw (`ROOM_SETTINGS`: hand smoothing, the bots, the tournament's
 * decks) are its `SettingControl`s; the rows it cannot are Magic's own, from the same pieces: Free
 * pick and Lock decks (not settings at all), the clock (`auto` reads as a switch) and the pick timer
 * (a switch with its speed beside it). Every switch keeps the app's own pressed fill (`.ct-toggle`).
 */

import type { DraftBots, PickTimer, TournamentDecks } from '@hadoku/shared';
import { ROOM_SETTINGS } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '@hadoku/game-ui/components/RadioCards.tsx';
import { RoomSettingsPopover, SettingControl, SettingRow, SettingToggle } from '@hadoku/game-ui/components/RoomSettings.tsx';
import './CloseRoom.css';

/** A rule that is on or off. */
export interface RuleSwitch {
  on: boolean;
  onToggle: () => void;
  /** Fixed for now, whoever is asking: a rule the room's seats have already been dealt under. */
  locked?: boolean;
}

/** The draft rope's speed over MTR Appendix B's times. */
type Speed = '0.5' | '1' | '2' | '4';
const SPEEDS: readonly RadioCard<Speed>[] = [
  { value: '0.5', label: '½×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
  { value: '4', label: '4×' },
];

/** A rule with a value of its own rather than on/off. */
export interface RuleChoice<T> {
  value: T;
  onChange: (next: T) => void;
}

export function MatchRules({
  leader,
  disabled,
  handSmoothing,
  freePick,
  lockDecks,
  tournamentDecks,
  clock,
  pickTimer,
  draftBots,
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
  /** A draft room's rope (`settings.pickTimer`): on or off, and its speed while on. */
  pickTimer?: RuleChoice<PickTimer>;
  /** What a draft room's bots pick with (`settings.draftBots`). */
  draftBots?: RuleChoice<DraftBots>;
}) {
  const off = !leader || disabled;
  if ([handSmoothing, freePick, lockDecks, tournamentDecks, clock, pickTimer, draftBots].every((rule) => rule === undefined)) return null;
  const speed = pickTimer === undefined ? null : (SPEEDS.find((s) => Number(s.value) === pickTimer.value.speed)?.value ?? null);
  const { fields } = ROOM_SETTINGS;
  return (
    <RoomSettingsPopover testId="match-rules" triggerClassName="room-close">
      {handSmoothing !== undefined && (
        // The opening hand nearer the deck's land ratio, each mulligan weighted toward it.
        <SettingRow label={fields.handSmoothing.label}>
          <SettingControl
            field={fields.handSmoothing}
            name="handSmoothing"
            value={handSmoothing.on}
            disabled={off || handSmoothing.locked === true}
            onChange={handSmoothing.onToggle}
            testId="hand-smoothing"
            toggleClassName="ct-toggle"
          />
        </SettingRow>
      )}
      {freePick !== undefined && (
        // On, the whole library is the pool and everyone browses it by format; off, the leader's tabs pick the era.
        <SettingRow label="Free pick">
          <SettingToggle on={freePick.on} onPress={freePick.onToggle} disabled={off || freePick.locked === true} testId="free-pick" className="ct-toggle" />
        </SettingRow>
      )}
      {lockDecks !== undefined && (
        <SettingRow label="Lock decks">
          <SettingToggle on={lockDecks.on} onPress={lockDecks.onToggle} disabled={off || lockDecks.locked === true} testId="random-lock" className="ct-toggle" actions={{ on: 'random-lock', off: 'random-unlock' }} />
        </SettingRow>
      )}
      {clock !== undefined && (
        <SettingRow label={fields.clock.label}>
          <SettingToggle on={clock.on} onPress={clock.onToggle} disabled={off || clock.locked === true} testId="chess-clock" className="ct-toggle" actions={{ on: 'clock-on', off: 'clock-off' }} />
        </SettingRow>
      )}
      {pickTimer !== undefined && (
        <SettingRow label={fields.pickTimer.label}>
          <div className="room-settings__switch room-settings__pair">
            <SettingToggle on={pickTimer.value.on} onPress={() => pickTimer.onChange({ ...pickTimer.value, on: !pickTimer.value.on })} disabled={off} testId="pick-timer" className="ct-toggle" />
            {pickTimer.value.on && (
              <RadioCards
                name="pick-timer-speed"
                label="Pick timer speed"
                options={SPEEDS}
                value={speed}
                disabled={off}
                onChange={(value) => pickTimer.onChange({ ...pickTimer.value, speed: Number(value) })}
                testId="pick-timer-speed"
              />
            )}
          </div>
        </SettingRow>
      )}
      {draftBots !== undefined && (
        <SettingRow label={fields.draftBots.label}>
          <SettingControl field={fields.draftBots} name="draft-bots" value={draftBots.value} disabled={off} onChange={(v) => draftBots.onChange(v as DraftBots)} testId="draft-bots" />
        </SettingRow>
      )}
      {tournamentDecks !== undefined && (
        <SettingRow label={fields.tournamentDecks.label}>
          <SettingControl
            field={fields.tournamentDecks}
            name="tournament-decks"
            value={tournamentDecks.value}
            disabled={off || tournamentDecks.locked}
            onChange={(v) => tournamentDecks.onChange(v as TournamentDecks)}
            testId="tournament-decks"
          />
        </SettingRow>
      )}
    </RoomSettingsPopover>
  );
}
