/*
 * The player's say over sound: mute, overall volume, the music bus under
 * everything else, and which track a music role plays when it has more
 * than one (one at random until they choose). Drawn in the game's own
 * settings; applied to the mixer by `./index.ts`.
 *
 * No "reduce sound" media query exists — `prefers-reduced-motion` is about
 * motion, and reading it as a sound preference would silence players who
 * never asked for that. Default: on, at a low volume.
 *
 * Kept in the fleet's preference service: `games` (`muted`, `volume`, the
 * master every hadoku game shares — `GAMES_ROW`, not this game's row) and
 * `<appId>-sound` (`music`, `musicPicks` — this game's own, so two games
 * never collide). The three levels are per DEVICE, as `localStorage` held
 * them; music picks are per PLAYER. Values live here in memory, read
 * synchronously on every sound; `useSoundPrefs` connects them to the
 * service once per page. The old `<appId>.sound.*` keys are read once, as
 * a migration, and removed.
 */

import { useEffect } from 'react';
import { z } from 'zod';
import { createPrefsClient, type PrefsClient } from '@wolffm/prefs-client';
import { GAMES_DEFAULTS, GAMES_ROW, type GamesPrefs } from '@wolffm/prefs-client/platform';

import { appId } from '../app-id/index.ts';

/** `volume` scales everything; `music` scales the music bus under it. Both 0..1. */
export type LevelName = 'volume' | 'music';

/** A level nobody has set: the music starts at half, under the game's own sounds; everything else full. */
export const LEVEL_DEFAULTS: Readonly<Record<LevelName, number>> = { volume: GAMES_DEFAULTS.volume, music: 0.5 };

const LevelSchema = z.number().min(0).max(1);

export const SoundPrefsSchema = z
  .object({
    music: LevelSchema.optional(),
    /** The track per music role, by role id. */
    musicPicks: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type SoundPrefs = z.infer<typeof SoundPrefsSchema>;

/** The `localStorage` keys the values lived in before the service held them, built from `appId()`. Called lazily — never at module load — so importing this before `configureShell` runs does not throw. */
export function legacyKeys(): Readonly<{ muted: string; volume: string; music: string; musicPicks: string }> {
  const prefix = appId();
  return {
    muted: `${prefix}.sound.muted`,
    volume: `${prefix}.sound.volume`,
    music: `${prefix}.sound.music`,
    musicPicks: `${prefix}.sound.music-picks`,
  };
}

let muted = GAMES_DEFAULTS.muted;
let musicPicks: Record<string, string> = {};
const levels: Record<LevelName, number> = { ...LEVEL_DEFAULTS };

type Listener = () => void;
const listeners = new Set<Listener>();

interface Connection {
  games: PrefsClient<GamesPrefs>;
  sound: PrefsClient<SoundPrefs>;
}
/** The service, once `useSoundPrefs` has connected it; until then a change is held for the page. */
let connection: Connection | null = null;

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Whether sounds are currently silenced. */
export function isMuted(): boolean {
  return muted;
}

/** Set the preference, save it, and tell every subscriber. */
export function setMuted(value: boolean): void {
  if (muted === value) return;
  muted = value;
  void connection?.games.save({ muted: value }, { scope: GAMES_ROW.scope });
  notify();
}

/** A level, 0..1. */
export function getLevel(name: LevelName): number {
  return levels[name];
}

/** Set a level, save it, and tell every subscriber. */
export function setLevel(name: LevelName, value: number): void {
  const next = clamp(value);
  if (levels[name] === next) return;
  levels[name] = next;
  if (name === 'volume') void connection?.games.save({ volume: next }, { scope: GAMES_ROW.scope });
  else void connection?.sound.save({ music: next }, { scope: 'device' });
  notify();
}

/** The take the player chose for a music role, or `null` for none chosen. */
export function getMusicPick(role: string): string | null {
  return musicPicks[role] ?? null;
}

/** Choose a music role's track, save it, and tell every subscriber. */
export function setMusicPick(role: string, file: string): void {
  if (getMusicPick(role) === file) return;
  musicPicks = { ...musicPicks, [role]: file };
  void connection?.sound.save({ musicPicks });
  notify();
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Subscribe to any change: mute, a level or a music pick. Returns the unsubscribe.
 *
 * Shaped for `useSyncExternalStore`: two controls on one page must agree,
 * and a React component must not read a mutable module global during
 * render without a subscription. Another tab's change arrives through the
 * service's own broadcast and lands here.
 */
export function subscribeSound(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** What the service holds, adopted field by field: a field it does not hold keeps the page's value. */
function adopt(games: GamesPrefs, sound: SoundPrefs): void {
  const before = JSON.stringify([muted, levels, musicPicks]);
  if (games.muted !== undefined) muted = games.muted;
  if (games.volume !== undefined) levels.volume = games.volume;
  if (sound.music !== undefined) levels.music = sound.music;
  if (sound.musicPicks !== undefined) musicPicks = sound.musicPicks;
  if (JSON.stringify([muted, levels, musicPicks]) !== before) notify();
}

/** Whatever the old `<appId>.sound.*` keys still hold, parsed; anything unreadable is absent. */
export function readLegacy(store: Storage | undefined = globalThis.localStorage): GamesPrefs & SoundPrefs {
  const out: GamesPrefs & SoundPrefs = {};
  if (store === undefined) return out;
  const raw = (key: string): string | null => {
    try {
      return store.getItem(key);
    } catch {
      // A blocked store holds nothing to move.
      return null;
    }
  };
  const keys = legacyKeys();
  const m = raw(keys.muted);
  if (m === 'true' || m === 'false') out.muted = m === 'true';
  for (const name of ['volume', 'music'] as const) {
    const v = raw(keys[name]);
    const n = v === null ? NaN : Number(v);
    if (Number.isFinite(n)) out[name] = clamp(n);
  }
  const p = raw(keys.musicPicks);
  if (p !== null) {
    try {
      const parsed = SoundPrefsSchema.shape.musicPicks.safeParse(JSON.parse(p));
      if (parsed.success && parsed.data !== undefined) out.musicPicks = parsed.data;
    } catch {
      // Not JSON: no picks to move.
    }
  }
  return out;
}

function removeLegacy(store: Storage | undefined = globalThis.localStorage): void {
  for (const key of Object.values(legacyKeys())) {
    try {
      store?.removeItem(key);
    } catch {
      // A blocked store: the keys stay, and are read again (and found already moved) next time.
    }
  }
}

/** Each a row of its own, built on first connect; one per app id, as the SDK promises. */
let clients: Connection | null = null;

function soundClients(): Connection {
  clients ??= {
    // No `defaults`: an unset field is how `connectSoundPrefs` knows the legacy key still has to move.
    games: createPrefsClient({ appId: GAMES_ROW.appId, schema: GAMES_ROW.schema }) as PrefsClient<GamesPrefs>,
    sound: createPrefsClient({ appId: `${appId()}-sound`, schema: SoundPrefsSchema }) as PrefsClient<SoundPrefs>,
  };
  return clients;
}

/**
 * Connect the sound settings to the preference service for as long as the calling component is
 * mounted: adopt what it holds, follow its changes (another tab, another host on the page), and
 * save every change made here. The first time a page connects, a value only the old keys hold is
 * saved to the service and the keys are removed. `ready` settles once the service's first answer
 * is adopted.
 */
export function connectSoundPrefs(): { ready: Promise<void>; disconnect: () => void } {
  const c = soundClients();
  connection = c;
  const legacy = readLegacy();
  adopt(legacy, legacy);
  let games: GamesPrefs = {};
  let sound: SoundPrefs = {};
  const offGames = c.games.subscribe((next) => {
    games = next;
    adopt(games, sound);
  });
  const offSound = c.sound.subscribe((next) => {
    sound = next;
    adopt(games, sound);
  });
  const ready = Promise.all([c.games.read(), c.sound.read()]).then(([g, s]) => {
    if (connection !== c) return;
    games = g;
    sound = s;
    const toGames: GamesPrefs = {};
    if (g.muted === undefined && legacy.muted !== undefined) toGames.muted = legacy.muted;
    if (g.volume === undefined && legacy.volume !== undefined) toGames.volume = legacy.volume;
    if (Object.keys(toGames).length > 0) void c.games.save(toGames, { scope: GAMES_ROW.scope });
    if (s.music === undefined && legacy.music !== undefined) void c.sound.save({ music: legacy.music }, { scope: 'device' });
    if (s.musicPicks === undefined && legacy.musicPicks !== undefined) void c.sound.save({ musicPicks: legacy.musicPicks });
    removeLegacy();
    adopt(games, sound);
  });
  return {
    ready,
    disconnect() {
      offGames();
      offSound();
      if (connection === c) connection = null;
    },
  };
}

/** `connectSoundPrefs` for the life of the component that calls it: the app's root, standalone or embedded. */
export function useSoundPrefs(): void {
  useEffect(() => connectSoundPrefs().disconnect, []);
}

/**
 * Back to the defaults, disconnected, with no subscribers.
 *
 * For tests, which start each case from a fresh page. Production never calls it.
 */
export function resetMutedForTests(): void {
  muted = GAMES_DEFAULTS.muted;
  musicPicks = {};
  Object.assign(levels, LEVEL_DEFAULTS);
  listeners.clear();
  connection = null;
  clients = null;
}
