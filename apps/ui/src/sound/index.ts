/*
 * The app's sound, behind roles — `SOUND_ROLES` (`@hadoku/shared`). Which
 * take plays, how loud, and whether a colour layer sits on top is the
 * operator's assignment (`#/sounds`), loaded on first play; a role nobody
 * has assigned plays nothing, the normal state of a fresh install.
 *
 * The mixer, mute store, queue mechanics and gain slider are generic
 * (`@hadoku/ui-shell/sound`, w92-C). This file is the one place that hands
 * them cardtable's role registry and server client through `createSound`,
 * and re-exports its instance under the same flat names every importer
 * already uses — nothing above this file changed. `setRolePlayer` swaps
 * the mixer for a recorder, so a test asserts raised events without audio.
 */

import { createSound } from '@hadoku/ui-shell/sound';

import { SOUND_REGISTRY } from './registry.ts';
import { soundsClient } from './builderClient.ts';

/** `ui.*` roles already logged one by one as they sound: left out of the interface tally so they are not double-counted. */
const INDIVIDUALLY_LOGGED = new Set(['ui.pass', 'ui.prompt', 'ui.priority']);

/** Built lazily, like the mixer itself: nothing about sound does anything until something plays. */
let cachedClient: ReturnType<typeof soundsClient> | null = null;
function client(): ReturnType<typeof soundsClient> {
  return (cachedClient ??= soundsClient());
}

const sound = createSound({
  registry: SOUND_REGISTRY,
  individuallyLogged: INDIVIDUALLY_LOGGED,
  client: {
    takeUrl: (file, version) => client().takeUrl(file, version),
    loadAssignments: () => client().assignments(),
    loadPack: (pack) => client().pack(pack),
  },
});

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
} = sound;

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
