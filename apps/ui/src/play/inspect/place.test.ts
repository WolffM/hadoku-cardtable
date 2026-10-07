/**
 * `placeInspector`, on real numbers — no DOM, no jsdom rect zeroing. Every
 * "never" the panel promises (never over the hand, never outside the board,
 * shrinks before it will ever cross either) is a claim about this pure
 * function; `index.test.ts` covers the behavioural half (open/dismiss/swallow)
 * and defers the geometry here, as its own header says.
 *
 * Every expected number below was computed once from the function itself
 * (not retyped by hand) and is asserted exactly — this is a characterization
 * of the current, reviewed placement math, not a tolerance check.
 *
 * The panel anchors on the hovered card's RIGHT, always — `left = hover.right
 * + GAP` — never the left. The only horizontal clamp is the board's own right
 * edge, shifting the panel left exactly as far as it must, never flipping
 * sides.
 *
 * A hand card is the one exception, on both axes: its bottom-left corner sits
 * exactly on the card's own top-left corner, with no `GAP` between them —
 * `left = hover.left`, `top = hover.top - height`.
 */

import { describe, expect, it } from 'vitest';
import { CARD_TALL, GAP, PREF_W, placeBesideModal, placeInspector, type Rect } from './index.ts';

const BOARD: Rect = { left: 0, top: 0, right: 1200, bottom: 800 };

describe('placeInspector', () => {
  it('opens to the right of the hovered card, a GAP clear of it, when there is room', () => {
    const hover: Rect = { left: 600, top: 240, right: 650, bottom: 310 };
    const spot = placeInspector(hover, BOARD, null);
    expect(spot).toEqual({ left: 658, top: 240, width: 264 });
    expect(spot.left).toBe(hover.right + GAP);
    expect(spot.top, 'top edges line up').toBe(hover.top);
  });

  it('with no room on the right, it stands on the card’s LEFT — never over the card it enlarges', () => {
    // The stack redesign (2026-10-06): a thumbnail in the stack's column, near
    // the board's right edge, was covered by its own enlargement when the panel
    // only shifted left as little as needed.
    const hover: Rect = { left: 1000, top: 100, right: 1050, bottom: 150 };
    const spot = placeInspector(hover, BOARD, null);
    expect(spot).toEqual({ left: 728, top: 100, width: 264 });
    expect(spot.left + spot.width, 'a GAP clear of the card').toBe(hover.left - GAP);
  });

  it('clamps inside a board too narrow for either side — shifted left as little as needed, over the card', () => {
    const narrow: Rect = { left: 0, top: 0, right: 300, bottom: 800 };
    const hover: Rect = { left: 250, top: 100, right: 290, bottom: 150 };
    const spot = placeInspector(hover, narrow, null);
    expect(spot.left).toBe(28);
    expect(spot.left).toBeGreaterThanOrEqual(narrow.left + GAP);
    expect(spot.left + spot.width).toBeLessThanOrEqual(narrow.right - GAP);
  });

  it('falls back to the board bottom as the floor when there is no hand zone to read', () => {
    const hover: Rect = { left: 100, top: 100, right: 150, bottom: 150 };
    const spot = placeInspector(hover, BOARD, null);
    // With no hand, nothing shrinks the panel below its preferred size.
    expect(spot).toEqual({ left: 158, top: 100, width: PREF_W });
  });

  it('shrinks to stay above the hand rather than ever covering it', () => {
    const tightHand: Rect = { left: 0, top: 50, right: 1200, bottom: 800 };
    const hover: Rect = { left: 100, top: 20, right: 150, bottom: 40 };
    const spot = placeInspector(hover, BOARD, tightHand);
    expect(spot.width).toBe(24.4);
    expect(spot.top).toBe(8);
    expect(spot.left).toBe(hover.right + GAP);
    expect(spot.width).toBeLessThan(PREF_W);
    // The bottom edge the panel actually draws, in the caller's own math, never reaches the hand.
    expect(spot.top + spot.width * CARD_TALL).toBeLessThanOrEqual(tightHand.top - GAP);
  });

  it('ignores a hand zone that sits below the board — the board floor already governs', () => {
    const farHand: Rect = { left: 0, top: 900, right: 1200, bottom: 1000 };
    const hover: Rect = { left: 100, top: 100, right: 150, bottom: 150 };
    expect(placeInspector(hover, BOARD, farHand)).toEqual(placeInspector(hover, BOARD, null));
  });

  it('clamps the top to the board ceiling when the hovered card is above it', () => {
    const hover: Rect = { left: 100, top: -50, right: 150, bottom: 0 };
    const spot = placeInspector(hover, BOARD, null);
    expect(spot.top).toBe(GAP);
    expect(spot.top).toBeGreaterThanOrEqual(BOARD.top + GAP);
  });

  it('never goes negative when there is no room at all — width floors at zero, not a negative box', () => {
    const shallow: Rect = { left: 0, top: 0, right: 1200, bottom: 16 };
    const hover: Rect = { left: 10, top: 5, right: 20, bottom: 10 };
    const spot = placeInspector(hover, shallow, null);
    expect(spot.width).toBe(0);
    expect(spot.width).toBeGreaterThanOrEqual(0);
  });

  /*
   * A hand card's own `top` sits a few px BELOW the hand zone's registered
   * `top` (the zone's box includes the padding above the row), so
   * `hover.top >= hand.top` is what tells a hand card apart from everything
   * else — an input the rest of this file never exercises, since every other
   * case hovers something well above the hand.
   */
  describe('a hand card — its own corner is the anchor, on both axes', () => {
    const hand: Rect = { left: 0, top: 700, right: 1200, bottom: 800 };

    it('the panel’s bottom-left corner sits exactly on the card’s top-left corner — no GAP', () => {
      const hover: Rect = { left: 100, top: 710, right: 200, bottom: 760 };
      const spot = placeInspector(hover, BOARD, hand);
      expect(spot.width).toBe(PREF_W);
      const height = spot.width * CARD_TALL;
      expect(spot.left).toBe(hover.left);
      expect(spot.top).toBe(hover.top - height);
      // Exact touch: the panel's bottom is the card's own top, to the pixel.
      expect(spot.top + height).toBe(hover.top);
    });

    it('tracks two DIFFERENT hand cards to two different positions — not one fixed slot for the whole row', () => {
      const lowerCard: Rect = { left: 100, top: 710, right: 200, bottom: 760 };
      const higherFannedCard: Rect = { left: 300, top: 740, right: 400, bottom: 790 };
      const spotLower = placeInspector(lowerCard, BOARD, hand);
      const spotHigher = placeInspector(higherFannedCard, BOARD, hand);
      expect(spotLower.left).toBe(lowerCard.left);
      expect(spotHigher.left).toBe(higherFannedCard.left);
      expect(spotHigher.top - spotLower.top).toBeCloseTo(higherFannedCard.top - lowerCard.top, 10);
    });

    it('still clamps at the board’s right edge, shifting left while keeping the corner touch vertically', () => {
      const hover: Rect = { left: 1100, top: 710, right: 1180, bottom: 760 };
      const spot = placeInspector(hover, BOARD, hand);
      const height = spot.width * CARD_TALL;
      // Shifted off `hover.left` because the preferred box would cross the right edge.
      expect(spot.left).toBe(BOARD.right - GAP - spot.width);
      expect(spot.left).toBeLessThan(hover.left);
      // The vertical anchor is untouched by the horizontal clamp.
      expect(spot.top).toBe(hover.top - height);
    });

    it('is unchanged for every ordinary case — the fix only applies when the hovered card is past the hand’s own top', () => {
      const farHand: Rect = { left: 0, top: 500, right: 1200, bottom: 800 };
      const hover: Rect = { left: 100, top: 100, right: 150, bottom: 150 };
      expect(hover.top).toBeLessThan(farHand.top);
      const spot = placeInspector(hover, BOARD, farHand);
      // The general (non-hand) anchor: right of the card, top-aligned.
      expect(spot).toEqual({ left: hover.right + GAP, top: hover.top, width: PREF_W });
    });
  });
});

/*
 * A card inside a pop-up (operator, 2026-10-06: a three-card "put into hand"
 * choice drew its enlargement under the pop-up). The panel stands BESIDE the
 * pop-up — left first — and never on it.
 */
describe('placeBesideModal', () => {
  const AREA: Rect = { left: 0, top: 0, right: 1200, bottom: 800 };
  const overlaps = (spot: { left: number; width: number }, modal: Rect) =>
    spot.left < modal.right && spot.left + spot.width > modal.left;

  it('opens to the LEFT of the pop-up, a GAP clear of it, level with the hovered card', () => {
    const modal: Rect = { left: 500, top: 200, right: 900, bottom: 600 };
    const hover: Rect = { left: 520, top: 260, right: 600, bottom: 370 };
    const spot = placeBesideModal(hover, modal, AREA);
    expect(spot).toEqual({ left: 500 - GAP - PREF_W, top: 260, width: PREF_W });
    expect(overlaps(spot, modal)).toBe(false);
  });

  it('goes to the RIGHT only when the left has no room for it', () => {
    const modal: Rect = { left: 100, top: 200, right: 500, bottom: 600 };
    const hover: Rect = { left: 120, top: 260, right: 200, bottom: 370 };
    const spot = placeBesideModal(hover, modal, AREA);
    expect(spot).toEqual({ left: 500 + GAP, top: 260, width: PREF_W });
    expect(overlaps(spot, modal)).toBe(false);
  });

  it('shrinks onto the roomier side rather than ever covering the pop-up', () => {
    const modal: Rect = { left: 150, top: 200, right: 1000, bottom: 600 };
    const hover: Rect = { left: 900, top: 260, right: 980, bottom: 370 };
    const spot = placeBesideModal(hover, modal, AREA);
    // Left room 150 - 8 - 8 = 134, right room 1200 - 8 - 1008 = 184: the right wins.
    expect(spot.left).toBe(1000 + GAP);
    expect(spot.width).toBe(184);
    expect(overlaps(spot, modal)).toBe(false);
  });

  it('keeps the panel inside the area vertically', () => {
    const modal: Rect = { left: 500, top: 400, right: 900, bottom: 790 };
    const hover: Rect = { left: 520, top: 700, right: 600, bottom: 790 };
    const spot = placeBesideModal(hover, modal, AREA);
    expect(spot.top + spot.width * CARD_TALL).toBeLessThanOrEqual(AREA.bottom - GAP);
  });
});
