/**
 * A test's hand-built room body as the server sends it: Magic's fields (`magicRoomFields`) moved
 * under `game`, the only place a view carries them.
 */
import { magicRoomFields } from '@hadoku/shared';

const MAGIC_KEYS = Object.keys(magicRoomFields);

export function withMagicGame<T extends object>(body: T): Omit<T, keyof typeof magicRoomFields> & { game: Record<string, unknown> } {
  const entries = Object.entries(body);
  return {
    ...(Object.fromEntries(entries.filter(([key]) => !MAGIC_KEYS.includes(key))) as Omit<T, keyof typeof magicRoomFields>),
    game: Object.fromEntries(entries.filter(([key]) => MAGIC_KEYS.includes(key))),
  };
}
