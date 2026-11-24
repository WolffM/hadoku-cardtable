// @vitest-environment jsdom
/*
 * The Library's Cards tab: a card's printings in the server's order (oldest first), the oldest, the
 * default and the pick each marked; a pick drawn at once and written; a refused write drawn back.
 * The "Always use oldest art" toggle (`GameSettings.tsx`) rolls back the same way.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';

import type { ArtClient, ArtRules, CardPrinting } from '../deck/artRules.ts';
import { OldestArtToggle } from '../settings/GameSettings.tsx';
import { drawnPrinting, LibraryCards, printingStrip } from './LibraryCards.tsx';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The page's own lookups: Lightning Bolt's default art (`GET /api/cards/art`) is M10, and every art's artist is known.
vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes('/cards/art?') ? { art: { 'Lightning Bolt': { scryfallId: 'm10' } } } : { artist: 'Someone' };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
});

const printing = (scryfallId: string, set: string, releasedAt: string | null): CardPrinting => ({ scryfallId, set, collectorNumber: '1', releasedAt, artist: 'Someone' });
/** As the server sends them: oldest first. */
const BOLT = [printing('lea', 'LEA', '1993-08-05'), printing('m10', 'M10', '2009-07-17'), printing('a25', 'A25', '2018-03-16'), printing('sld', 'SLD', null)];

const card = (name: string): DraftCard => ({ cardId: name, name, manaCost: ['R'], manaValue: 1, colors: ['R'], typeLine: 'Instant', oracleText: '', setCode: 'M10', collectorNumber: '1', rarity: 'common' }) as DraftCard;

describe('printingStrip', () => {
  it('keeps the server’s order and marks the first oldest, the default and the pick', () => {
    const strip = printingStrip(BOLT, 'a25', 'm10');
    expect(strip.map((p) => p.set)).toEqual(['LEA', 'M10', 'A25', 'SLD']);
    expect(strip.map((p) => [p.oldest, p.isDefault, p.picked])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [false, false, false],
    ]);
    expect(strip.map((p) => p.year)).toEqual(['1993', '2009', '2018', null]);
  });

  it('draws your pick, else the oldest when that rule is on, else the default', () => {
    expect(drawnPrinting(printingStrip(BOLT, 'a25', 'm10'), true, 'm10')).toBe('a25');
    expect(drawnPrinting(printingStrip(BOLT, undefined, 'm10'), true, 'm10')).toBe('lea');
    expect(drawnPrinting(printingStrip(BOLT, undefined, 'm10'), false, 'm10')).toBe('m10');
  });
});

/** A client over `stored` whose PUTs answer `ok` or refuse. */
function artStub(stored: ArtRules, ok: boolean): ArtClient & { puts: ArtRules[] } {
  const puts: ArtRules[] = [];
  return {
    puts,
    getArt: vi.fn(async () => stored),
    putArt: vi.fn(async (rules: ArtRules) => {
      puts.push(rules);
      return ok ? { ok: true as const, rules } : { ok: false as const, message: 'refused' };
    }),
    printings: vi.fn(async () => BOLT),
  };
}

async function openBolt(art: ArtClient): Promise<HTMLElement[]> {
  render(createElement(LibraryCards, { art, search: async () => [card('Lightning Bolt')] }));
  fireEvent.change(screen.getByTestId('library-cards-search'), { target: { value: 'bolt' } });
  const result = await screen.findByTestId('library-card', {}, { timeout: 2_000 });
  fireEvent.click(result.querySelector('button')!);
  return waitFor(() => {
    const strip = screen.getAllByTestId('library-printing');
    expect(strip).toHaveLength(BOLT.length);
    return strip;
  });
}

describe('LibraryCards', () => {
  it('draws the printings in the server’s order, and a pick pressed once the server keeps it', async () => {
    const art = artStub({ oldest: false, picks: {} }, true);
    const strip = await openBolt(art);
    expect(strip.map((el) => el.getAttribute('data-scryfall-id'))).toEqual(['lea', 'm10', 'a25', 'sld']);
    expect(strip.map((el) => el.hasAttribute('data-oldest'))).toEqual([true, false, false, false]);
    await waitFor(() => expect(screen.getAllByTestId('library-printing').map((el) => el.hasAttribute('data-default'))).toEqual([false, true, false, false]));
    fireEvent.click(strip[2]!);
    await waitFor(() => expect(screen.getAllByTestId('library-printing')[2]!.getAttribute('aria-pressed')).toBe('true'));
    expect(art.puts).toEqual([{ oldest: false, picks: { 'lightning bolt': 'a25' } }]);
    expect(screen.getByTestId('library-card-picked')).toBeTruthy();
  });

  it('draws the pick it held again when the server refuses the change', async () => {
    const art = artStub({ oldest: false, picks: { 'lightning bolt': 'm10' } }, false);
    const strip = await openBolt(art);
    await waitFor(() => expect(strip[1]!.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(strip[3]!);
    expect(screen.getAllByTestId('library-printing')[3]!.getAttribute('aria-pressed'), 'drawn at once').toBe('true');
    await screen.findByTestId('library-cards-error');
    const after = screen.getAllByTestId('library-printing');
    expect(after.map((el) => el.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false']);
  });
});

describe('OldestArtToggle', () => {
  it('shows the stored rule, and draws it back when the server refuses a change', async () => {
    const art = artStub({ oldest: true, picks: {} }, false);
    render(createElement(OldestArtToggle, { client: art }));
    const toggle = screen.getByTestId<HTMLInputElement>('settings-art-oldest');
    await waitFor(() => expect(toggle.checked).toBe(true));
    fireEvent.click(toggle);
    await waitFor(() => expect(art.puts).toEqual([{ oldest: false, picks: {} }]));
    await waitFor(() => expect(toggle.checked).toBe(true));
  });
});
