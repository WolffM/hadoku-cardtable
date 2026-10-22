import { describe, expect, it } from 'vitest';

import { coverCropStyle, FACE_REGIONS, faceCropStyle, ILLUSTRATION_BOX, type FacePart } from './faceCrop.ts';

const ASPECT = 488 / 680;
const num = (v: unknown): number => Number.parseFloat(String(v)) / 100;

/**
 * Where `part` lands in a card-shaped tile 1 wide and 1/ASPECT tall, worked out from the style alone:
 * the region's centre after the turn, and its upright size.
 */
function landed(part: FacePart): { cx: number; cy: number; w: number; h: number } {
  const style = faceCropStyle(part);
  const tileH = 1 / ASPECT;
  const imgW = num(style.width);
  const imgH = num(style.height) * tileH;
  const { x, y, w, h, rotate } = FACE_REGIONS[part];
  // The turn is about the region's own centre (`transformOrigin`), so that centre does not move.
  const [ox, oy] = String(style.transformOrigin).split(' ').map(num) as [number, number];
  expect([ox, oy]).toEqual([expect.closeTo(x + w / 2, 6), expect.closeTo(y + h / 2, 6)]);
  const cx = num(style.left) + ox * imgW;
  const cy = num(style.top) * tileH + oy * imgH;
  const [rw, rh] = [w * imgW, h * imgH];
  return rotate === 0 ? { cx, cy, w: rw, h: rh } : { cx, cy, w: rh, h: rw };
}

describe('a face’s part of its card’s image', () => {
  const parts = Object.keys(FACE_REGIONS) as FacePart[];

  it.each(parts)('%s: centred in the tile, as large as fits, never past its edges', (part) => {
    const { cx, cy, w, h } = landed(part);
    const tileH = 1 / ASPECT;
    expect(cx).toBeCloseTo(0.5, 6);
    expect(cy).toBeCloseTo(tileH / 2, 6);
    expect(w).toBeLessThanOrEqual(1 + 1e-6);
    expect(h).toBeLessThanOrEqual(tileH + 1e-6);
    expect(Math.max(w, h / tileH), 'it fills one side of the tile').toBeCloseTo(1, 6);
  });

  it.each(parts)('%s: clipped to its own region, and turned upright', (part) => {
    const { x, y, w, h, rotate } = FACE_REGIONS[part];
    const style = faceCropStyle(part);
    const inset = /^inset\((.+)\)$/.exec(String(style.clipPath))![1]!.split(' ').map(num);
    const fixed = (v: number): number => +v.toFixed(6) + 0;
    expect(inset.map(fixed)).toEqual([y, 1 - x - w, 1 - y - h, x].map(fixed));
    expect(style.transform).toBe(`rotate(${rotate}deg)`);
  });

  it('reads a split half after a quarter turn clockwise — the left half at the image’s bottom — and an aftermath’s second half the other way', () => {
    expect(FACE_REGIONS['split-left']).toMatchObject({ y: 0.5, rotate: 90 });
    expect(FACE_REGIONS['split-right']).toMatchObject({ y: 0, rotate: 90 });
    expect(FACE_REGIONS['aftermath-top']).toMatchObject({ y: 0, rotate: 0 });
    expect(FACE_REGIONS['aftermath-bottom']).toMatchObject({ rotate: -90 });
    expect(FACE_REGIONS.adventure).toMatchObject({ rotate: 0 });
    // A split half, upright, is nearly card-shaped: it all but fills the tile both ways.
    const { w, h } = landed('split-left');
    expect(Math.min(w, h * ASPECT)).toBeGreaterThan(0.95);
  });
});

describe('coverCropStyle — a region covering a box of any shape (AF305 §B: CubeArt’s illustration box)', () => {
  it('ILLUSTRATION_BOX is the card’s own art, never the whole face — type line and rules box excluded', () => {
    // Well inside the printed card, and well short of the full face: this is
    // what distinguishes "the art" from "the whole uncropped card image".
    expect(ILLUSTRATION_BOX.x).toBeGreaterThan(0);
    expect(ILLUSTRATION_BOX.x + ILLUSTRATION_BOX.w).toBeLessThan(1);
    expect(ILLUSTRATION_BOX.y).toBeGreaterThan(0);
    expect(ILLUSTRATION_BOX.y + ILLUSTRATION_BOX.h).toBeLessThan(0.6); // well above the type line
    expect(ILLUSTRATION_BOX.rotate).toBe(0);
  });

  it('covers the box’s full width, and centres the region on the box — for a short, wide box (a cube tile) and a tall, narrow one alike', () => {
    for (const containerRatio of [2.5, 1, 1 / 2.5]) {
      const style = coverCropStyle(ILLUSTRATION_BOX, containerRatio);
      const widthPct = num(style.width);
      const heightPct = num(style.height);
      const leftPct = num(style.left);
      const topPct = num(style.top);

      // The box's own width is fully covered (the rendered image is at least as wide as the box).
      expect(widthPct).toBeGreaterThanOrEqual(1 - 1e-9);
      // The region's own centre (not the whole image's) lands on the box's centre.
      const { x, y, w, h } = ILLUSTRATION_BOX;
      const [cx, cy] = [x + w / 2, y + h / 2];
      expect(leftPct + cx * widthPct).toBeCloseTo(0.5, 6);
      expect(topPct + cy * heightPct).toBeCloseTo(0.5, 6);
    }
  });

  it('a wider box crops a shorter vertical slice of the region than a taller one does, both centred the same', () => {
    const wide = coverCropStyle(ILLUSTRATION_BOX, 5); // very short and wide
    const tall = coverCropStyle(ILLUSTRATION_BOX, 0.5); // taller than it is wide
    // The fraction of the (scaled) image's own height that is visible inside the box.
    const visible = (style: ReturnType<typeof coverCropStyle>): number => 1 / num(style.height);
    expect(visible(wide)).toBeLessThan(visible(tall));
  });
});
