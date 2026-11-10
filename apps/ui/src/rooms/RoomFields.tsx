/*
 * A new room's own fields — game type, a Constructed room's optional mode, a password — shared by
 * Create room (`RoomList.tsx`) and Create event's tournament (`CreateEventDialog.tsx`), so the two
 * forms make the same room. The name is each form's own: an event's room is named after the event.
 * A tournament also sets the room's settings up front (`TournamentFields`): format or cube, deck
 * rule, clock, pick timer, hand smoothing — the same ones the room's leader changes later.
 */

import { DEFAULT_ROOM_SETTINGS, ROOM_PASSWORD_MAX, type ClockSetting, type ConstructedMode, type CubeSummary, type DraftPreset, type PickTimer, type TournamentDecks } from '@hadoku/shared';

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

/**
 * `idPrefix` names every input and test id (`room-create` keeps Create room's own). `showType` false
 * leaves the game type to the caller, who draws its own row (Create room's adds Challenge).
 */
export function RoomFields({ idPrefix, value, onChange, showType = true }: { idPrefix: string; value: RoomFieldValues; onChange: (next: RoomFieldValues) => void; showType?: boolean }) {
  return (
    <>
      {showType && (
        <>
          <span className="rooms__caption">Game type</span>
          <GameTypeRow testId={`${idPrefix}-type`} value={value.gameType} onChange={(gameType) => onChange({ ...value, gameType })} />
        </>
      )}

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
  /** A draft room's cube, every round; null is the room's default pool, or `preset`'s. */
  cube: string | null;
  /** A draft room's saved preset, its whole plan; null for a cube or the default pool. */
  preset: DraftPreset | null;
  tournamentDecks: TournamentDecks;
  clock: ClockSetting;
  pickTimer: PickTimer;
  handSmoothing: boolean;
}

export const NEW_TOURNAMENT: TournamentValues = {
  format: null,
  cube: null,
  preset: null,
  tournamentDecks: DEFAULT_ROOM_SETTINGS.tournamentDecks,
  clock: DEFAULT_ROOM_SETTINGS.clock,
  pickTimer: { ...DEFAULT_ROOM_SETTINGS.pickTimer },
  handSmoothing: DEFAULT_ROOM_SETTINGS.handSmoothing,
};

/** The tournament's room as `POST /api/events` takes it: the room fields, and the settings that apply to its game type. */
export function tournamentRoom(fields: RoomFieldValues, t: TournamentValues): Record<string, unknown> {
  const room = createRoomFields(roomRequest(fields));
  if (fields.gameType === 'draft') {
    const pool = t.preset !== null ? { plan: t.preset.plan } : t.cube === null ? {} : { plan: { rounds: [0, 1, 2].map(() => ({ kind: 'cube', cubeId: t.cube })) } };
    return { ...room, ...pool, settings: { clock: t.clock, pickTimer: t.pickTimer, handSmoothing: t.handSmoothing } };
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

/** A preset's value in the pool select, beside the cubes' bare ids. */
const PRESET_VALUE = 'preset:';

/** The format, cube and preset lists, or null while they load (each picker then offers only the default). */
export function TournamentFields({
  idPrefix,
  gameType,
  value,
  onChange,
  formats,
  cubes,
  presets,
}: {
  idPrefix: string;
  gameType: GameType;
  value: TournamentValues;
  onChange: (next: TournamentValues) => void;
  formats: readonly TableFormat[] | null;
  cubes: readonly CubeSummary[] | null;
  presets: readonly DraftPreset[] | null;
}) {
  const set = (patch: Partial<TournamentValues>): void => onChange({ ...value, ...patch });
  const pickPool = (choice: string): void => {
    const preset = choice.startsWith(PRESET_VALUE) ? (presets ?? []).find((p) => `${PRESET_VALUE}${p.id}` === choice) : undefined;
    set(preset !== undefined ? { preset, cube: null } : { preset: null, cube: choice === '' ? null : choice });
  };
  return (
    <>
      {gameType === 'draft' ? (
        <>
          <label htmlFor={`${idPrefix}-cube`}>Pool</label>
          <select id={`${idPrefix}-cube`} data-testid={`${idPrefix}-cube`} value={value.preset !== null ? `${PRESET_VALUE}${value.preset.id}` : (value.cube ?? '')} onChange={(e) => pickPool(e.target.value)}>
            <option value="">Default</option>
            {(presets ?? []).length > 0 && (
              <optgroup label="Presets">
                {(presets ?? []).map((p) => (
                  <option key={p.id} value={`${PRESET_VALUE}${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Cubes">
              {(cubes ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
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
