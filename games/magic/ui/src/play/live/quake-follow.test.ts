// @vitest-environment jsdom
/*
 * Entry stand-ins in flight at once (a wipe undone, a mass reanimation): each frame, every stand-in reads
 * its row card before any stand-in is moved — one layout a frame, not one per card (cut 3's capture).
 * Its own file: `../frame-phases.ts` keeps one frame loop per page, and this test steps it by hand.
 */
import { describe, expect, it, vi } from 'vitest';

import { standIn } from './quake.ts';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function table(): { overlay: HTMLElement; cards: HTMLElement[] } {
  const board = document.createElement('div');
  board.className = 'board';
  const overlay = document.createElement('div');
  overlay.getBoundingClientRect = () => rect(0, 0, 1200, 800);
  const zone = document.createElement('ul');
  zone.setAttribute('data-zone', 'battlefield');
  const cards = Array.from({ length: 3 }, (_, i) => {
    const li = document.createElement('li');
    li.setAttribute('data-board-card', String(i));
    li.className = 'board-card';
    zone.append(li);
    return li;
  });
  board.append(overlay, zone);
  document.body.append(board);
  return { overlay, cards };
}

describe('standIn: following its row card', () => {
  it('every stand-in reads its card before any stand-in is moved, each frame', () => {
    let queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
    const { overlay, cards } = table();
    let frame = 0;
    const wraps: HTMLElement[] = [];
    const lefts: string[][] = [];
    for (const [i, card] of cards.slice(0, 3).entries()) {
      card.getBoundingClientRect = () => {
        lefts.push(wraps.map((w) => w.style.left));
        return rect(100 * i + frame * 10, 120, 78, 108);
      };
      const s = standIn(overlay, card, 'board-entry');
      s.mount();
      wraps.push(s.wrap);
    }
    for (frame = 1; frame <= 2; frame++) {
      const before = wraps.map((w) => w.style.left);
      lefts.length = 0;
      const run = queue;
      queue = [];
      for (const cb of run) cb(performance.now());
      expect(lefts, `frame ${frame}: each card read once`).toHaveLength(3);
      for (const seen of lefts) expect(seen, `frame ${frame}: nothing moved before every card was read`).toEqual(before);
      expect(wraps.map((w) => w.style.left), `frame ${frame}: each moved`).not.toEqual(before);
    }
    vi.unstubAllGlobals();
  });
});
