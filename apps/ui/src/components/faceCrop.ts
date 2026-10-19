/**
 * One face of a card whose faces share one printed image: a split card's half, an aftermath card's
 * half, an adventure's spell. The image is the whole card, so a tile for one face shows only the part
 * of it that face is printed in, turned upright (the operator, 2026-10-19: "i see the entire split card
 * in both choices so i can't really tell which one is which").
 *
 * The regions are read off the printed layouts (Scryfall `normal` images, 488 × 680, checked on
 * Fire // Ice, Unholy Annex // Ritual Chamber, Cut // Ribbons and Bonecrusher Giant):
 *
 * - a split card — and a Duskmourn room, which Forge models as one — is printed sideways: the left
 *   half is the image's bottom half, the right half its top, both read after a quarter turn clockwise;
 * - an aftermath card's first half is its upright top, the second its bottom turned a quarter the
 *   other way;
 * - an adventure's spell is the inset at the lower left of the text box, upright.
 *
 * A face with art of its own (a modal or transforming double-faced card's back) is never cropped.
 */

import type { CSSProperties } from 'react';

import type { DraftCard } from '../draft/types.ts';

export type FacePart = 'split-left' | 'split-right' | 'aftermath-top' | 'aftermath-bottom' | 'adventure';

/** A card as a tile draws it: a face that shares the card's image says which part of it is its own. */
export type TileCard = DraftCard & { readonly faceCrop?: FacePart };

/** Where a face is printed, as fractions of the image's width and height, and the turn that sets it upright. */
export interface FaceRegion {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Degrees clockwise. */
  readonly rotate: 0 | 90 | -90;
}

export const FACE_REGIONS: Readonly<Record<FacePart, FaceRegion>> = {
  'split-left': { x: 0, y: 0.5, w: 1, h: 0.5, rotate: 90 },
  'split-right': { x: 0, y: 0, w: 1, h: 0.5, rotate: 90 },
  'aftermath-top': { x: 0, y: 0, w: 1, h: 0.54, rotate: 0 },
  'aftermath-bottom': { x: 0, y: 0.54, w: 1, h: 0.46, rotate: -90 },
  adventure: { x: 0.045, y: 0.61, w: 0.465, h: 0.29, rotate: 0 },
};

/** A card image's own proportion, width over height — the tile's too (`styles.css`, `.card:has(.card__art)`). */
const CARD_ASPECT = 488 / 680;

const pct = (n: number): string => `${+(n * 100).toFixed(4)}%`;

/**
 * The card image's placement inside a card-shaped tile so that only `part` shows, upright, as large as
 * fits and centred. The image is scaled, its region's centre put on the tile's centre, turned about
 * that point, and clipped to the region (`clip-path` applies before the turn, in the image's own box).
 */
export function faceCropStyle(part: FacePart): CSSProperties {
  const { x, y, w, h, rotate } = FACE_REGIONS[part];
  // In tile widths: the image is 1 wide and 1/CARD_ASPECT tall at scale 1, as the tile is.
  const regionW = w;
  const regionH = h / CARD_ASPECT;
  const [uprightW, uprightH] = rotate === 0 ? [regionW, regionH] : [regionH, regionW];
  const scale = Math.min(1 / uprightW, 1 / CARD_ASPECT / uprightH);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    width: pct(scale),
    height: pct(scale),
    left: pct(0.5 - cx * scale),
    top: pct(0.5 - cy * scale),
    transformOrigin: `${pct(cx)} ${pct(cy)}`,
    transform: `rotate(${rotate}deg)`,
    clipPath: `inset(${pct(y)} ${pct(1 - x - w)} ${pct(1 - y - h)} ${pct(x)})`,
  };
}
