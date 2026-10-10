// @vitest-environment jsdom
//
// `.test.ts`, not `.test.tsx` as the brief's row names it — the repo's root
// `vitest.config.ts` only globs `apps/*/src/` down to `*.test.ts` (note:
// written with line comments here, never a block comment, because that
// glob's own middle closes a `/* */` early) — no `.tsx` test glob exists
// anywhere in this workspace, so a `.tsx` test file would never be
// collected by `pnpm exec vitest run` or by CI's `check`.
// `prompts/RulesText.test.ts` is `.ts` for the identical reason (plain
// `createElement`, no JSX) despite testing a component. Changing the shared
// root config is outside this lane's row and would move under all four
// lanes mid-wave, so this file follows the existing pattern instead.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

import type { BoardCard, BoardCardRelation } from './adapter.ts';
import { Relations, relationLabel } from './Relations.tsx';

afterEach(cleanup);

/** The minimum `BoardCard` `Relations` reads — every other field is `CardOnBoard`'s business, not this component's. */
function entryWith(relations: BoardCardRelation[]): BoardCard {
  return {
    id: 1,
    card: { cardId: 'w1', name: 'Cry of Contrition', manaCost: ['B'], manaValue: 1, colors: ['B'], typeLine: 'Sorcery', oracleText: '', setCode: '', collectorNumber: '', rarity: 'common' },
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
    relations,
  };
}

const draw = (entry: BoardCard) => render(createElement(Relations, { entry })).container;

describe('relationLabel — the pill’s own text', () => {
  it('names the other card when it resolved', () => {
    expect(relationLabel({ kind: 'hauntedBy', ids: [7], names: ['Cry of Contrition'] })).toBe('Haunted by Cry of Contrition');
    expect(relationLabel({ kind: 'haunting', ids: [9], names: ['Fire Urchin'] })).toBe('Haunting Fire Urchin');
  });

  it('joins more than one resolved name', () => {
    expect(relationLabel({ kind: 'imprinted', ids: [1, 2], names: ['Lightning Bolt', 'Shock'] })).toBe('Imprinted: Lightning Bolt, Shock');
  });

  it('names a card this seat may not see as the adapter resolved it — "Hidden card"', () => {
    expect(relationLabel({ kind: 'hauntedBy', ids: [404], names: ['Hidden card'] })).toBe('Haunted by Hidden card');
    expect(relationLabel({ kind: 'chosen', ids: [1, 2], names: ['Hidden card', 'Memnite'] })).toBe('Chosen: Hidden card, Memnite');
  });
});

describe('Relations — the board card’s pill row', () => {
  it('draws nothing for a card with no relations — the empty array `toBoardCard` always sets', () => {
    const container = draw(entryWith([]));
    expect(container.querySelector('.board-card__relations')).toBeNull();
  });

  it('draws nothing for a hand-typed `BoardCard` that omits the field entirely', () => {
    const entry = entryWith([]);
    delete entry.relations;
    const container = draw(entry);
    expect(container.querySelector('.board-card__relations')).toBeNull();
  });

  it('one pill per relation kind, reusing the board’s own counter pill class', () => {
    const entry = entryWith([
      { kind: 'hauntedBy', ids: [7], names: ['Cry of Contrition'] },
      { kind: 'mustBlock', ids: [9], names: ['Hidden card'] },
    ]);
    const container = draw(entry);
    const pills = [...container.querySelectorAll('.board-card__relations > .board-card__counter')];
    expect(pills.map((p) => p.getAttribute('data-relation'))).toEqual(['hauntedBy', 'mustBlock']);
    expect(pills.map((p) => p.textContent)).toEqual(['Haunted by Cry of Contrition', 'Must block Hidden card']);
  });
});
