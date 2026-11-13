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

import type { CardFace, DraftCard } from '../draft/types.ts';
import { CARD_RATIO } from './cardFit.ts';

export type FacePart = 'split-left' | 'split-right' | 'aftermath-top' | 'aftermath-bottom' | 'adventure';

/** Whether a Room's door is open: Forge has it unlocked, and only then do its abilities work. */
export type DoorState = 'locked' | 'unlocked';

/** A door's mark, as its tooltip says it. */
export const DOOR_TIP: Readonly<Record<DoorState, string>> = {
  locked: 'Locked door',
  unlocked: 'Unlocked door',
};

/**
 * One of a card's other faces as a tile draws it: a face that shares the card's image says which part of
 * it is its own, and a Room's door says whether it is unlocked (`play/adapter.ts`'s `BoardCard.doors`).
 */
export type TileFace = CardFace & { readonly faceCrop?: FacePart; readonly door?: DoorState };

/** A card as a tile draws it, its other faces ({@link TileFace}) with it. */
export type TileCard = Omit<DraftCard, 'faces'> & { readonly faceCrop?: FacePart; readonly door?: DoorState; faces?: TileFace[] };

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

/**
 * The illustration box on a modern frame, as fractions of the printed image
 * (488 × 680, `CARD_RATIO`): roughly x 8–92%, y 11–55% (AF305 §B — the
 * operator: cube tiles showed the card's TYPE LINE and rules box, not its
 * art, because they used the whole-card image uncropped). An old frame
 * (Black Lotus, Counterspell) sits slightly differently; this is tuned for
 * the median, not either extreme. Never Scryfall's `art_crop` — that drops
 * the artist/copyright line `cardImage.ts` and `@hadoku/carddata/art` rely
 * on the whole face to carry.
 */
export const ILLUSTRATION_BOX: FaceRegion = { x: 0.08, y: 0.11, w: 0.84, h: 0.44, rotate: 0 };

const pct = (n: number): string => `${+(n * 100).toFixed(4)}%`;

/**
 * The card image's placement inside a card-shaped tile so that only `part` shows, upright, as large as
 * fits and centred. The image is scaled, its region's centre put on the tile's centre, turned about
 * that point, and clipped to the region (`clip-path` applies before the turn, in the image's own box).
 */
export function faceCropStyle(part: FacePart): CSSProperties {
  const { x, y, w, h, rotate } = FACE_REGIONS[part];
  // In tile widths: the image is 1 wide and 1/CARD_RATIO tall at scale 1, as the tile is.
  const regionW = w;
  const regionH = h / CARD_RATIO;
  const [uprightW, uprightH] = rotate === 0 ? [regionW, regionH] : [regionH, regionW];
  const scale = Math.min(1 / uprightW, 1 / CARD_RATIO / uprightH);
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

/**
 * The card image's placement inside a box of ARBITRARY shape — unlike
 * {@link faceCropStyle}'s card-shaped tile — so `region` fills the box's own
 * width edge to edge and is vertically centred, cropped top and bottom by
 * the box's own `overflow: hidden` rather than a `clip-path` (there is no
 * single container aspect ratio to clip to here, the way a card-shaped tile
 * has). Built for {@link ILLUSTRATION_BOX} on a cube's gallery tile — a
 * short, wide box an upright card image is never going to match exactly —
 * but takes any upright (`rotate: 0`) region.
 *
 * `containerRatio` is the box's own width ÷ height (`CubeArt.css`'s
 * `aspect-ratio`), needed because CSS resolves `top`/`height` percentages
 * against the PARENT's height and `left`/`width` against its width: with a
 * card-shaped tile those are the same ratio and one `scale` serves both
 * (`faceCropStyle`'s own trick); here they are not, so the two axes are
 * computed separately.
 */
export function coverCropStyle(region: FaceRegion, containerRatio: number): CSSProperties {
  const { x, y, w, h } = region;
  const widthScale = 1 / w; // the image's rendered width, as a fraction of the box's own width
  const heightScale = containerRatio / (w * CARD_RATIO); // the image's rendered height, as a fraction of the box's own height
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    position: 'absolute',
    width: pct(widthScale),
    height: pct(heightScale),
    left: pct(0.5 - cx * widthScale),
    top: pct(0.5 - cy * heightScale),
  };
}
