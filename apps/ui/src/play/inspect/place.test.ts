/**
 * `placeInspector`, on real numbers — no DOM, no jsdom rect zeroing. Every
 * "never" the panel promises (never over the hand, never outside the board,
 * shrinks before it will cross either) is a claim about this pure function;
 * `index.test.ts` covers the behavioural half (open/dismiss/swallow) and
 * defers the geometry here, as its own header says.
 *
 * Every expected number below was computed once from the function itself
 * (not retyped by hand) and is asserted exactly — this is a characterization
 * of the current, reviewed placement math, not a tolerance check.
 */

import { describe, expect, it } from 'vitest';
import { CARD_TALL, GAP, PREF_W, placeInspector, type Rect } from './index.ts';

const BOARD: Rect = { left: 0, top: 0, right: 1200, bottom: 800 };

describe('placeInspector', () => {
  it('sits to the right of the hovered card, at preferred width, when there is room', () => {
    const hover: Rect = { left: 100, top: 100, right: 150, bottom: 150 };
    expect(placeInspector(hover, BOARD, null)).toEqual({ left: 158, top: 100, width: 264 });
  });

  it('flips to the left of the card when the right side has no room', () => {
    const hover: Rect = { left: 1000, top: 100, right: 1050, bottom: 150 };
    const spot = placeInspector(hover, BOARD, null);
    expect(spot.left).toBe(728);
    expect(spot.left + spot.width).toBeLessThanOrEqual(hover.left - GAP);
  });

  it('clamps inside a narrow board when neither side has room, rather than crossing an edge', () => {
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
    expect(spot.width).toBe(PREF_W);
  });

  it('shrinks to stay above the hand rather than ever covering it', () => {
    const tightHand: Rect = { left: 0, top: 50, right: 1200, bottom: 800 };
    const hover: Rect = { left: 100, top: 20, right: 150, bottom: 40 };
    const spot = placeInspector(hover, BOARD, tightHand);
    expect(spot).toEqual({ left: 158, top: 8, width: 24.4 });
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
});
