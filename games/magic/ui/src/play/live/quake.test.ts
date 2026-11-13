// @vitest-environment jsdom
/*
 * The board's quake (`quake.ts`): what a heavy blow does to the table — the shake, cracks in it and the
 * cards around it knocked away — by `entryWeight`, the one curve, whether a creature lands
 * (`entries.ts`) or strikes a player (`numbers.ts`'s charge).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { entryWeight, playLanding } from './entries.ts';
import { QUAKE_ATTR, quake } from './quake.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** Every animation started, on what, and a way to finish them all; nothing finishes until `finish`. */
function stubAnimate(): { on: Element[]; cancelled: Element[]; finish: () => void } {
  const on: Element[] = [];
  const cancelled: Element[] = [];
  const waiting: (() => void)[] = [];
  HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement) {
    on.push(this);
    let end: () => void = () => undefined;
    const finished = new Promise<void>((done) => (end = done));
    waiting.push(end);
    return { finished, cancel: () => (cancelled.push(this), end()) } as unknown as Animation;
  }) as unknown as typeof HTMLElement.prototype.animate;
  return { on, cancelled, finish: () => waiting.forEach((f) => f()) };
}

/** A board with an avatar over a battlefield of eight cards: two rows of four under it. */
function table(): { board: HTMLElement; overlay: HTMLElement; zone: HTMLElement; cards: HTMLElement[]; face: HTMLElement } {
  const holder = document.createElement('div');
  const board = document.createElement('div');
  board.className = 'board';
  board.getBoundingClientRect = () => rect(0, 0, 1200, 800);
  const overlay = document.createElement('div');
  overlay.getBoundingClientRect = () => rect(0, 0, 1200, 800);
  const face = document.createElement('div');
  face.getBoundingClientRect = () => rect(590, 20, 80, 80);
  const zone = document.createElement('ul');
  zone.setAttribute('data-zone', 'battlefield');
  zone.getBoundingClientRect = () => rect(0, 110, 1200, 300);
  const cards = Array.from({ length: 8 }, (_, i) => {
    const li = document.createElement('li');
    li.setAttribute('data-board-card', String(i));
    li.className = 'board-card';
    li.getBoundingClientRect = () => rect(420 + (i % 4) * 90, 120 + Math.floor(i / 4) * 120, 78, 108);
    zone.append(li);
    return li;
  });
  board.append(overlay, face, zone);
  holder.append(board);
  document.body.append(holder);
  return { board, overlay, zone, cards, face };
}

/** The avatar as a quake's anchor: its centre, a creature card's size. */
const atFace = (face: HTMLElement): { x: number; y: number; w: number; h: number } => {
  const r = face.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: 78, h: 108 };
};

describe('quake', () => {
  it('a blow of 2 moves nothing: no shake, no cracks, nobody knocked', () => {
    const anims = stubAnimate();
    const { board, overlay, face } = table();
    quake(board, overlay, atFace(face), entryWeight(2), 'q2');
    expect(anims.on).toEqual([]);
    expect(document.querySelector(`[${QUAKE_ATTR}]`)).toBeNull();
  });

  it('from 5 the table shakes, and nothing cracks yet', () => {
    const anims = stubAnimate();
    const { board, overlay, face } = table();
    quake(board, overlay, atFace(face), entryWeight(5), 'q5');
    expect(anims.on).toEqual([board]);
    expect(document.querySelector('.board-entry__crackle')).toBeNull();
  });

  it('from 7 it cracks under the blow, marked as the quake it belongs to; from 8 the cards around it are knocked away, never one that is not drawn', () => {
    stubAnimate();
    const { board, overlay, zone, face, cards } = table();
    quake(board, overlay, atFace(face), entryWeight(7), 'q7');
    expect(zone.querySelector('.board-entry__crackle')?.getAttribute(QUAKE_ATTR)).toBe('q7');
    expect(overlay.querySelector('.board-entry--shoved')).toBeNull();

    // A rammer's own card while its copy charges, and a dying card's kept gap: neither is drawn, so neither is copied.
    cards[1]!.setAttribute('data-ramming', '');
    cards[2]!.setAttribute('data-leaving-gap', '9');
    quake(board, overlay, atFace(face), entryWeight(8), 'q8');
    const shoved = [...overlay.querySelectorAll<HTMLElement>(`.board-entry--shoved[${QUAKE_ATTR}="q8"]`)].map((el) => el.dataset.standIn);
    expect(shoved).toContain('3');
    expect(shoved).not.toContain('1');
    expect(shoved).not.toContain('2');
  });

  it('its cancel takes everything it drew off the table', async () => {
    const anims = stubAnimate();
    const { board, overlay, face } = table();
    const q = quake(board, overlay, atFace(face), entryWeight(12), 'q12');
    expect(document.querySelectorAll(`[${QUAKE_ATTR}]`).length).toBeGreaterThan(0);
    q.cancel();
    await q.done;
    expect(anims.cancelled).toContain(board);
    expect(document.querySelectorAll(`[${QUAKE_ATTR}]`)).toHaveLength(0);
  });

  it('a creature’s landing is the same quake', async () => {
    const anims = stubAnimate();
    const { board, overlay, cards } = table();
    const landing = playLanding(board, overlay, cards[5]!, entryWeight(9), 'land');
    // The drop onto the table, then its weight.
    anims.finish();
    await vi.waitFor(() => expect(document.querySelector(`.board-entry__crackle[${QUAKE_ATTR}="land"]`)).not.toBeNull());
    anims.finish();
    await landing;
  });
});
