/*
 * A room's first row: its type, whether it plays one match or a tournament, and its Match rules
 * at the far end (the operator, 2026-10-22, concept A). The constructed and draft rooms both draw
 * it, so the two can never name these differently; a draft room is a pod already and has no event
 * choice, and a room with no rules to show draws no Match rules button.
 */

import type { ReactNode } from 'react';

import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';
import { GameTypeRow } from './GameTypeRow.tsx';
import type { GameType } from './api.ts';

type RoomEvent = 'single' | 'tournament';
const EVENT_CARDS: readonly RadioCard<RoomEvent>[] = [
  { value: 'single', label: 'Single match' },
  { value: 'tournament', label: 'Tournament' },
];

export function RoomHeader({
  gameType,
  typeDisabled,
  onGameType,
  event,
  children,
}: {
  gameType: GameType;
  typeDisabled: boolean;
  onGameType: (gameType: GameType) => void;
  /** One match or a Swiss pod of the room's mode: absent where the room cannot choose. */
  event?: { tournament: boolean; disabled: boolean; onChange: (tournament: boolean) => void };
  /** The room's Match rules. */
  children?: ReactNode;
}) {
  return (
    <div className="lobby__header">
      <GameTypeRow testId="room-game-type" value={gameType} disabled={typeDisabled} onChange={onGameType} />
      {event !== undefined && (
        <RadioCards
          name="room-event"
          label="Event"
          options={EVENT_CARDS}
          value={event.tournament ? 'tournament' : 'single'}
          disabled={event.disabled}
          onChange={(value) => event.onChange(value === 'tournament')}
          testId="room-event"
        />
      )}
      {children}
    </div>
  );
}
