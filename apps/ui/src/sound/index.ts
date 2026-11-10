/*
 * The app's sound, behind roles — `SOUND_ROLES` (`@hadoku/shared`). Which
 * take plays, how loud, and whether a colour layer sits on top is the
 * operator's assignment (`#/sounds`), loaded on first play; a role nobody
 * has assigned plays nothing, the normal state of a fresh install.
 *
 * The mixer, mute store, queue mechanics and gain slider are generic
 * (`@hadoku/ui-shell/sound`, w92-C). This file is the one place that hands
 * them a game's role registry and server client through `createSound`,
 * registered once by the composition root (`../composition.tsx`), and
 * re-exports its instance under the same flat names every importer
 * already uses — nothing above this file changed. `setRolePlayer` swaps
 * the mixer for a recorder, so a test asserts raised events without audio.
 */

import { createSound, type SoundConfig } from '@hadoku/ui-shell/sound';

import { registered } from '../registered.ts';

type Sound = ReturnType<typeof createSound<string>>;
const sound = registered<Sound>('sound');
export const registerSound = (config: SoundConfig<string>): void => sound.set(createSound(config));

/** Each name calls the registered instance when it is called, so an importer can bind it before the composition root runs. */
const live = new Proxy({} as Sound, { get: (_, name: keyof Sound) => (...args: never[]) => (sound.get()[name] as (...a: never[]) => unknown)(...args) });

export const {
  setRolePlayer,
  resetRolePlayerForTests,
  takeUiTally,
  holdMatchQuiet,
  playRole,
  playSoundEvents,
  setTrackNames,
  getMusicTrack,
  subscribeMusicTrack,
  setScreenMusic,
  setMatchMusic,
  roleHandler,
} = live;

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
