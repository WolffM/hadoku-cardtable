/*
 * Which music a match plays: the operator, 2026-10-16 — "when we load up a deck
 * with more than one color we pick one at random. the music starts when the
 * game starts" — and 2026-10-17, with a track per colour pair — "if we have a 3
 * color deck, it should pick from the three 2color combos that can match it
 * randomly. 4color+ is any music at random."
 *
 *   - One colour plays its colour (`music.match.<C>`).
 *   - Two play their pair (`music.match.<pair>`, spelled as `COLOUR_PAIRS`).
 *   - Three play one of the three pairs inside them, picked once per match.
 *   - Four or five, and a deck with no colour to go by — a colourless deck, a
 *     precon the server never saw, a watcher — play any of the fifteen colour
 *     and pair tracks, picked once per match.
 *   - Whatever has no take falls through to the next: the rest of the deck's
 *     candidates, then (for two or three colours) the deck's own mono colours,
 *     then `music.match`, then the rest of the fifteen, starting from one
 *     picked once per match — so a table with any match track placed is never
 *     silent.
 *
 * "Once per match" is a hash of the match id, not a stored roll: the same pick
 * on every render, reconnect and reload, and a fresh one each match (match ids
 * are random). The mixer plays the first role of the list that has a take
 * (`./mixer.ts`'s `loop`).
 */
import { colourPair, matchMusicRole, MATCH_MUSIC_ROLES, type ManaColor } from '@hadoku/shared';

/** One of `n`, the same for a match id every time it is asked. FNV-1a. */
export function pickFor(matchId: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < matchId.length; i++) {
    h ^= matchId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % n;
}

/** `list` from its match-picked entry round to the one before it. */
function rotated(matchId: string, list: readonly string[]): string[] {
  const start = pickFor(matchId, list.length);
  return [...list.slice(start), ...list.slice(0, start)];
}

/** The roles a deck of exactly these colours picks among; empty when any track will do. */
function candidates(colors: readonly ManaColor[]): string[] {
  if (colors.length === 1) return [matchMusicRole(colors[0]!)];
  if (colors.length === 2 || colors.length === 3) {
    const pairs: string[] = [];
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) pairs.push(matchMusicRole(colourPair(colors[i]!, colors[j]!)!));
    }
    return pairs;
  }
  return [];
}

/**
 * The music roles for a match, best first. `colors` is what the server said of
 * your deck (`@hadoku/shared`'s `forge:deck-colors`): absent until it has,
 * which is an empty list — nothing plays until the match knows what to play.
 */
export function matchMusicRoles(matchId: string, colors: readonly ManaColor[] | null | undefined): string[] {
  if (colors === undefined) return [];
  const deck = [...new Set(colors ?? [])];
  const own = candidates(deck);
  const roles = rotated(matchId, own.length > 0 ? own : MATCH_MUSIC_ROLES);
  if (deck.length === 2 || deck.length === 3) roles.push(...deck.map((c) => matchMusicRole(c)));
  roles.push('music.match');
  for (const role of rotated(matchId, MATCH_MUSIC_ROLES)) if (!roles.includes(role)) roles.push(role);
  return roles;
}
