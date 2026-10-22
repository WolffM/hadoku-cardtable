// @vitest-environment jsdom
/*
 * `PoolPicker` on its own — `DraftLobby.test.ts`'s "the Set/Custom tab" and
 * "presets" describe blocks already exercise it through the room's own
 * state machine; these are the presentational component's own unit tests,
 * direct props in, markup out, no `rooms`/`pools` client involved.
 *
 * `.test.ts`, not `.test.tsx` — the root vitest config globs
 * `apps/*\/src/**\/*.test.ts` (same reasoning as `DraftLobby.test.ts`'s own header).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CubeSummary, DraftPreset, SetSummary } from '@hadoku/shared';

import { PoolPicker, type PoolPickerProps } from './PoolPicker.tsx';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const noop = (): void => undefined;

const cube = (over: Partial<CubeSummary> = {}): CubeSummary => ({
  id: 'c1',
  name: 'A cube',
  size: 100,
  origin: 'shortlist',
  cubeCobraId: null,
  importedBy: null,
  importedAt: null,
  refreshedAt: null,
  verdict: null,
  ...over,
});

const set = (over: Partial<SetSummary> = {}): SetSummary => ({
  code: 'ISD',
  name: 'Innistrad',
  date: '2011-09-30',
  type: 'Expansion',
  cards: 231,
  verdict: null,
  ...over,
});

const preset = (over: Partial<DraftPreset> = {}): DraftPreset => ({
  id: 'p1',
  name: 'A preset',
  plan: { rounds: [{ kind: 'cube', cubeId: 'c1' }, { kind: 'cube', cubeId: 'c1' }, { kind: 'cube', cubeId: 'c1' }] },
  createdBy: 'u-me',
  createdAt: new Date().toISOString(),
  ...over,
});

const baseProps: PoolPickerProps = {
  tab: 'cube',
  onTabChange: noop,
  cubes: [],
  cubesError: null,
  sets: [],
  setsError: null,
  presets: [],
  presetsError: null,
  selected: null,
  customRounds: [null, null, null],
  leader: true,
  busy: false,
  checking: false,
  refusal: null,
  readyCards: null,
  myId: 'u-me',
  onPickCube: noop,
  onPickSet: noop,
  onPickCustomRound: noop,
  onImport: noop,
  onRefresh: noop,
  onDelete: noop,
  onSavePreset: noop,
  onLoadPreset: noop,
  onDeletePreset: noop,
};

describe('the tab row', () => {
  it('draws the three tabs, marks the active one, and a non-leader cannot click any of them', () => {
    render(createElement(PoolPicker, { ...baseProps, tab: 'set', leader: false }));

    for (const id of ['cube', 'set', 'custom']) {
      const btn = screen.getByTestId(`pool-picker-tab-${id}`) as HTMLButtonElement;
      expect(btn.getAttribute('aria-selected'), id).toBe(id === 'set' ? 'true' : 'false');
      expect(btn.disabled, `${id}: a non-leader may not switch tabs`).toBe(true);
    }
  });

  it('the leader can click a tab, which calls back with its id', () => {
    const onTabChange = vi.fn();
    render(createElement(PoolPicker, { ...baseProps, onTabChange }));

    fireEvent.click(screen.getByTestId('pool-picker-tab-set'));
    expect(onTabChange).toHaveBeenCalledWith('set');
  });
});

describe('the Set tab', () => {
  it('searching narrows the list by name or code', () => {
    const isd = set({ code: 'ISD', name: 'Innistrad' });
    const ala = set({ code: 'ALA', name: 'Shards of Alara' });
    render(createElement(PoolPicker, { ...baseProps, tab: 'set', sets: [isd, ala] }));

    expect(screen.getByTestId('pool-picker-sets-ISD')).not.toBeNull();
    expect(screen.getByTestId('pool-picker-sets-ALA')).not.toBeNull();

    fireEvent.change(screen.getByTestId('pool-picker-sets-search'), { target: { value: 'alara' } });
    expect(screen.queryByTestId('pool-picker-sets-ISD'), 'filtered out').toBeNull();
    expect(screen.getByTestId('pool-picker-sets-ALA')).not.toBeNull();
  });

  it('picking a set keeps the current style, and picking a style keeps the current set', () => {
    const onPickSet = vi.fn();
    const isd = set({ code: 'ISD' });
    render(createElement(PoolPicker, { ...baseProps, tab: 'set', sets: [isd], onPickSet }));

    fireEvent.click(screen.getByTestId('pool-picker-sets-ISD'));
    expect(onPickSet).toHaveBeenCalledWith('ISD', 'realistic');

    cleanup();
    render(createElement(PoolPicker, { ...baseProps, tab: 'set', sets: [isd], selected: { kind: 'set', code: 'ISD', style: 'realistic' }, onPickSet }));
    fireEvent.click(screen.getByTestId('pool-picker-style-set-cube'));
    expect(onPickSet).toHaveBeenCalledWith('ISD', 'set-cube');
  });

  it('the style toggle is disabled until a set is chosen', () => {
    render(createElement(PoolPicker, { ...baseProps, tab: 'set', sets: [set()] }));
    expect((screen.getByTestId('pool-picker-style-realistic') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('the Custom tab (AF305 §B: three pack slots, ONE shared picker)', () => {
  it('draws three pack slots, and the active one (round 0, by default) is the only picker mounted', () => {
    render(createElement(PoolPicker, { ...baseProps, tab: 'custom', cubes: [cube()] }));

    for (const round of [0, 1, 2]) expect(screen.getByTestId(`pool-picker-custom-round-${round}`), `slot ${round}`).not.toBeNull();
    // Only round 0's picker is mounted until another slot is chosen.
    expect(screen.getByTestId('pool-picker-custom-round-0-cubes')).not.toBeNull();
    expect(screen.queryByTestId('pool-picker-custom-round-1-cubes')).toBeNull();
    expect(screen.queryByTestId('pool-picker-custom-round-2-cubes')).toBeNull();
  });

  it('clicking a pack slot swaps the active picker to that round — never gated on leadership, since it is only viewing', () => {
    const good = cube({ id: 'good-cube' });
    render(createElement(PoolPicker, { ...baseProps, tab: 'custom', leader: false, cubes: [good], customRounds: [{ kind: 'cube', cubeId: good.id }, null, null] }));

    expect((screen.getByTestId('pool-picker-custom-round-1') as HTMLInputElement).checked, 'round 1 is not the active slot yet').toBe(false);
    fireEvent.click(screen.getByTestId('pool-picker-custom-round-1'));
    expect(screen.getByTestId('pool-picker-custom-round-1-cubes'), 'round 1’s picker is now up, even for a non-leader').not.toBeNull();
    expect(screen.queryByTestId('pool-picker-custom-round-0-cubes'), 'round 0’s picker unmounted').toBeNull();
  });

  it('switching the active round to Set shows a searchable set gallery, scoped to that round’s own id', () => {
    render(createElement(PoolPicker, { ...baseProps, tab: 'custom', sets: [set()] }));

    fireEvent.click(screen.getByTestId('pool-picker-custom-round-0-type-set'));
    expect(screen.getByTestId('pool-picker-custom-round-0-sets-ISD')).not.toBeNull();
  });

  it('a round’s own Cube/Set toggle survives switching away and back to it', () => {
    render(createElement(PoolPicker, { ...baseProps, tab: 'custom', cubes: [cube()], sets: [set()] }));

    fireEvent.click(screen.getByTestId('pool-picker-custom-round-0-type-set'));
    expect(screen.getByTestId('pool-picker-custom-round-0-sets')).not.toBeNull();

    fireEvent.click(screen.getByTestId('pool-picker-custom-round-1')); // away
    fireEvent.click(screen.getByTestId('pool-picker-custom-round-0')); // back
    expect(screen.getByTestId('pool-picker-custom-round-0-sets'), 'round 0 is still on Set').not.toBeNull();
  });

  it('a chosen cube round calls back with that round and a cube PoolSource', () => {
    const onPickCustomRound = vi.fn();
    render(createElement(PoolPicker, { ...baseProps, tab: 'custom', cubes: [cube({ id: 'c7' })], onPickCustomRound }));

    fireEvent.click(screen.getByTestId('pool-picker-custom-round-2')); // select the slot first — its picker is not mounted otherwise
    fireEvent.click(screen.getByTestId('pool-picker-custom-round-2-cubes-c7'));
    expect(onPickCustomRound).toHaveBeenCalledWith(2, { kind: 'cube', cubeId: 'c7' });
  });

  it("a round whose chosen source's own cached verdict is refused names that round and lists the cards; an ok or unchecked round draws no line", () => {
    const bad = cube({ id: 'bad', verdict: { ok: false, unplayable: ['Card A'], missingText: ['Card B'] } });
    const good = cube({ id: 'good', verdict: { ok: true, cards: 99 } });
    const unchecked = cube({ id: 'unchecked' }); // verdict: null
    render(
      createElement(PoolPicker, {
        ...baseProps,
        tab: 'custom',
        cubes: [bad, good, unchecked],
        customRounds: [{ kind: 'cube', cubeId: bad.id }, { kind: 'cube', cubeId: good.id }, { kind: 'cube', cubeId: unchecked.id }],
      }),
    );

    // Round 0 is active by default.
    const round0 = screen.getByTestId('pool-picker-custom-round-0-verdict');
    expect(round0.getAttribute('data-state'), 'round 0 names itself refused').toBe('refused');
    expect(round0.textContent, 'and lists the cards').toBe('Card A, Card B');

    fireEvent.click(screen.getByTestId('pool-picker-custom-round-1'));
    const round1 = screen.getByTestId('pool-picker-custom-round-1-verdict');
    expect(round1.getAttribute('data-state')).toBe('ready');
    expect(round1.textContent).toBe('99 cards');

    fireEvent.click(screen.getByTestId('pool-picker-custom-round-2'));
    expect(screen.queryByTestId('pool-picker-custom-round-2-verdict'), 'never checked at this pin — no line at all').toBeNull();
  });

  it('a non-leader sees no presets block at all (leader-only, same as Cube tab’s import field)', () => {
    render(createElement(PoolPicker, { ...baseProps, tab: 'custom', leader: false, presets: [preset()] }));
    expect(screen.queryByTestId('pool-picker-preset-name')).toBeNull();
    expect(screen.queryByTestId(`pool-picker-preset-${preset().id}`)).toBeNull();
  });
});

describe('preset delete visibility (mutation-tested — see the lane report)', () => {
  it('shows Delete only for the preset’s own creator', () => {
    const mine = preset({ id: 'mine', createdBy: 'u-me' });
    const theirs = preset({ id: 'theirs', createdBy: 'u-someone-else' });
    render(createElement(PoolPicker, { ...baseProps, tab: 'custom', presets: [mine, theirs], myId: 'u-me' }));

    expect(screen.getByTestId(`pool-picker-preset-${mine.id}-delete`), 'the creator').not.toBeNull();
    expect(screen.queryByTestId(`pool-picker-preset-${theirs.id}-delete`), 'not the creator').toBeNull();
    // Load is open to anyone who can see the tab at all.
    expect(screen.getByTestId(`pool-picker-preset-${mine.id}-load`)).not.toBeNull();
    expect(screen.getByTestId(`pool-picker-preset-${theirs.id}-load`)).not.toBeNull();
  });

  it('saving is disabled with no name, enabled once one is typed', () => {
    render(createElement(PoolPicker, { ...baseProps, tab: 'custom' }));
    expect((screen.getByTestId('pool-picker-preset-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('pool-picker-preset-name'), { target: { value: 'x' } });
    expect((screen.getByTestId('pool-picker-preset-save') as HTMLButtonElement).disabled).toBe(false);
  });
});
