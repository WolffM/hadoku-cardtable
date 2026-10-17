/*
 * Which music a match plays: the operator, 2026-10-16 — "when we load up a deck
 * with more than one color we pick one at random. the music starts when the
 * game starts."
 *
 *   - Your deck's colour: a mono deck plays its colour (`music.match.<C>`); a
 *     deck of several plays one of them, picked once per match.
 *   - No colour to go by — a colourless deck, a precon the server never saw, a
 *     watcher with no deck — plays `music.match`.
 *   - Whatever has no take falls through to the next: the colour, then
 *     `music.match`, then one of the five colours, picked once per match, so a
 *     table with only the colour tracks placed is never silent.
 *
 * "Once per match" is a hash of the match id, not a stored roll: the same pick
 * on every render, reconnect and reload, and a fresh one each match (match ids
 * are random). The mixer plays the first role of the list that has a take
 * (`./mixer.ts`'s `loop`).
 */
import { matchMusicRole, type ManaColor } from '@hadoku/shared';

const FIVE: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** One of `n`, the same for a match id every time it is asked. FNV-1a. */
export function pickFor(matchId: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < matchId.length; i++) {
    h ^= matchId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % n;
}

/**
 * The music roles for a match, best first. `colors` is what the server said of
 * your deck (`@hadoku/shared`'s `forge:deck-colors`): absent until it has,
 * which is an empty list — nothing plays until the match knows what to play.
 */
export function matchMusicRoles(matchId: string, colors: readonly ManaColor[] | null | undefined): string[] {
  if (colors === undefined) return [];
  const roles: string[] = [];
  if (colors !== null && colors.length > 0) roles.push(matchMusicRole(colors[pickFor(matchId, colors.length)]!));
  roles.push('music.match');
  const any = matchMusicRole(FIVE[pickFor(matchId, FIVE.length)]!);
  if (!roles.includes(any)) roles.push(any);
  return roles;
}
