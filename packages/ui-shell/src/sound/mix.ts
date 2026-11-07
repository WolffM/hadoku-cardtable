/*
 * What a sound event turns into, decided without an audio device.
 *
 * A `SoundEvent` names a role from the game's injected role registry
 * (never imported by id), optionally a layer cell to mix on top (the
 * game's to define), and whose seat it came from. `plan` says which takes
 * play, how loud and on which bus, or why one stayed silent; an id the
 * registry lacks plans nothing.
 *
 * Rules: role and layer each play if either has a take; the opponent's
 * `ui` roles never play, their others quieter; the same cell from the same
 * seat collapses within `collapseMs`; a multi-take cell varies, never
 * repeating; a `reversed` role plays its target's cell backwards; an empty
 * cell falls back down its `fallback` chain.
 */

export type Seat = 'me' | 'opp';

/** The mixer bus a sound plays on. The layer cell always plays on `colour`. */
export type SoundBus = 'ui' | 'game' | 'colour' | 'music';

/** What the planner needs about one role: everything else is the game's business. */
export interface MixerRole {
  readonly bus: Exclude<SoundBus, 'colour'>;
  /** Briefly lowers every other sound while it plays. */
  readonly duck?: boolean;
}

/** A game's sound-role data, injected rather than imported: a role's bus/duck, its fallback (empty cell) and reversed (no cell of its own) chains. */
export interface RoleRegistry {
  readonly roles: ReadonlyMap<string, MixerRole>;
  readonly fallback: Readonly<Record<string, string>>;
  readonly reversed: Readonly<Record<string, string>>;
}

let ambientRegistry: RoleRegistry = { roles: new Map(), fallback: {}, reversed: {} };

/** The registry a bare `createMixPlanner()` builds against, for a call site that leans on its default. The old `{mix,mixer}.ts` stub sets this once, with the real roles, on import; new code prefers `createSound`. */
export function configureSoundRoles(registry: RoleRegistry): void {
  ambientRegistry = registry;
}

export interface SoundEvent {
  role: string;
  /** A layer cell, laid over the role's own: the game decides what it means. */
  colourCell?: string | null;
  seat?: Seat;
  /** How heavy it is, 0 to 1. Louder and lower the heavier; absent, as recorded. */
  intensity?: number;
}

/** A voice's level and playback rate for an event of `intensity`: four fifths and a touch high at 0, a quarter louder and lower at 1. */
function intensityVoice(intensity: number | undefined): { gain: number; rate: number } {
  if (intensity === undefined) return { gain: 1, rate: 1 };
  const i = Math.min(1, Math.max(0, intensity));
  return { gain: 0.8 + 0.45 * i, rate: 1.06 - 0.16 * i };
}

export interface MixSettings {
  bus: Record<SoundBus, number>;
  /** Multiplier on the opponent's game and layer cells. */
  opponent: number;
  collapseMs: number;
}

/**
 * Interface sounds sit low: they fire constantly, and one as loud as the
 * game is one a player mutes within a minute.
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
  /** Played backwards: the event named a role in the registry's `reversed` map. */
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
  /** Whether a cell has any take to play. Plans nothing. */
  has(cell: string): boolean;
  /** A cell's takes, as assigned. */
  takes(cell: string): readonly string[];
  /** Every take of every cell off the music bus, once each, sorted: what the mixer decodes ahead of time. */
  cueTakes(): string[];
}

/** Pick one file at random, never the same one twice in a row — unless there is only one to pick. */
function pickRandom(files: readonly string[], last: string | null, rng: () => number): string | null {
  if (files.length === 0) return null;
  const options = files.length > 1 && last !== null ? files.filter((f) => f !== last) : files;
  const i = Math.floor(rng() * options.length);
  return options[Math.min(i, options.length - 1)] ?? null;
}

function cueTakesOf(registry: RoleRegistry, cells: Readonly<Record<string, readonly string[]>>): string[] {
  const isMusic = (cell: string): boolean => registry.roles.get(cell.slice(0, cell.indexOf('|')))?.bus === 'music';
  return [...new Set(Object.entries(cells).flatMap(([cell, files]) => (isMusic(cell) ? [] : files)))].sort();
}

function buildPlanner(registry: RoleRegistry, rng: () => number): MixPlanner {
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
    has: (cell) => (cells[cell]?.length ?? 0) > 0,
    takes: (cell) => cells[cell] ?? [],
    cueTakes: () => cueTakesOf(registry, cells),
    plan(event, nowMs, settings) {
      const seat = event.seat ?? 'me';
      const reversedFrom = registry.reversed[event.role];
      let played = reversedFrom ?? event.role;
      while ((cells[`${played}|play`]?.length ?? 0) === 0 && registry.fallback[played] !== undefined) played = registry.fallback[played]!;
      const roleCell = `${played}|play`;
      const role = registry.roles.get(reversedFrom ?? event.role);
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

/** A planner against the game's real roles (`configureSoundRoles`), or against none until something configures one. New code prefers `createSound`. */
export function createMixPlanner(rng: () => number = Math.random): MixPlanner {
  return buildPlanner(ambientRegistry, rng);
}
