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
 *
 * A role is a name from `@hadoku/shared`'s `SOUND_ROLES`. Which take it plays,
 * how loud, and whether a colour layer sits on top is the operator's
 * assignment (`#/sounds`), loaded from `/api/sounds/assignments` the first
 * time anything plays. No component constructs audio, holds a URL, or decides
 * whether the player wants sound: that is the discipline that kept card art
 * to one resolver, for the same reason (`packages/carddata/src/art/index.ts`).
 *
 *   playRole ─┬─ isMuted()?         → ./mute.ts   (the player's say)
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
import { createMixer, type Mixer } from './mixer.ts';
import { isMuted } from './mute.ts';

export interface RolePlayer {
  play(event: SoundEvent): unknown;
}

/** A sound event that starts a little after the moment it belongs to. */
export interface DelayedSoundEvent extends SoundEvent {
  delayMs?: number;
}

let injected: RolePlayer | null = null;
let production: Mixer | null = null;

/** Replace the player. `null` restores the real mixer. For tests. */
export function setRolePlayer(player: RolePlayer | null): void {
  injected = player;
}

/** Forget the injected player and the real mixer, so the next play builds afresh. For tests. */
export function resetRolePlayerForTests(): void {
  injected = null;
  production = null;
}

function player(): RolePlayer {
  if (injected !== null) return injected;
  if (production === null) {
    const client = soundsClient();
    const mixer = createMixer((f) => client.takeUrl(f));
    production = mixer;
    void client.assignments().then((a) => {
      mixer.planner.setAssignments(a.cells, a.gains);
      mixer.preload(Object.values(a.cells).flat());
    });
  }
  return production;
}

/** Play one sound event. Silent when muted; never throws into the handler that asked. */
export function playEvent(event: SoundEvent): void {
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

export { MUTE_KEY, isMuted, resetMutedForTests, setMuted, subscribeMuted, toggleMuted } from './mute.ts';

/*
 * `MuteButton` is deliberately NOT re-exported here. This module is logic: a
 * component importing `playRole` should not also pull React's JSX runtime and
 * `sound.css` into its dependency graph.
 */
