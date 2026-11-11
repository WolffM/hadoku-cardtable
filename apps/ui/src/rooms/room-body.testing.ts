/**
 * A test's hand-built room body as the server sends it: Magic's fields (`magicRoomFields`) under
 * `game`, where the browser reads them. The fields stay at the top level too, as the server
 * restates them there.
 */
import { magicRoomFields } from '@hadoku/shared';

const MAGIC_KEYS = Object.keys(magicRoomFields);

export function withMagicGame<T extends object>(body: T): T & { game: Record<string, unknown> } {
  const game = Object.fromEntries(Object.entries(body).filter(([key]) => MAGIC_KEYS.includes(key)));
  return { ...body, game };
}
