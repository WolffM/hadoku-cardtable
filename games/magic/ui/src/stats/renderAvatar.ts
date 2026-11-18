/*
 * A player's face on the stats pages: game-stats-ui's own, in the fleet's one
 * order — their picture, else their character, else their initial — with the
 * platform's character art (`avatarSquareUrl`, the same images the table draws).
 */

import { characterAvatar } from "@wolffm/game-stats-ui";
import { avatarSquareUrl } from "@hadoku/game-ui/room/avatar.ts";

export const renderAvatar = characterAvatar((sprite) =>
  avatarSquareUrl(sprite),
);
