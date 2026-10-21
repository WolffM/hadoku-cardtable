// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

import { cardImageUrl } from '../draft/cardImage.ts';
import { relatedCards } from '../draft/related.ts';
import pool from '../draft/pool.json' with { type: 'json' };
import { fanGeometry, relatedPlace } from './PackView.tsx';
import { RelatedRow } from './RelatedRow.tsx';

const loads: { src: string; settle: (ok: boolean) => void }[] = [];
class FakeImage {
  src = '';
  decode(): Promise<void> {
    return new Promise((resolve, reject) => loads.push({ src: this.src, settle: (ok) => (ok ? resolve() : reject(new Error('404'))) }));
  }
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  loads.length = 0;
});

/**
 * A screen as `PodScreen` draws one: the pack, and the screen's top layer beside
 * it (`[data-board-zoom]`, the layer the inspector draws into). The pack sits at
 * (100, 50) in a layer that starts at (10, 5).
 */
function screenWithLayer(): { pack: HTMLElement; layer: HTMLElement } {
  const root = document.createElement('div');
  const pack = document.createElement('div');
  pack.className = 'pack pack--fan';
  const layer = document.createElement('div');
  layer.setAttribute('data-board-zoom', '');
  root.append(pack, layer);
  document.body.append(root);
  pack.getBoundingClientRect = () => new DOMRect(100, 50, 900, 400);
  layer.getBoundingClientRect = () => new DOMRect(10, 5, 1270, 795);
  return { pack, layer };
}

const AT = { left: 20, top: 300, width: 120 };

const named = (name: string): string => (pool as { cards: { name: string; scryfallId: string }[] }).cards.find((c) => c.name.startsWith(name))!.scryfallId;

describe('a cube card’s related cards', () => {
  it('names a transform card’s back face, a token maker’s tokens, and a meld card’s result', () => {
    expect(relatedCards(named('Jace, Vryn')).map((r) => [r.name, r.kind])).toEqual([['Jace, Telepath Unbound', 'back']]);
    expect(relatedCards(named('Magda, Brazen')).map((r) => r.kind)).toContain('token');
    expect(relatedCards(named('The Mightstone')).map((r) => r.name)).toContain('Urza, Planeswalker');
    expect(relatedCards(named('Jace, Vryn'))[0]!.id).toMatch(/#back$/);
    expect(cardImageUrl(relatedCards(named('Jace, Vryn'))[0]!.id)).toMatch(/\/back\//);
    expect(relatedCards('not-a-card')).toEqual([]);
  });
});

describe('the related row', () => {
  it('draws nothing until every image has settled, then all that decoded at once, and leaves out one that failed', async () => {
    vi.stubGlobal('Image', FakeImage);
    const cards = [
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'One', kind: 'token' as const },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', name: 'Two', kind: 'token' as const },
      { id: 'aaaaaaaa-0000-0000-0000-000000000003', name: 'Three', kind: 'token' as const },
    ];
    const { pack } = screenWithLayer();
    render(createElement(RelatedRow, { cards, anchor: pack, place: AT }), { container: pack });
    expect(screen.queryByTestId('pack-related')).toBeNull();
    await act(async () => loads[0]!.settle(true));
    expect(screen.queryByTestId('pack-related'), 'not one at a time').toBeNull();
    await act(async () => {
      loads[1]!.settle(false);
      loads[2]!.settle(true);
    });
    expect([...screen.getByTestId('pack-related').querySelectorAll('img')].map((i) => i.alt)).toEqual(['One', 'Three']);
  });

  it('draws nothing when no image decodes', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { pack } = screenWithLayer();
    render(createElement(RelatedRow, { cards: [{ id: 'aaaaaaaa-0000-0000-0000-000000000009', name: 'Gone', kind: 'token' as const }], anchor: pack, place: AT }), {
      container: pack,
    });
    await act(async () => loads[0]!.settle(false));
    expect(screen.queryByTestId('pack-related')).toBeNull();
  });

  it('starts just under the hovered card and stays inside the pack', () => {
    const fan = fanGeometry(1000, 400);
    const at = (card: number, open: number, n: number) => relatedPlace(fan, card, open, 15, 1000, n);
    expect(at(0, 0, 1).left).toBeCloseTo(1000 / 2 + (-3 * fan.step) - fan.cardW / 2, 0);
    expect(at(1, 0, 1).left).toBeCloseTo(1000 / 2 + (-2 * fan.step) - fan.cardW / 2, 0);
    const w = fan.cardW * 0.8;
    expect(at(0, 0, 1).width).toBeCloseTo(w, 5);
    expect(at(14, 14, 3).left + 3 * w + 2 * 8).toBeLessThanOrEqual(1000.5);
    // The open card's bottom edge is 22 px down, risen 18; a closed card's is not risen.
    expect(at(0, 0, 1).top).toBeCloseTo(22 + fan.cardH - 18 + 6, 0);
    expect(at(1, 0, 1).top).toBeCloseTo(22 + fan.cardH + 6, 0);
  });

  // The operator, 2026-10-21: "when showing the 'related' cards in fan view, they need to render on top
  // of everything else. they currently still render too low below other page elements". Drawn inside the
  // pack, no z-index of the row's can lift it out of the pack's stacking context, and the picks' card art
  // (later in the page, at the same level) painted over it.
  it('draws in the screen’s top layer, not inside the pack, at the place under the hovered card', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { pack, layer } = screenWithLayer();
    const cards = [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'One', kind: 'token' as const }];
    render(createElement(RelatedRow, { cards, anchor: pack, place: AT }), { container: pack });
    await act(async () => loads[0]!.settle(true));
    const row = screen.getByTestId('pack-related');
    expect(row.parentElement, 'in the top layer').toBe(layer);
    expect(pack.contains(row), 'not inside the pack').toBe(false);
    // The pack's place in the layer (90, 45) plus the row's place in the pack.
    expect(row.style.left).toBe('110px');
    expect(row.style.top).toBe('345px');
    expect(row.style.getPropertyValue('--related-w')).toBe('120px');
  });

  it('draws nothing where the screen has no top layer', async () => {
    vi.stubGlobal('Image', FakeImage);
    const pack = document.createElement('div');
    document.body.append(pack);
    render(createElement(RelatedRow, { cards: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'One', kind: 'token' as const }], anchor: pack, place: AT }), {
      container: pack,
    });
    await act(async () => loads[0]?.settle(true));
    expect(screen.queryByTestId('pack-related')).toBeNull();
  });
});
