/*
 * A room's type, Constructed or Draft: one choice drawn in two places, the
 * create form and the room itself, where the leader may turn a room into the
 * other type between games (the operator, 2026-10-21: "after a match is
 * concluded i should be able to start a new match and standup or even convert
 * the room to a new type"). Both draw this, so the two can never offer
 * different cards or name them differently.
 */

import { RadioCards } from '../components/RadioCards.tsx';
import { GAME_TYPES, type GameType } from './api.ts';

export function GameTypeRow({
  testId,
  value,
  disabled = false,
  onChange,
}: {
  /** The group's test id, and its inputs' `name`; each card's input is `<testId>-<wire id>`. */
  testId: string;
  value: GameType;
  disabled?: boolean;
  onChange: (gameType: GameType) => void;
}) {
  return <RadioCards name={testId} label="Game type" options={GAME_TYPES} value={value} disabled={disabled} onChange={onChange} testId={testId} />;
}
