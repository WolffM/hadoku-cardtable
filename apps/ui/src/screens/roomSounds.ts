/*
 * The room's comings and goings (the operator, 2026-11-08: "a sound for when someone joins a card table
 * room and also a sound for when they ready up", and one for leaving). Another member arriving plays
 * `ui.room-join`, one going `ui.room-leave`, and anyone readying, you included, `ui.room-ready`. Every
 * screen in the room hears the same changes, as the room's own reads report them.
 *
 * A screen hears only changes it saw happen: the first snapshot it reads is the baseline, and so is the
 * first after the readiness it reads from changes source (a mode switch, the Gauntlet's state arriving).
 * One update plays each role at most once, so a pod filling in one read is one join, not five.
 * Each role falls back to a sound the app already had until one is assigned (`FALLBACK_ROLES`).
 */
import { useEffect, useRef } from 'react';

import { playRole } from '../sound/index.ts';

/** What the room looks like for its sounds: who is in it besides you, and who is ready. */
export interface RoomPresence {
  /** Every member's id except the viewer's own. */
  others: readonly string[];
  /** A key per ready member or seat. */
  ready: readonly string[];
  /** What the ready keys are read from; a change of source rebaselines readiness rather than sounding. */
  readySource: string;
}

/** The roles one change of the room plays, in order: joins, leaves, then readies. */
export function presenceRoles(before: RoomPresence, after: RoomPresence): string[] {
  const roles: string[] = [];
  const was = new Set(before.others);
  const is = new Set(after.others);
  if (after.others.some((id) => !was.has(id))) roles.push('ui.room-join');
  if (before.others.some((id) => !is.has(id))) roles.push('ui.room-leave');
  if (before.readySource === after.readySource) {
    const wasReady = new Set(before.ready);
    if (after.ready.some((key) => !wasReady.has(key))) roles.push('ui.room-ready');
  }
  return roles;
}

/** Sounds each change of `presence`; `null` while the room has not been read, which sounds nothing and resets the baseline. */
export function useRoomSounds(presence: RoomPresence | null): void {
  const last = useRef<RoomPresence | null>(null);
  const key = presence === null ? null : JSON.stringify(presence);
  useEffect(() => {
    const now = key === null ? null : (JSON.parse(key) as RoomPresence);
    if (now !== null && last.current !== null) for (const role of presenceRoles(last.current, now)) playRole(role);
    last.current = now;
  }, [key]);
}
