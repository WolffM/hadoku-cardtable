/*
 * The app's sound, behind roles.
 *
 * ## The API, in full
 *
 *     import { playRole, roleHandler, playSoundEvents } from '../sound/index.ts';
 *
 *     playRole('ui.select');                              // make a noise, now
 *     <div onMouseEnter={roleHandler('ui.hover-card')} /> // a stable listener
 *     playSoundEvents(deriveSoundEvents(prev, next));     // a board moment
 *     setScreenMusic('music.lobby'); setMatchMusic(roles); // what loops underneath
 *
 * A role is a name from `@hadoku/shared`'s `SOUND_ROLES`. Which take it plays,
 * how loud, and whether a colour layer sits on top is the operator's
 * assignment (`#/sounds`), loaded from `/api/sounds/assignments` the first
 * time anything plays. No component constructs audio, holds a URL, or decides
 * whether the player wants sound: that is the discipline that kept card art
 * to one resolver, for the same reason (`packages/carddata/src/art/index.ts`).
 *
 *   playRole ─┬─ isMuted()?         → ./mute.ts   (the player's say: mute and two levels)
 *             └─ mixer.play(event)  → ./mixer.ts  (plan: ./mix.ts; audio: WebAudio)
 *
 * A role nobody has assigned plays nothing. That is the normal state of a
 * fresh install, not an error.
 *
 * ## Tests
 *
 * `setRolePlayer` swaps the mixer for a recorder, so a test asserts which
 * events the app raised without an audio device.
 */

import { soundsClient } from './builderClient.ts';
import type { SoundEvent } from './mix.ts';
import { createMixer, type Mixer, type MusicChoice } from './mixer.ts';
import { getLevel, isMuted, subscribeSound } from './mute.ts';

export interface RolePlayer {
  play(event: SoundEvent): unknown;
  loop?(role: MusicChoice): void;
}

/** A sound event that starts a little after the moment it belongs to. */
export interface DelayedSoundEvent extends SoundEvent {
  delayMs?: number;
}

let injected: RolePlayer | null = null;
let production: Mixer | null = null;
/** The screen's music (`null`: a silent screen), and the match's while one is on it. */
let screenMusic: string | null = null;
let matchMusic: readonly string[] | null = null;
let unsubscribeSound: (() => void) | null = null;

/** Replace the player. `null` restores the real mixer. For tests. */
export function setRolePlayer(player: RolePlayer | null): void {
  injected = player;
}

/** Forget the injected player and the real mixer, so the next play builds afresh. For tests. */
export function resetRolePlayerForTests(): void {
  injected = null;
  production = null;
  screenMusic = null;
  matchMusic = null;
  unsubscribeSound?.();
  unsubscribeSound = null;
}

/** Where there is no WebAudio (jsdom, an old browser) nothing is built and nothing is fetched. */
const SILENT: RolePlayer = { play: () => undefined };

function hasWebAudio(): boolean {
  const g = globalThis as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return g.AudioContext !== undefined || g.webkitAudioContext !== undefined;
}

function player(): RolePlayer {
  if (injected !== null) return injected;
  if (production === null) {
    if (!hasWebAudio()) return SILENT;
    const client = soundsClient();
    const mixer = createMixer((f) => client.takeUrl(f));
    production = mixer;
    applyLevels();
    unsubscribeSound ??= subscribeSound(applyPrefs);
    void client.assignments().then((a) => {
      mixer.planner.setAssignments(a.cells, a.gains);
      mixer.preload(Object.values(a.cells).flat());
      applyMusic();
    });
  }
  return production;
}

/*
 * Interface sounds raised since the last take, by role. A hover fires far too often to log one line each, so
 * the match screen folds these counts into its log now and then (the operator, 2026-10-11, wanting "a graph of
 * how often certain sounds are played"). `ui.pass`, `ui.prompt` and `ui.priority` are left out: each is
 * already logged as it sounds.
 */
const LOGGED_ONE_BY_ONE = new Set(['ui.pass', 'ui.prompt', 'ui.priority']);
const uiTally = new Map<string, number>();

/** The interface sounds raised since the last call, and a fresh count from here. */
export function takeUiTally(): Record<string, number> {
  const out = Object.fromEntries(uiTally);
  uiTally.clear();
  return out;
}

/** Play one sound event. Silent when muted; never throws into the handler that asked. */
export function playEvent(event: SoundEvent): void {
  if (event.role.startsWith('ui.') && !LOGGED_ONE_BY_ONE.has(event.role)) {
    uiTally.set(event.role, (uiTally.get(event.role) ?? 0) + 1);
  }
  try {
    if (isMuted()) return;
    player().play(event);
  } catch {
    // Sound is decoration. Nothing it does is worth breaking a click over.
  }
}

/** Play a role, from the viewer's own seat. */
export function playRole(role: string): void {
  playEvent({ role });
}

/** Play a board moment's events, each after its own delay. */
export function playSoundEvents(events: readonly DelayedSoundEvent[]): void {
  for (const { delayMs, ...event } of events) {
    if (delayMs === undefined || delayMs <= 0) playEvent(event);
    else setTimeout(() => playEvent(event), delayMs);
  }
}

function applyLevels(): void {
  production?.setLevels({ volume: getLevel('volume'), music: getLevel('music') });
}

function applyPrefs(): void {
  applyLevels();
  applyMusic();
}

function applyMusic(): void {
  try {
    const wanted = screenMusic === null ? null : (matchMusic ?? screenMusic);
    player().loop?.(isMuted() ? null : wanted);
  } catch {
    // Music is decoration too.
  }
}

/**
 * What loops under the current screen: a `music.*` role, or `null` for a
 * silent screen. The app root sets it per route. Muting fades it out and
 * unmuting brings it back.
 */
export function setScreenMusic(role: string | null): void {
  screenMusic = role;
  unsubscribeSound ??= subscribeSound(applyPrefs);
  applyMusic();
}

/**
 * A match is on screen: the first of `roles` that has a take replaces the
 * screen's music while it is (`./match-music.ts` picks them; an empty list is a
 * match whose music is not known yet, and plays nothing). `null`: no match.
 * Separate from the route because a room hosts its match in place, and because
 * React runs a child's effect before its parent's: two inputs make the order
 * not matter.
 */
export function setMatchMusic(roles: readonly string[] | null): void {
  matchMusic = roles;
  applyMusic();
}

/**
 * For a screen's `onPointerOver`: the pointer arriving on an enabled button plays the card hover. One sound for
 * both (the operator, 2026-10-16: "drop hover a button. make it the same as hover a card"). A card tile that is a
 * button plays its own hover, and moving between a button's children is not arriving.
 */
export function hoverControl(event: { target: EventTarget | null; relatedTarget: EventTarget | null }): void {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (button === null || button.disabled || button.hasAttribute('data-card-id')) return;
  if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
  playRole('ui.hover-card');
}

const handlers = new Map<string, () => void>();

/**
 * A listener that plays `role`, referentially stable across renders, so a
 * memoised component (`CardTile`: a draft screen holds 60) stays memoised.
 */
export function roleHandler(role: string): () => void {
  const existing = handlers.get(role);
  if (existing !== undefined) return existing;
  const fn = (): void => playRole(role);
  handlers.set(role, fn);
  return fn;
}

export {
  MUSIC_STYLE_KEY,
  MUTE_KEY,
  getLevel,
  getMusicStyle,
  isMuted,
  resetMutedForTests,
  setLevel,
  setMusicStyle,
  setMuted,
  subscribeSound,
  type LevelName,
} from './mute.ts';

