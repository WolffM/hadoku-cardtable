// @vitest-environment jsdom
/*
 * `landCastGhost`: the one trip a card makes to its place, on either screen —
 * and the trip it does not make when it is already there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CAST_LANDING_ATTR, CAST_LIFT_ATTR, landCastGhost } from './cast.ts';
import { GLIDE_MS } from '../../motion.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function arrivedAt(x: number, y: number): HTMLElement {
  const board = document.createElement('div');
  board.className = 'board';
  const li = document.createElement('li');
  li.getBoundingClientRect = () => ({ left: x - 30, top: y - 42, width: 60, height: 84, right: x + 30, bottom: y + 42, x: x - 30, y: y - 42, toJSON: () => null }) as DOMRect;
  board.append(li);
  document.body.append(board);
  return li;
}

describe('landCastGhost', () => {
  it('a stand-in already where the card is drawn swaps in place: no flight, the card shown at once', () => {
    const arrived = arrivedAt(400, 300);
    arrived.setAttribute(CAST_LANDING_ATTR, '');
    const ghost = document.createElement('div');
    document.body.append(ghost);
    landCastGhost(document, 7, ghost, { x: 401, y: 302 }, arrived);
    expect(ghost.isConnected, 'the stand-in is gone').toBe(false);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR), 'the card is not hidden').toBe(false);
  });

  it('a stand-in at rest in the gap its card took, a few px off the card, swaps in place too (w67-shaman’s bears: a 300 ms flight of 4–5 px)', () => {
    const arrived = arrivedAt(454, 280);
    const ghost = document.createElement('div');
    document.body.append(ghost);
    landCastGhost(document, 7, ghost, { x: 450, y: 283 }, arrived);
    expect(ghost.isConnected, 'no flight').toBe(false);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR), 'the card is shown at once').toBe(false);
  });

  it('from anywhere else it travels, the card hidden until it lands — a card of no id (their hidden hand) included', () => {
    vi.useFakeTimers();
    const arrived = arrivedAt(400, 60);
    const ghost = document.createElement('div');
    landCastGhost(document, null, ghost, { x: 500, y: 400 }, arrived);
    expect(ghost.getAttribute(CAST_LIFT_ATTR)).toBe('returning');
    expect([ghost.style.left, ghost.style.top]).toEqual(['400px', '60px']);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR)).toBe(true);
    vi.advanceTimersByTime(GLIDE_MS);
    expect(ghost.isConnected).toBe(false);
    expect(arrived.hasAttribute(CAST_LANDING_ATTR)).toBe(false);
  });
});
