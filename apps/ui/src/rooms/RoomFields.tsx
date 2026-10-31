/*
 * A new room's own fields — game type, a Constructed room's optional mode, a password — shared by
 * Create room (`RoomList.tsx`) and Create event's tournament (`CreateEventDialog.tsx`), so the two
 * forms make the same room. The name is each form's own: an event's room is named after the event.
 * A tournament also sets the room's settings up front (`TournamentFields`): format or cube, deck
 * rule, clock, pick timer, hand smoothing — the same ones the room's leader changes later.
 */

import { DEFAULT_ROOM_SETTINGS, ROOM_PASSWORD_MAX, type ClockSetting, type ConstructedMode, type CubeSummary, type PickTimer, type TournamentDecks } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';
import { freshRoomMode, MODE_CARDS } from '../screens/constructed-mode/ModeRow.tsx';
import type { TableFormat } from '../screens/tables.ts';
import { createRoomFields, type CreateRequest, type GameType } from './api.ts';
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

/* ── a tournament's settings (Create event) ─────────────────────────────── */

/** A room's own settings, as Create event's tournament sets them up front; the room changes them later. */
export interface TournamentValues {
  /** A constructed room's format; null is the room's default (the newest Standard era). */
  format: string | null;
  /** A draft room's cube, every round; null is the room's default pool. */
  cube: string | null;
  tournamentDecks: TournamentDecks;
  clock: ClockSetting;
  pickTimer: PickTimer;
  handSmoothing: boolean;
}

export const NEW_TOURNAMENT: TournamentValues = {
  format: null,
  cube: null,
  tournamentDecks: DEFAULT_ROOM_SETTINGS.tournamentDecks,
  clock: DEFAULT_ROOM_SETTINGS.clock,
  pickTimer: { ...DEFAULT_ROOM_SETTINGS.pickTimer },
  handSmoothing: DEFAULT_ROOM_SETTINGS.handSmoothing,
};

/** The tournament's room as `POST /api/events` takes it: the room fields, and the settings that apply to its game type. */
export function tournamentRoom(fields: RoomFieldValues, t: TournamentValues): Record<string, unknown> {
  const room = createRoomFields(roomRequest(fields));
  if (fields.gameType === 'draft') {
    const cube = t.cube === null ? {} : { plan: { rounds: [0, 1, 2].map(() => ({ kind: 'cube', cubeId: t.cube })) } };
    return { ...room, ...cube, settings: { clock: t.clock, pickTimer: t.pickTimer, handSmoothing: t.handSmoothing } };
  }
  return { ...room, ...(t.format === null ? {} : { format: t.format }), settings: { tournamentDecks: t.tournamentDecks, clock: t.clock, handSmoothing: t.handSmoothing } };
}

const DECKS_CARDS: readonly RadioCard<TournamentDecks>[] = [
  { value: 'locked', label: 'Locked for the event' },
  { value: 'per-round', label: 'Re-pick each round' },
];
const CLOCK_CARDS: readonly RadioCard<ClockSetting>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];
type PickPace = 'off' | 'normal' | 'fast';
const PACE_CARDS: readonly RadioCard<PickPace>[] = [
  { value: 'off', label: 'Off' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
];
const PACE: Readonly<Record<PickPace, PickTimer>> = { off: { on: false, speed: 1 }, normal: { on: true, speed: 1 }, fast: { on: true, speed: 2 } };
const paceOf = (t: PickTimer): PickPace => (!t.on ? 'off' : t.speed >= 2 ? 'fast' : 'normal');
const ON_OFF: readonly RadioCard<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/** The format and cube lists, or null while they load (each picker then offers only the default). */
export function TournamentFields({
  idPrefix,
  gameType,
  value,
  onChange,
  formats,
  cubes,
}: {
  idPrefix: string;
  gameType: GameType;
  value: TournamentValues;
  onChange: (next: TournamentValues) => void;
  formats: readonly TableFormat[] | null;
  cubes: readonly CubeSummary[] | null;
}) {
  const set = (patch: Partial<TournamentValues>): void => onChange({ ...value, ...patch });
  return (
    <>
      {gameType === 'draft' ? (
        <>
          <label htmlFor={`${idPrefix}-cube`}>Cube</label>
          <select id={`${idPrefix}-cube`} data-testid={`${idPrefix}-cube`} value={value.cube ?? ''} onChange={(e) => set({ cube: e.target.value === '' ? null : e.target.value })}>
            <option value="">Default</option>
            {(cubes ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <span className="rooms__caption">Pick timer</span>
          <RadioCards name={`${idPrefix}-pick-timer`} label="Pick timer" options={PACE_CARDS} value={paceOf(value.pickTimer)} onChange={(pace) => set({ pickTimer: PACE[pace] })} testId={`${idPrefix}-pick-timer`} />
        </>
      ) : (
        <>
          <label htmlFor={`${idPrefix}-format`}>Format</label>
          <select id={`${idPrefix}-format`} data-testid={`${idPrefix}-format`} value={value.format ?? ''} onChange={(e) => set({ format: e.target.value === '' ? null : e.target.value })}>
            <option value="">Newest Standard</option>
            {(formats ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>

          <span className="rooms__caption">Decks</span>
          <RadioCards name={`${idPrefix}-decks`} label="Decks" options={DECKS_CARDS} value={value.tournamentDecks} onChange={(tournamentDecks) => set({ tournamentDecks })} testId={`${idPrefix}-decks`} />
        </>
      )}

      <span className="rooms__caption">Chess clock</span>
      <RadioCards name={`${idPrefix}-clock`} label="Chess clock" options={CLOCK_CARDS} value={value.clock} onChange={(clock) => set({ clock })} testId={`${idPrefix}-clock`} />

      <span className="rooms__caption">Hand smoothing</span>
      <RadioCards
        name={`${idPrefix}-smoothing`}
        label="Hand smoothing"
        options={ON_OFF}
        value={value.handSmoothing ? 'on' : 'off'}
        onChange={(v) => set({ handSmoothing: v === 'on' })}
        testId={`${idPrefix}-smoothing`}
      />
    </>
  );
}
