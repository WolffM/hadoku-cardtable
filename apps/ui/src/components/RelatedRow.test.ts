// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

import { cardImageUrl } from '../draft/cardImage.ts';
import { relatedCards } from '../draft/related.ts';
import pool from '../draft/pool.json' with { type: 'json' };
import { fanGeometry, relatedStyle } from './PackView.tsx';
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
  vi.unstubAllGlobals();
  loads.length = 0;
});

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
    render(createElement(RelatedRow, { cards, style: {} }));
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
    render(createElement(RelatedRow, { cards: [{ id: 'aaaaaaaa-0000-0000-0000-000000000009', name: 'Gone', kind: 'token' as const }], style: {} }));
    await act(async () => loads[0]!.settle(false));
    expect(screen.queryByTestId('pack-related')).toBeNull();
  });

  it('starts under the open card and stays inside the pack', () => {
    const fan = fanGeometry(1000, 400);
    const left = (open: number, n: number) => parseFloat(String((relatedStyle(fan, open, 15, 1000, n) as Record<string, string>)['--related-left']));
    expect(left(0, 1)).toBeCloseTo(1000 / 2 + (-3 * fan.step) - fan.cardW / 2, 0);
    const w = fan.cardW * 0.8;
    expect(left(14, 3) + 3 * w + 2 * 8).toBeLessThanOrEqual(1000.5);
  });
});
