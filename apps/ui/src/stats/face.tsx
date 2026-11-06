/*
 * A player's face on the stats pages: the same avatar they wear at the table
 * (`components/Avatar.tsx`): their picture, else their character, with what
 * they wear on it, else their initial. The store sends each player's resolved
 * avatar with the board and the profile; it becomes the face every other
 * screen draws from.
 */

import type { RenderAvatar } from '@wolffm/game-stats-ui';
import type { ResolvedAvatar } from '@wolffm/prefs-client/avatar';
import { LookSchema } from '@hadoku/shared';

import { Avatar, type Face } from '../components/Avatar.tsx';

/** The store's avatar as our face. Guarded like every look off the wire, so a bad field costs that field. */
export function faceOfAvatar(avatar: ResolvedAvatar | undefined): Face {
  if (avatar === undefined) return { id: null };
  const look = LookSchema.safeParse({ picture: avatar.url, cosmetics: avatar.cosmetics });
  return { id: avatar.sprite ?? null, ...(look.success ? { look: look.data } : {}) };
}

export const renderAvatar: RenderAvatar = (name, size, avatar) => (
  <span className={`ct-stats-face ct-stats-face--${size}`} aria-hidden="true">
    <Avatar {...faceOfAvatar(avatar)} fallback="initial" fallbackClassName="ct-stats-face__initial" name={name} />
  </span>
);
