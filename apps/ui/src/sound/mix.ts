/*
 * What a sound event turns into, decided without an audio device.
 *
 * A `SoundEvent` names a role (`@hadoku/shared`'s `SOUND_ROLES`), optionally a
 * colour × paradigm cell to layer on top, and whose seat it came from. `plan`
 * answers which takes play, on which bus and how loud — or why a layer stayed
 * silent. `mixer.ts` does the playing; the sandbox prints the answer. Keeping
 * the decisions here is what lets `mix.test.ts` pin them down in Node.
 *
 * The rules (`docs/planning/audio.md`):
 *
 * - **Layering.** The role's take always plays; the colour cell's take mixes on
 *   top. Either may be empty and the other still plays.
 * - **Opponent.** Their `ui` roles never play. Their game and colour layers play
 *   at `opponent` times the level.
 * - **Collapse.** The same cell from the same seat within `collapseMs` plays
 *   once: six creatures dying together is one `g.dies`.
 * - **Variation.** A cell with several takes plays one at random, never the
 *   one it played last.
 * - **Reversed.** A `REVERSED_ROLES` event (Untap) plays its other role's
 *   cell backwards, and collapses only with itself.
 */

import { REVERSED_ROLES, SOUND_ROLES, type SoundBus } from '@hadoku/shared';

import { pickRandom } from './builderClient.ts';

export type Seat = 'me' | 'opp';

export interface SoundEvent {
  role: string;
  /** A `<ColourId>|<ParadigmId>` cell layered on top of the role. */
  colourCell?: string | null;
  seat?: Seat;
  /**
   * How heavy it is, 0 to 1: a hit's `damagePower` (`play/motion.ts`). Louder and lower the heavier
   * (the operator, 2026-10-16: damage must "scale the speed, sound, and size"); absent, as recorded.
   */
  intensity?: number;
}

/** A voice's level and playback rate for an event of `intensity`: four fifths and a touch high at 0, a quarter louder and lower at 1. */
export function intensityVoice(intensity: number | undefined): { gain: number; rate: number } {
  if (intensity === undefined) return { gain: 1, rate: 1 };
  const i = Math.min(1, Math.max(0, intensity));
  return { gain: 0.8 + 0.45 * i, rate: 1.06 - 0.16 * i };
}

export interface MixSettings {
  bus: Record<SoundBus, number>;
  /** Multiplier on the opponent's game and colour layers. */
  opponent: number;
  collapseMs: number;
}

/**
 * Interface sounds sit low: they fire constantly, and one as loud as the game
 * is one a player mutes within a minute (the original cue rule, *"on, at a low
 * volume"*).
 */
export const DEFAULT_MIX: MixSettings = {
  bus: { ui: 0.5, game: 1, colour: 0.9, music: 0.35 },
  opponent: 0.6,
  collapseMs: 80,
};

export interface PlannedVoice {
  cell: string;
  file: string;
  bus: SoundBus;
  gain: number;
  duck: boolean;
  /** Played backwards: the event was a `REVERSED_ROLES` one. */
  reverse?: true;
  /** Its playback rate when not 1: a heavier event's voice is lower (`intensityVoice`). */
  rate?: number;
}

export type SkipReason = 'empty' | 'collapsed' | 'opponent-ui' | 'unknown-role';

export interface PlanResult {
  voices: PlannedVoice[];
  skipped: { cell: string; reason: SkipReason }[];
}

export interface MixPlanner {
  setAssignments(cells: Readonly<Record<string, readonly string[]>>, gains: Readonly<Record<string, number>>): void;
  plan(event: SoundEvent, nowMs: number, settings: MixSettings): PlanResult;
  /** One cell's level as stored, 1 when unset. */
  gainOf(cell: string): number;
}

export function createMixPlanner(rng: () => number = Math.random): MixPlanner {
  let cells: Readonly<Record<string, readonly string[]>> = {};
  let gains: Readonly<Record<string, number>> = {};
  const lastPick = new Map<string, string>();
  const lastAt = new Map<string, number>();

  const gainOf = (cell: string): number => gains[cell] ?? 1;

  return {
    setAssignments(c, g) {
      cells = c;
      gains = g;
    },
    gainOf,
    plan(event, nowMs, settings) {
      const seat = event.seat ?? 'me';
      const reversedFrom = REVERSED_ROLES[event.role];
      const roleCell = `${reversedFrom ?? event.role}|play`;
      const role = SOUND_ROLES.get(reversedFrom ?? event.role);
      if (role === undefined) return { voices: [], skipped: [{ cell: roleCell, reason: 'unknown-role' }] };
      if (seat === 'opp' && role.bus === 'ui') {
        return { voices: [], skipped: [{ cell: roleCell, reason: 'opponent-ui' }] };
      }

      const layers: { cell: string; collapse: string; bus: SoundBus; duck: boolean }[] = [
        { cell: roleCell, collapse: `${event.role}|play`, bus: role.bus, duck: role.duck === true },
      ];
      if (event.colourCell != null) {
        layers.push({ cell: event.colourCell, collapse: event.colourCell, bus: 'colour', duck: false });
      }

      const result: PlanResult = { voices: [], skipped: [] };
      for (const layer of layers) {
        const key = `${layer.collapse}#${seat}`;
        const prev = lastAt.get(key);
        if (prev !== undefined && nowMs - prev < settings.collapseMs) {
          result.skipped.push({ cell: layer.cell, reason: 'collapsed' });
          continue;
        }
        const file = pickRandom(cells[layer.cell] ?? [], lastPick.get(layer.cell) ?? null, rng);
        if (file === null) {
          result.skipped.push({ cell: layer.cell, reason: 'empty' });
          continue;
        }
        lastAt.set(key, nowMs);
        lastPick.set(layer.cell, file);
        const seatLevel = seat === 'opp' ? settings.opponent : 1;
        const weight = intensityVoice(event.intensity);
        result.voices.push({
          cell: layer.cell,
          file,
          bus: layer.bus,
          gain: gainOf(layer.cell) * settings.bus[layer.bus] * seatLevel * weight.gain,
          duck: layer.duck,
          ...(reversedFrom !== undefined && layer.cell === roleCell ? { reverse: true as const } : {}),
          ...(weight.rate === 1 ? {} : { rate: weight.rate }),
        });
      }
      return result;
    },
  };
}
