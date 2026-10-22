/*
 * A cube's own art, the way `CardTile` draws a card's: an id, resolved to a
 * URL by `cardImageUrl` (the committed `art-manifest.json` plus Scryfall's
 * sharded path — never a stored URL, AGENTS.md: "a card's art is a lookup,
 * not a URL"). Shared by the room's cube gallery and `#/inventory` (AF305
 * §B), so a cube tile looks the same wherever it is drawn.
 *
 * The whole printed card is a tall, narrow image; a gallery tile's art strip
 * is short and wide, so a plain `object-fit: cover` centred the card's TYPE
 * LINE and rules box in the tile instead of its illustration — found live,
 * AF305's screenshot review. `coverCropStyle` (`components/faceCrop.ts`,
 * extended for this rather than duplicated) frames the image on
 * `ILLUSTRATION_BOX` instead: full width, vertically centred on the
 * artwork, whatever the tile's own aspect ratio is. Never Scryfall's
 * `art_crop` — `cardImage.ts`'s own header is why.
 *
 * No art id, a malformed one, or a fetch that 404s all draw the same tinted
 * placeholder — the cube's own initial — never a broken image icon.
 */
import { useState } from 'react';

import { coverCropStyle, ILLUSTRATION_BOX } from '../components/faceCrop.ts';
import { cardImageUrl } from './cardImage.ts';
import './CubeArt.css';

/** `CubeArt.css`'s own `aspect-ratio` on `.cube-art` — the one number both files must agree on. */
export const CUBE_ART_RATIO = 5 / 2;

export function CubeArt({ artId, name }: { artId: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const url = artId !== null ? cardImageUrl(artId) : null;
  if (url !== null && !failed) {
    return (
      <span className="cube-art">
        <img
          className="cube-art__img"
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          style={coverCropStyle(ILLUSTRATION_BOX, CUBE_ART_RATIO)}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className="cube-art cube-art--placeholder" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
