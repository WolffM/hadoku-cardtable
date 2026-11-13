/*
 * A new room's starting name: "<the creator's name>'s <word>", the word drawn at random each time
 * the create form opens. The operator, 2026-11-05: "prefill a placeholder name '{player name}'s
 * room' … have a selection of ~50 different words we could use in place of room".
 */

import { ROOM_NAME_MAX } from '@hadoku/shared';

/** Single Title Case words for a place to play cards. */
export const ROOM_WORDS = [
  'Room', 'Table', 'Den', 'Lair', 'Tavern', 'Hall', 'Parlor', 'Lounge', 'Arena', 'Sanctum',
  'Study', 'Library', 'Workshop', 'Dungeon', 'Keep', 'Tower', 'Hideout', 'Camp', 'Kitchen', 'Cellar',
  'Attic', 'Garden', 'Grove', 'Court', 'Cabin', 'Cottage', 'Castle', 'Fort', 'Citadel', 'Observatory',
  'Laboratory', 'Greenhouse', 'Porch', 'Treehouse', 'Lighthouse', 'Inn', 'Pub', 'Clubhouse', 'Bunker', 'Burrow',
  'Nest', 'Hollow', 'Grotto', 'Cavern', 'Temple', 'Shrine', 'Vault', 'Gallery', 'Salon', 'Loft',
  'Barn', 'Hearth',
] as const;

/** `random` is `Math.random`'s shape, so a test can pick the word. */
export function defaultRoomName(playerName: string | null | undefined, random: () => number = Math.random): string {
  const word = ROOM_WORDS[Math.min(ROOM_WORDS.length - 1, Math.floor(random() * ROOM_WORDS.length))];
  const name = playerName?.trim() ?? '';
  return (name === '' ? word : `${name}'s ${word}`).slice(0, ROOM_NAME_MAX);
}
