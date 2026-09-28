/*
 * Mute: the one control a player gets over sound, and the only one they need.
 *
 * ## Why mute is the control, and `prefers-reduced-motion` is not
 *
 * §F.4 of the wave file is worded as a trap and it is worth spelling out. There
 * is no standard "reduce sound" media query — `prefers-reduced-motion` is about
 * MOTION, and reading it as a sound preference would silence the app for every
 * player who turned animations down, which is not what they asked for and not
 * something they could then undo. (`prefers-reduced-transparency`,
 * `prefers-contrast` and `forced-colors` are the other real ones; none of them
 * is about audio either.) So the player's stated preference is the mute button,
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
 * The key is namespaced (`cardtable.sound.muted`) because the artifact origin is
 * shared with whatever else this app stores.
 */

/** The `localStorage` key. Namespaced; the origin is shared. */
export const MUTE_KEY = 'cardtable.sound.muted';

/**
 * Master volume, 0..1, multiplied into every cue's relative gain.
 *
 * Low on purpose — §F.4's *"on, at a low volume"*. A UI cue that is as loud as
 * the game the player is also listening to is a cue they will mute within a
 * minute, and then they will not hear `deny` either. There is no volume slider:
 * mute is the control the brief asked for, and a slider is a preference to
 * store, a widget to place and a range to validate for a gain nobody has tuned
 * against real assets yet. When the assets land, this becomes the interesting
 * number.
 */
export const CUE_VOLUME = 0.18;

/** `true` when the player has muted. Authoritative once loaded. */
let muted: boolean | null = null;

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

/** Whether cues are currently silenced. Reads the store once, then memoises. */
export function isMuted(): boolean {
  if (muted === null) muted = load() ?? false;
  return muted;
}

/** Set the preference, persist it best-effort, and tell every subscriber. */
export function setMuted(value: boolean): void {
  if (muted !== null && muted === value) return;
  muted = value;
  save(value);
  for (const fn of [...listeners]) fn();
}

/** Flip it. Returns the new value, so a click handler needs one call. */
export function toggleMuted(): boolean {
  const next = !isMuted();
  setMuted(next);
  return next;
}

/**
 * Subscribe to changes. Returns the unsubscribe.
 *
 * Shaped for `useSyncExternalStore`, which is what `MuteButton` uses: two tabs
 * of the app do not share this (each has its own module instance), but two
 * buttons on one page must agree, and a React component must not read a mutable
 * module global during render without a subscription.
 */
export function subscribeMuted(fn: Listener): () => void {
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
  listeners.clear();
}
