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
 * ## Persistence is best-effort, by design
 *
 * `localStorage` is per-viewer, per-origin browser storage and it can throw on
 * READ as well as write — a private window, cleared site data, a blocked
 * third-party context. Every access here is inside a `try`/`catch` that falls
 * back to the in-memory value, because a blocked store must cost you a
 * remembered preference and never a blank page. `eslint`'s `no-empty` allows an
 * empty catch in this repo precisely for cases like this one, but these are not
 * empty: each one has the fallback written in it.
 *
 * Per browser, not per player: the right volume is the speakers' and the room's,
 * not the account's. The keys are namespaced (`cardtable.sound.*`) because the
 * origin is shared with whatever else is served from it.
 */

/** The `localStorage` keys. Namespaced; the origin is shared. */
export const MUTE_KEY = 'cardtable.sound.muted';
export const LEVEL_KEYS = { volume: 'cardtable.sound.volume', music: 'cardtable.sound.music' } as const;
export const MUSIC_PICKS_KEY = 'cardtable.sound.music-picks';

/** `volume` scales everything; `music` scales the music bus under it. Both 0..1. */
export type LevelName = keyof typeof LEVEL_KEYS;

/**
 * A level nobody has set. The music starts at half (the operator, 2026-10-19:
 * "let's change default music volume to be 50%") so it sits under the game's
 * own sounds; everything else starts full.
 */
export const LEVEL_DEFAULTS: Readonly<Record<LevelName, number>> = { volume: 1, music: 0.5 };

/** `true` when the player has muted. Authoritative once loaded. */
let muted: boolean | null = null;
/** The player's track per music role, by role id. */
let musicPicks: Record<string, string> | null = null;
const levels: Partial<Record<LevelName, number>> = {};

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Read the stored preference.
 *
 * Returns `null` for "nothing stored, or the store would not tell us", which is
 * the same answer on purpose: both mean *use the default*.
 */
function load(): boolean | null {
  try {
    const raw = globalThis.localStorage?.getItem(MUTE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    // A blocked or unavailable store. The in-memory default stands.
    return null;
  }
}

function save(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, value ? 'true' : 'false');
  } catch {
    // Nothing to do and nothing to report: the preference holds for this page
    // and is simply not remembered for the next one.
  }
}

/** Whether sounds are currently silenced. Reads the store once, then memoises. */
export function isMuted(): boolean {
  if (muted === null) muted = load() ?? false;
  return muted;
}

/** Set the preference, persist it best-effort, and tell every subscriber. */
export function setMuted(value: boolean): void {
  if (muted !== null && muted === value) return;
  muted = value;
  save(value);
  notify();
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** A level, 0..1. Reads the store once, then memoises; anything unreadable is its default. */
export function getLevel(name: LevelName): number {
  const known = levels[name];
  if (known !== undefined) return known;
  let value = LEVEL_DEFAULTS[name];
  try {
    const raw = globalThis.localStorage?.getItem(LEVEL_KEYS[name]);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n)) value = clamp(n);
  } catch {
    // A blocked store: the default.
  }
  levels[name] = value;
  return value;
}

/** Set a level, persist it best-effort, and tell every subscriber. */
export function setLevel(name: LevelName, value: number): void {
  const next = clamp(value);
  if (getLevel(name) === next) return;
  levels[name] = next;
  try {
    globalThis.localStorage?.setItem(LEVEL_KEYS[name], String(next));
  } catch {
    // Held for this page, not remembered for the next.
  }
  notify();
}

function picks(): Record<string, string> {
  if (musicPicks !== null) return musicPicks;
  let value: Record<string, string> = {};
  try {
    const raw = globalThis.localStorage?.getItem(MUSIC_PICKS_KEY);
    const v: unknown = raw == null ? null : JSON.parse(raw);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      value = Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
    }
  } catch {
    // Unreadable or blocked: no picks, and every role plays one of its tracks at random.
  }
  musicPicks = value;
  return value;
}

/** The take the player chose for a music role, or `null` for none chosen. */
export function getMusicPick(role: string): string | null {
  return picks()[role] ?? null;
}

/** Choose a music role's track, persist it best-effort, and tell every subscriber. */
export function setMusicPick(role: string, file: string): void {
  if (getMusicPick(role) === file) return;
  musicPicks = { ...picks(), [role]: file };
  try {
    globalThis.localStorage?.setItem(MUSIC_PICKS_KEY, JSON.stringify(musicPicks));
  } catch {
    // Held for this page, not remembered for the next.
  }
  notify();
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Subscribe to any change: mute, a level or a music pick. Returns the unsubscribe.
 *
 * Shaped for `useSyncExternalStore`, which is what `SoundSettings` uses: two tabs
 * of the app do not share this (each has its own module instance), but two
 * controls on one page must agree, and a React component must not read a mutable
 * module global during render without a subscription.
 */
export function subscribeSound(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Drop the memoised value and every subscriber, so the next `isMuted()` re-reads
 * the store.
 *
 * For tests, which swap `localStorage` between cases. Production never calls it;
 * the preference does not change behind the app's back within one page.
 */
export function resetMutedForTests(): void {
  muted = null;
  musicPicks = null;
  delete levels.volume;
  delete levels.music;
  listeners.clear();
}
