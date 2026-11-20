// @vitest-environment jsdom
/**
 * The draft screen's controls for a face-up card used at any time, and what a
 * card showed the seat alone, against a real seat payload with the card's
 * fields added as the server sends them (`DraftUse`, `DraftSeen`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DraftSeen, DraftUse } from '@hadoku/shared';

import { loadFixtures } from '../draft/fixtures.ts';
import { initialState } from '../draft/table.ts';
import type { DraftView } from '../draft/types.ts';
import { DraftScreen } from './DraftScreen.tsx';

afterEach(cleanup);

/** A seat's payload with `extra` on its own part; `waiting` takes the pack from in front of it. */
function seatWith(extra: { uses?: DraftUse[]; seen?: DraftSeen[] }, waiting = false): DraftView {
  const view = loadFixtures().find((v) => v.viewer.kind === 'seat' && v.draftId === 'draft:fx-open');
  if (view === undefined || view.viewer.kind !== 'seat') throw new Error('expected a seat fixture');
  const { seatId } = view.viewer;
  return { ...view, waitingOn: waiting ? view.waitingOn.filter((s) => s !== seatId) : view.waitingOn, viewer: { ...view.viewer, ...extra } };
}

function mount(view: DraftView) {
  const onUse = vi.fn();
  render(createElement(DraftScreen, { state: initialState(view), onChange: () => {}, onUse } as never));
  return onUse;
}

const pressed = (testId: string) => screen.queryAllByTestId(testId).map((el) => `${el.textContent}${el.getAttribute('aria-pressed') === 'true' ? '*' : ''}`);

const NOW: DraftUse = { with: 'c1', name: 'Seer', when: 'now', targets: [{ key: '1', label: 'bob' }, { key: '2', label: 'cara' }] };
const PICK: DraftUse = { with: 'c2', name: 'Taker', when: 'pick' };

describe('a card used at any time', () => {
  it('is offered while the seat waits for a pack, and a card used with a pick is not', () => {
    mount(seatWith({ uses: [NOW, PICK] }, true));
    expect(screen.getAllByTestId('draft-use').map((el) => el.getAttribute('data-card'))).toEqual(['Seer']);
  });

  it('with the pack in front of the seat, both are offered', () => {
    mount(seatWith({ uses: [NOW, PICK] }));
    expect(screen.getAllByTestId('draft-use').map((el) => el.getAttribute('data-card'))).toEqual(['Seer', 'Taker']);
  });

  it('pressed, offers its targets, and a target pressed uses it on that target', () => {
    const onUse = mount(seatWith({ uses: [NOW] }, true));
    expect(screen.queryAllByTestId('draft-use-target')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('draft-use'));
    expect(pressed('draft-use-target')).toEqual(['bob', 'cara']);
    expect(screen.queryAllByTestId('draft-use-group')).toHaveLength(0);
    fireEvent.click(screen.getAllByTestId('draft-use-target')[1]!);
    expect(onUse.mock.calls).toEqual([['c1', '2']]);
    expect(screen.queryAllByTestId('draft-use-target')).toHaveLength(0);
  });
});

describe('targets that name a group', () => {
  const grouped: DraftUse = {
    with: 'c1',
    name: 'Seer',
    when: 'now',
    targets: [
      { key: 'a2', label: 'Pack 2', group: 'alice' },
      { key: 'a3', label: 'Pack 3', group: 'alice' },
      { key: 'b1', label: 'Waiting 1', group: 'bob' },
      { key: 'b2', label: 'Pack 2', group: 'bob' },
    ],
  };

  it('are chosen in two steps: the groups, then the chosen group\'s targets', () => {
    const onUse = mount(seatWith({ uses: [grouped] }));
    fireEvent.click(screen.getByTestId('draft-use'));
    expect(pressed('draft-use-group')).toEqual(['alice', 'bob']);
    expect(screen.queryAllByTestId('draft-use-target'), 'no target before a group is chosen').toHaveLength(0);

    fireEvent.click(screen.getAllByTestId('draft-use-group')[1]!);
    expect(pressed('draft-use-group'), 'the chosen group alone, pressed').toEqual(['bob*']);
    expect(screen.getAllByTestId('draft-use-target').map((el) => `${el.getAttribute('data-key')} ${el.textContent}`)).toEqual(['b1 Waiting 1', 'b2 Pack 2']);

    // Pressed again, the group lets go and the groups are offered again.
    fireEvent.click(screen.getByTestId('draft-use-group'));
    expect(pressed('draft-use-group')).toEqual(['alice', 'bob']);

    fireEvent.click(screen.getAllByTestId('draft-use-group')[0]!);
    fireEvent.click(screen.getAllByTestId('draft-use-target')[1]!);
    expect(onUse.mock.calls).toEqual([['c1', 'a3']]);
    expect(screen.queryAllByTestId('draft-use-group')).toHaveLength(0);
  });
});

describe('what a card showed the seat alone', () => {
  const shown = (n: number, names: string[]): DraftSeen => ({
    n,
    source: 'Seer',
    detail: 'drafted by bob',
    cards: names.map((name, i) => ({ cardId: `s${n}-${i}`, name, manaCost: [], manaValue: 0, colors: [], typeLine: 'Artifact', oracleText: '', setCode: 'TST', collectorNumber: '1', rarity: 'common' })),
  });

  it('is a line an entry, each card its own name', () => {
    mount(seatWith({ seen: [shown(1, ['Elm, the Tall', 'Oak']), shown(2, ['Ash'])] }));
    const lines = Array.from(screen.getByTestId('draft-seen').querySelectorAll('li'));
    expect(lines.map((li) => li.textContent)).toEqual(['Seer: Elm, the Tall, Oak drafted by bob', 'Seer: Ash drafted by bob']);
    expect(Array.from(lines[0]!.querySelectorAll('[data-testid="draft-seen-card"]')).map((el) => el.textContent)).toEqual(['Elm, the Tall', 'Oak']);
  });

  it('is not drawn for a seat shown nothing', () => {
    mount(seatWith({}));
    expect(screen.queryByTestId('draft-seen')).toBeNull();
  });
});
