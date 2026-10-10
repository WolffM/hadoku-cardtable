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
 */

import { SOUND_ROLES, type SoundBus } from '@hadoku/shared';

import { pickRandom } from './builderClient.ts';

export type Seat = 'me' | 'opp';

export interface SoundEvent {
  role: string;
  /** A `<ColourId>|<ParadigmId>` cell layered on top of the role. */
  colourCell?: string | null;
  seat?: Seat;
}

export interface MixSettings {
  bus: Record<SoundBus, number>;
  /** Multiplier on the opponent's game and colour layers. */
  opponent: number;
  collapseMs: number;
}

export const DEFAULT_MIX: MixSettings = {
  bus: { ui: 0.8, game: 1, colour: 0.9 },
  opponent: 0.6,
  collapseMs: 80,
};

export interface PlannedVoice {
  cell: string;
  file: string;
  bus: SoundBus;
  gain: number;
  duck: boolean;
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
      const roleCell = `${event.role}|play`;
      const role = SOUND_ROLES.get(event.role);
      if (role === undefined) return { voices: [], skipped: [{ cell: roleCell, reason: 'unknown-role' }] };
      if (seat === 'opp' && role.bus === 'ui') {
        return { voices: [], skipped: [{ cell: roleCell, reason: 'opponent-ui' }] };
      }

      const layers: { cell: string; bus: SoundBus; duck: boolean }[] = [
        { cell: roleCell, bus: role.bus, duck: role.duck === true },
      ];
      if (event.colourCell != null) layers.push({ cell: event.colourCell, bus: 'colour', duck: false });

      const result: PlanResult = { voices: [], skipped: [] };
      for (const layer of layers) {
        const key = `${layer.cell}#${seat}`;
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
        result.voices.push({
          cell: layer.cell,
          file,
          bus: layer.bus,
          gain: gainOf(layer.cell) * settings.bus[layer.bus] * seatLevel,
          duck: layer.duck,
        });
      }
      return result;
    },
  };
}
