/*
 * The player's say over sound: mute, overall volume, how loud the music
 * sits under the rest, and which track a music role plays when it has more
 * than one (`getMusicPick`; one at random until they choose). Drawn in cardtable's own settings
 * (`../settings/SoundSettings.tsx`); read by `./index.ts`, which applies them
 * to the mixer.
 *
 * ## Why mute is the control, and `prefers-reduced-motion` is not
 *
 * §F.4 of the wave file is worded as a trap and it is worth spelling out. There
 * is no standard "reduce sound" media query — `prefers-reduced-motion` is about
 * MOTION, and reading it as a sound preference would silence the app for every
 * player who turned animations down, which is not what they asked for and not
 * something they could then undo. (`prefers-reduced-transparency`,
 * `prefers-contrast` and `forced-colors` are the other real ones; none of them
 * is about audio either.) So the player's stated preferences are these three,
 * and nothing else is consulted.
 *
 * Default: **on, at a low volume.** A first-time visitor hears the app.
 *
 * ## Where they are kept: the fleet's preference service (2026-10-30)
 *
 * The operator: settings move into hadoku_site's prefs, so the same values reach cardtable whether
 * it is its own page or a watchparty room's game. Two rows:
 *
 *   - **`games`** — `muted` and `volume`, the master controls every hadoku game shares (bomberman's
 *     half is `docs/requests/SETTINGS_GAMES_PREFS.md`). Not `.strict()`: another game may keep its
 *     own fields beside these.
 *   - **`cardtable-sound`** — `music`, the music bus under the master, and `musicPicks`.
 *
 * The three levels are saved per DEVICE, as they were when they lived in `localStorage`: the right
 * volume is the speakers' and the room's, not the account's. The track picks are per PLAYER: a
 * taste follows its player to another browser.
 *
 * The values are held here, in memory, and every read is synchronous: the mixer asks on every
 * sound. `useSoundPrefs` connects them to the service once per page — `../App.tsx` and
 * `../embed/EmbedApp.tsx` both call it — adopting what it holds and saving every change back.
 * Until it answers, the in-memory value stands; the service's own `localStorage` cache answers
 * within a frame on every load after the first.
 *
 * The `cardtable.sound.*` keys these used to live in are read once, as the first value and as a
 * migration: a value the service does not hold yet is saved to it, and the keys are removed.
 */

import { useEffect } from 'react';
import { z } from 'zod';
import { createPrefsClient, type PrefsClient } from '@wolffm/prefs-client';

/** `volume` scales everything; `music` scales the music bus under it. Both 0..1. */
export type LevelName = 'volume' | 'music';

/**
 * A level nobody has set. The music starts at half (the operator, 2026-10-19:
 * "let's change default music volume to be 50%") so it sits under the game's
 * own sounds; everything else starts full.
 */
export const LEVEL_DEFAULTS: Readonly<Record<LevelName, number>> = { volume: 1, music: 0.5 };

const LevelSchema = z.number().min(0).max(1);

export const GamesPrefsSchema = z.object({
  muted: z.boolean().optional(),
  volume: LevelSchema.optional(),
});
export type GamesPrefs = z.infer<typeof GamesPrefsSchema>;

export const SoundPrefsSchema = z
  .object({
    music: LevelSchema.optional(),
    /** The track per music role, by role id. */
    musicPicks: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type SoundPrefs = z.infer<typeof SoundPrefsSchema>;

/** The `localStorage` keys the values lived in before the service held them. Read once, to move them. */
export const LEGACY_KEYS = {
  muted: 'cardtable.sound.muted',
  volume: 'cardtable.sound.volume',
  music: 'cardtable.sound.music',
  musicPicks: 'cardtable.sound.music-picks',
} as const;

let muted = false;
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
  void connection?.games.save({ muted: value }, { scope: 'device' });
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
  if (name === 'volume') void connection?.games.save({ volume: next }, { scope: 'device' });
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
 * Shaped for `useSyncExternalStore`, which is what `SoundSettings` uses: two controls on one page
 * must agree, and a React component must not read a mutable module global during render without
 * a subscription. Another tab's change arrives through the service's own broadcast and lands here.
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

/** Whatever the old `cardtable.sound.*` keys still hold, parsed; anything unreadable is absent. */
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
  const m = raw(LEGACY_KEYS.muted);
  if (m === 'true' || m === 'false') out.muted = m === 'true';
  for (const name of ['volume', 'music'] as const) {
    const v = raw(LEGACY_KEYS[name]);
    const n = v === null ? NaN : Number(v);
    if (Number.isFinite(n)) out[name] = clamp(n);
  }
  const p = raw(LEGACY_KEYS.musicPicks);
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
  for (const key of Object.values(LEGACY_KEYS)) {
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
    games: createPrefsClient({ appId: 'games', schema: GamesPrefsSchema }) as PrefsClient<GamesPrefs>,
    sound: createPrefsClient({ appId: 'cardtable-sound', schema: SoundPrefsSchema }) as PrefsClient<SoundPrefs>,
  };
  return clients;
}

/**
 * Connect the sound settings to the preference service for as long as the calling component is
 * mounted: adopt what it holds, follow its changes (another tab, another host on this page), and
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
    if (Object.keys(toGames).length > 0) void c.games.save(toGames, { scope: 'device' });
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
  muted = false;
  musicPicks = {};
  Object.assign(levels, LEVEL_DEFAULTS);
  listeners.clear();
  connection = null;
  clients = null;
}
