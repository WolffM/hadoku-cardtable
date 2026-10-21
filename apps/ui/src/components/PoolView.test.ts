// @vitest-environment jsdom
/*
 * The draft's picks (the operator, 2026-10-21): "choose between CMC vs color
 * sorting during drafting"; "allow dragging from picks to sideboard (and
 * retain these choices when deck building starts)"; "grid mode cannot have a
 * scroll bar".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import poolData from '../draft/pool.json';
import type { DraftCard } from '../draft/types.ts';
import type { GroupBy } from '../deck/cardOrder.ts';
import { DeckEditor } from '../deck/DeckEditor.tsx';
import type { DeckStoreClient } from '../deck/deckStore.ts';
import { useDraftBuild } from '../deck/useDraftBuild.ts';
import { PoolView } from './PoolView.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PICKS: DraftCard[] = (poolData as { cards: DraftCard[] }).cards.filter((_, i) => i % 11 === 0).slice(0, 45);

/** A stand-in `DataTransfer`: jsdom has none. */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    get types() {
      return [...data.keys()];
    },
  };
}

function drag(tile: HTMLElement, onto: HTMLElement): void {
  const dt = dataTransfer();
  const source = tile.closest('[draggable="true"]')!;
  fireEvent.dragStart(source, { dataTransfer: dt });
  fireEvent.dragOver(onto, { dataTransfer: dt });
  fireEvent.drop(onto, { dataTransfer: dt });
  fireEvent.dragEnd(source, { dataTransfer: dt });
}

const names = (el: HTMLElement): string[] => within(el).queryAllByTestId('card').map((c) => c.querySelector('.card__name')!.textContent!);

function Picks({ store }: { store: DeckStoreClient | null }) {
  const [groupBy, setGroupBy] = useState<GroupBy>('color');
  const build = useDraftBuild('pod', PICKS, store === null ? null : { podId: 'r-pod', client: store });
  return createElement(PoolView, { cards: PICKS, recentlyAdded: null, groupBy, onGroupBy: setGroupBy, sideboard: build.sideboard, onMove: build.move });
}

describe('the picks: grouped by colour or by mana value', () => {
  it('toggles between colour piles and mana-value piles', () => {
    render(createElement(Picks, { store: null }));
    const buckets = (): string[] => [...document.querySelectorAll('[data-testid^="pool-bucket-"]')].map((b) => b.getAttribute('data-testid')!.slice('pool-bucket-'.length));
    expect(buckets().every((g) => /^[WUBRGMCL]$/.test(g))).toBe(true);
    fireEvent.click(screen.getByTestId('pool-sort-mv'));
    expect(screen.getByTestId('pool').dataset['groupBy']).toBe('mv');
    expect(buckets().every((g) => /^[0-6L]$/.test(g))).toBe(true);
    // Every pile holds only its own mana value, lands apart.
    for (const g of buckets().filter((b) => b !== 'L' && b !== '6')) {
      for (const name of names(screen.getByTestId(`pool-bucket-${g}`))) expect(PICKS.find((c) => c.name === name)!.manaValue).toBe(Number(g));
    }
    fireEvent.click(screen.getByTestId('pool-sort-color'));
    expect(buckets().every((g) => /^[WUBRGMCL]$/.test(g))).toBe(true);
  });
});

describe('the picks: the deck in progress and its sideboard', () => {
  it('drags a pick to the sideboard and back, and only from the other side', () => {
    render(createElement(Picks, { store: null }));
    const side = screen.getByTestId('pool-sideboard');
    expect(names(side)).toEqual([]);
    const first = within(screen.getByTestId('pool-main')).getAllByTestId('card')[0]!;
    const name = first.querySelector('.card__name')!.textContent!;
    drag(first, side);
    expect(names(screen.getByTestId('pool-side'))).toEqual([name]);
    expect(names(screen.getByTestId('pool-main'))).not.toContain(name);
    // Dropped back on its own side: nothing moves.
    drag(within(screen.getByTestId('pool-side')).getByTestId('card'), screen.getByTestId('pool-sideboard'));
    expect(names(screen.getByTestId('pool-side'))).toEqual([name]);
    drag(within(screen.getByTestId('pool-side')).getByTestId('card'), screen.getByTestId('pool-main'));
    expect(names(screen.getByTestId('pool-side'))).toEqual([]);
  });

  it('keeps the sideboard when deck building starts: the builder opens on the same saved build', async () => {
    let saved: string | null = null;
    const store: DeckStoreClient = {
      mine: vi.fn(async () => ({ pool: PICKS, deck: saved })),
      save: vi.fn(async (_pod: string, dck: string) => {
        saved = dck;
        return { ok: true as const, deck: dck };
      }),
    };
    render(createElement(Picks, { store }));
    await act(async () => undefined);
    const card = within(screen.getByTestId('pool-main')).getAllByTestId('card')[3]!;
    const name = card.querySelector('.card__name')!.textContent!;
    drag(card, screen.getByTestId('pool-sideboard'));
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    expect((store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('r-pod');
    cleanup();

    // The draft ends: the builder opens on what `GET …/mine` holds.
    render(createElement(DeckEditor, { mode: 'limited', draftId: 'r-pod', pool: PICKS, savedDeck: saved }));
    expect(names(screen.getByTestId('side-grid'))).toEqual([name]);
    expect(screen.getByTestId('main-count').textContent).toBe(String(PICKS.length - 1));
  });

  // The operator, 2026-10-21: "i am not able to drag cards back out of the side-board in drafting view".
  it('drags a sideboarded pick back out anywhere off the sideboard: it leaves the sideboard and the save stops naming it', async () => {
    let saved: string | null = null;
    const store: DeckStoreClient = {
      mine: vi.fn(async () => ({ pool: PICKS, deck: saved })),
      save: vi.fn(async (_pod: string, dck: string) => {
        saved = dck;
        return { ok: true as const, deck: dck };
      }),
    };
    render(createElement(Picks, { store }));
    await act(async () => undefined);
    const card = within(screen.getByTestId('pool-main')).getAllByTestId('card')[2]!;
    const name = card.querySelector('.card__name')!.textContent!;
    drag(card, screen.getByTestId('pool-sideboard'));
    await waitFor(() => expect(saved).toContain(name));

    // Out of the sideboard onto the picks' open row, beside the piles; then out onto the pool's heading.
    drag(within(screen.getByTestId('pool-side')).getByTestId('card'), document.querySelector<HTMLElement>('.pool__curve')!);
    expect(names(screen.getByTestId('pool-side'))).toEqual([]);
    expect(names(screen.getByTestId('pool-main'))).toContain(name);
    await waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));
    expect(saved).not.toContain(name);

    drag(within(screen.getByTestId('pool-main')).getAllByTestId('card')[0]!, screen.getByTestId('pool-sideboard'));
    drag(within(screen.getByTestId('pool-side')).getByTestId('card'), screen.getByTestId('pool-count'));
    expect(names(screen.getByTestId('pool-side'))).toEqual([]);

    // A pick dropped off the picks, beside the sideboard, still goes to the sideboard: the move is the same both ways.
    drag(within(screen.getByTestId('pool-main')).getAllByTestId('card')[0]!, document.querySelector<HTMLElement>('.pool__curve')!);
    expect(names(screen.getByTestId('pool-side'))).toHaveLength(1);
  });

  it('a watcher’s view of someone else’s picks drags nothing', () => {
    render(createElement(PoolView, { cards: PICKS, recentlyAdded: null, owner: 'bob' }));
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(screen.queryByTestId('pool-sideboard')).toBeNull();
  });
});

describe('the picks fit their box', () => {
  it('sizes the cards from the measured box, so a full pool needs no scroll', () => {
    // The picks' half at 1280×800: about 990 × 250.
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
    // The picks' box, and a pile heading's own line.
    const rect = (width: number, height: number) => ({ width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('pool__bucket-title') ? rect(80, 14) : rect(990, 250);
    });
    render(createElement(Picks, { store: null }));
    const curve = document.querySelector<HTMLElement>('.pool__curve')!;
    const w = parseFloat(curve.style.getPropertyValue('--pool-w'));
    expect(w).toBeGreaterThan(60);
    expect(w).toBeLessThan(140);
    // A pile too tall for the box is split into columns.
    const cols = [...document.querySelectorAll('.pool__bucket-cols')].map((c) => c.children.length);
    const columns = cols.reduce((a, b) => a + b, 0);
    expect(columns * w + (columns - 1) * 12).toBeLessThanOrEqual(990.5);
  });
});
