// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

import { cardImageUrl } from '../draft/cardImage.ts';
import { relatedCards, type RelatedCard } from '../draft/related.ts';
import type { CardFace, DraftCard } from '../draft/types.ts';
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

/** A related token with art, as `relatedCards` hands one over. */
const token = (id: string, name: string): RelatedCard => ({
  id,
  name,
  kind: 'token',
  face: { scryfallId: id, name, manaCost: [], manaValue: 0, colors: [], typeLine: 'Token', oracleText: '', setCode: '', collectorNumber: '', rarity: 'common' },
});

const named = (name: string): DraftCard => (pool as unknown as { cards: DraftCard[] }).cards.find((c) => c.name.startsWith(name))!;
/** A face as a card carries it: only its art id and name matter here. */
const face = (scryfallId: string, name: string): CardFace => ({ ...named('Jace, Vryn'), scryfallId, name });

describe('a card’s related cards', () => {
  it('names a transform card’s back face, a token maker’s tokens, and a meld card’s result', () => {
    expect(relatedCards(named('Jace, Vryn')).map((r) => [r.name, r.kind])).toEqual([
      ['Jace, Telepath Unbound', 'back'],
      ['Jace, Telepath Unbound Emblem', 'token'],
    ]);
    expect(relatedCards(named('Magda, Brazen')).map((r) => r.kind)).toContain('token');
    expect(relatedCards(named('The Mightstone')).map((r) => r.name)).toContain('Urza, Planeswalker');
    expect(relatedCards(named('Jace, Vryn'))[0]!.id).toMatch(/#back$/);
    expect(cardImageUrl(relatedCards(named('Jace, Vryn'))[0]!.id)).toMatch(/\/back\//);
    expect(relatedCards({ name: 'Not a Card' })).toEqual([]);
  });

  // The operator, 2026-10-22: "hovering over cards with transforms no longer shows the related state".
  // The table was built off one cube, so a card any other cube or set deals showed nothing.
  it('for a card no cube fixture holds: its own back face, and its tokens by name', () => {
    const delver = { name: 'Delver of Secrets // Insectile Aberration', faces: [face('11bf83bb-c95b-4b4f-9a56-ce7a1816307a#back', 'Insectile Aberration')] };
    expect(relatedCards(delver).map((r) => [r.name, r.kind])).toEqual([['Insectile Aberration', 'back']]);
    expect(relatedCards({ name: 'Goldvein Pick' }).map((r) => [r.name, r.kind])).toEqual([['Treasure', 'token']]);
  });

  // The operator, 2026-10-22, hovering Jungle Patrol: "i should see a 0/1 green wood wall token?" Scryfall
  // prints no Wood and lists none; Forge's script makes it, so its words come from there.
  it('names a token from Forge’s own script, with its words where nothing prints it', () => {
    const [wood] = relatedCards({ name: 'Jungle Patrol' });
    expect(wood?.id).toBeUndefined();
    expect(wood?.face).toMatchObject({ name: 'Wood', typeLine: 'Token Creature — Wall', power: '0', toughness: '1', colors: ['G'], oracleText: 'Defender' });
  });

  it('leaves out a split card’s halves, which share the card’s own image', () => {
    const fire = { name: 'Fire // Ice', faces: [face(named('Jace, Vryn').scryfallId!, 'Ice')] };
    expect(relatedCards(fire)).toEqual([]);
  });
});

describe('the related row', () => {
  it('draws nothing until every image has settled, then all that decoded at once, and leaves out one that failed', async () => {
    vi.stubGlobal('Image', FakeImage);
    const cards = [
      token('aaaaaaaa-0000-0000-0000-000000000001', 'One'),
      token('aaaaaaaa-0000-0000-0000-000000000002', 'Two'),
      token('aaaaaaaa-0000-0000-0000-000000000003', 'Three'),
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

  it('draws a token with no art as its text tile, without waiting on an image', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { pack, layer } = screenWithLayer();
    const wood = relatedCards({ name: 'Jungle Patrol' });
    await act(async () => {
      render(createElement(RelatedRow, { cards: wood, anchor: pack, place: AT }), { container: pack });
    });
    expect(loads).toHaveLength(0);
    const row = layer.querySelector('[data-testid="pack-related"]');
    expect(row?.querySelector('.card__name')?.textContent).toBe('Wood');
  });

  it('draws nothing when no image decodes', async () => {
    vi.stubGlobal('Image', FakeImage);
    const { pack } = screenWithLayer();
    render(createElement(RelatedRow, { cards: [token('aaaaaaaa-0000-0000-0000-000000000009', 'Gone')], anchor: pack, place: AT }), {
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
    const cards = [token('aaaaaaaa-0000-0000-0000-000000000001', 'One')];
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
    render(createElement(RelatedRow, { cards: [token('aaaaaaaa-0000-0000-0000-000000000001', 'One')], anchor: pack, place: AT }), {
      container: pack,
    });
    await act(async () => loads[0]?.settle(true));
    expect(screen.queryByTestId('pack-related')).toBeNull();
  });
});
