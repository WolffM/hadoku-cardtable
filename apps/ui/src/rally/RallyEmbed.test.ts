// @vitest-environment jsdom
/*
 * The Rally view pages: what they draw from the server's answer, the height they tell the
 * framing page, and the box each pack layout is given (`packBox`, checked against the fit
 * `PackView` itself runs, so the two cannot drift apart).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { DraftCard, RallyCardsView, RallyPackView } from '@hadoku/shared';

import { CARD_RATIO, fitGrid } from '../components/cardFit.ts';
import { MAX_CARD_H, fanGeometry } from '../components/PackView.tsx';
import { RallyEmbed, packBox } from './RallyEmbed.tsx';

function card(name: string, colors: DraftCard['colors'] = []): DraftCard {
  return { cardId: name, name, manaCost: [], manaValue: 1, colors, typeLine: 'Creature', oracleText: '', setCode: 'TST', collectorNumber: '1', rarity: 'common' };
}
const pack = (tag: string): DraftCard[] => Array.from({ length: 15 }, (_, i) => card(`${tag} ${i}`));

let answers: unknown[] = [];
const fetchMock = vi.fn(async () => ({ status: 200, json: async () => answers.shift() }) as unknown as Response);

beforeEach(() => {
  answers = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: () => void) {}
      observe(): void {
        this.cb();
      }
      disconnect(): void {}
    },
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 360, height: 640, left: 0, top: 0, right: 360, bottom: 640, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => act(async () => undefined);

describe('packBox', () => {
  it('gives the grid exactly the rows a pack needs at its width, from a phone to a desktop column', () => {
    for (const width of [330, 420, 560, 720]) {
      const height = packBox('grid', width, 15);
      const fit = fitGrid(15, { width, height }, 10, MAX_CARD_H * CARD_RATIO);
      expect(fit.cols * Math.ceil(15 / fit.cols), `${width}px`).toBeGreaterThanOrEqual(15);
      // Never spilling, and not shrunk: `fitGrid` floors a card's width to a tenth of a pixel, so the grid is that much under the box.
      expect(fit.height, `${width}px`).toBeLessThanOrEqual(height);
      expect(height - fit.height, `${width}px`).toBeLessThan(3);
      expect(fit.cols, `${width}px`).toBe(width < 420 ? 3 : width < 600 ? 4 : 5);
    }
  });

  it("gives the fan its tallest card at the frame's width", () => {
    const height = packBox('fan', 720, 15);
    const fan = fanGeometry(720, height);
    // Seven places across, each at least the fan's narrowest share: the whole row fits.
    expect(fan.cardW + 6 * fan.step).toBeLessThanOrEqual(720 + 0.5);
    expect(fan.cardH).toBeGreaterThan(300);
  });

  it('a frame too narrow for a fan sizes the grid instead', () => {
    expect(packBox('fan', 400, 15)).toBe(packBox('grid', 400, 15));
  });
});

describe('RallyEmbed', () => {
  it("tells the framing page its height, at this page's origin", async () => {
    const parent = { postMessage: vi.fn() };
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
    const view: RallyPackView = { name: 'The Pauper Cube', packs: [{ label: null, cards: pack('A') }] };
    answers.push({ success: true, data: view });
    render(createElement(RallyEmbed, { catalogue: 'cube', id: 'the-pauper-cube-2026-02', view: 'pack' }));
    await settle();
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'hadoku-embed:size', height: 640 }, location.origin);
  });

  it('draws the pack read-only, and New pack deals another', async () => {
    answers.push({ success: true, data: { name: 'Cube', packs: [{ label: null, cards: pack('A') }] } satisfies RallyPackView });
    answers.push({ success: true, data: { name: 'Cube', packs: [{ label: null, cards: pack('B') }] } satisfies RallyPackView });
    render(createElement(RallyEmbed, { catalogue: 'cube', id: 'c', view: 'pack' }));
    await settle();
    expect(screen.getByTestId('pack').getAttribute('data-card-count')).toBe('15');
    expect(screen.getByText('A 0')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Pack layout' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('rally-redraw'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toMatch(/api\/rally\/views\/cube\/c\/pack$/);
    expect(screen.getByText('B 0')).toBeTruthy();
    expect(screen.queryByText('A 0')).toBeNull();
  });

  it('labels each round of a mixed preset, and groups every card by colour', async () => {
    const view: RallyCardsView = {
      name: 'Alara block',
      groups: [
        { label: 'Rounds 1 and 2 · Shards of Alara', cards: [card('Rhox War Monk', ['G', 'W', 'U']), card('Akrasan Squire', ['W'])] },
        { label: 'Round 3 · Alara Reborn', cards: [card('Bloodbraid Elf', ['R', 'G'])] },
      ],
    };
    answers.push({ success: true, data: view });
    render(createElement(RallyEmbed, { catalogue: 'draft-preset', id: 'p', view: 'cards' }));
    await settle();
    expect(screen.getByText('Alara block')).toBeTruthy();
    expect(screen.getByText('Rounds 1 and 2 · Shards of Alara')).toBeTruthy();
    expect(screen.getByText('Round 3 · Alara Reborn')).toBeTruthy();
    expect(screen.getAllByTestId('card')).toHaveLength(3);
    // Every tile carries its own inspector id, numbered across the whole page.
    expect([...document.querySelectorAll('.rally-embed__tile')].map((el) => el.getAttribute('data-card-id'))).toEqual(['w0', 'w1', 'w2']);
  });

  it("says the server's sentence when the option is gone", async () => {
    answers.push({ success: false, error: 'This draft preset has been deleted.' });
    render(createElement(RallyEmbed, { catalogue: 'draft-preset', id: 'gone', view: 'cards' }));
    await settle();
    expect(screen.getByText('This draft preset has been deleted.')).toBeTruthy();
  });
});
