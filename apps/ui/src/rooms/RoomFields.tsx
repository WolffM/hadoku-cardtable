/*
 * A new room's own fields — game type, a Constructed room's optional mode, a password — shared by
 * Create room (`RoomList.tsx`) and a room event's Create event (`CreateEventDialog.tsx`), so the two
 * forms make the same room. The name is each form's own: an event's room is named after the event.
 */

import { ROOM_PASSWORD_MAX, type ConstructedMode } from '@hadoku/shared';

import { RadioCards } from '../components/RadioCards.tsx';
import { freshRoomMode, MODE_CARDS } from '../screens/constructed-mode/ModeRow.tsx';
import type { CreateRequest, GameType } from './api.ts';
import { GameTypeRow } from './GameTypeRow.tsx';

export interface RoomFieldValues {
  gameType: GameType;
  /** Optional: a Constructed room created with none asks its leader first. */
  mode: ConstructedMode | null;
  password: string;
}

export const NEW_ROOM_FIELDS: RoomFieldValues = { gameType: 'constructed-1v1', mode: null, password: '' };

/** The fields as a create request, name aside. */
export function roomRequest(v: RoomFieldValues): Omit<CreateRequest, 'name'> {
  return {
    gameType: v.gameType,
    clientMode: 'builtin',
    password: v.password,
    ...(v.gameType === 'constructed-1v1' && v.mode !== null ? { mode: freshRoomMode(v.mode) } : {}),
  };
}

/** `idPrefix` names every input and test id (`room-create` keeps Create room's own). */
export function RoomFields({ idPrefix, value, onChange }: { idPrefix: string; value: RoomFieldValues; onChange: (next: RoomFieldValues) => void }) {
  return (
    <>
      <span className="rooms__caption">Game type</span>
      <GameTypeRow testId={`${idPrefix}-type`} value={value.gameType} onChange={(gameType) => onChange({ ...value, gameType })} />

      {value.gameType === 'constructed-1v1' && (
        <>
          <span className="rooms__caption">Mode (optional)</span>
          <RadioCards
            name={`${idPrefix}-constructed-mode`}
            label="Mode"
            options={MODE_CARDS}
            value={value.mode}
            onChange={(mode) => onChange({ ...value, mode })}
            testId={`${idPrefix}-constructed-mode`}
          />
        </>
      )}

      <label htmlFor={`${idPrefix}-password`}>Password (optional)</label>
      <input
        id={`${idPrefix}-password`}
        data-testid={`${idPrefix}-password`}
        type="password"
        maxLength={ROOM_PASSWORD_MAX}
        autoComplete="new-password"
        value={value.password}
        onChange={(e) => onChange({ ...value, password: e.target.value })}
      />
    </>
  );
}
