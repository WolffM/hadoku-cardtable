// @vitest-environment jsdom
/*
 * Split & randomize (wave 84, the operator, 2026-10-31: *"it would be nice to have a 'split & randomize'
 * button after everyone readies up and before the drafting actually starts"*, then *"just give the leader a
 * second button to confirm the start of the draft"*): the leader's Split once a draft room of more than 8 is
 * all ready, then each pod with the viewer's own marked, and the leader's Start draft.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PodSplit, PodSplitAction } from './PodSplit.tsx';
import { podDealable, type PodView } from './wire.ts';

afterEach(cleanup);

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u-${i}`);
const membersOf = (people: string[], ready = true) => people.map((id) => ({ id, name: `Name ${id}`, ready, joinedAt: '' }));

function pod(people: string[], over: Partial<PodView> = {}): PodView {
  return {
    phase: 'lobby',
    seats: [...people.map((memberId) => ({ memberId, name: `Name ${memberId}` })), ...Array.from({ length: Math.max(0, 8 - people.length) }, () => ({ memberId: 'ai', name: '' }))],
    round: 0,
    rounds: 0,
    results: [],
    standings: [],
    pairings: [],
    bye: null,
    drafters: [],
    built: [],
    personas: {},
    plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
    roundNames: ['Test Cube', 'Test Cube', 'Test Cube'],
    verdict: { ok: true, cards: 360 },
    ...over,
  };
}

function renderAction(view: PodView, members: ReturnType<typeof membersOf>, myMemberId: string, handlers: { onSplit?: () => void; onStart?: () => void } = {}) {
  return render(createElement(PodSplitAction, { pod: view, members, leaderId: 'u-0', myMemberId, onSplit: handlers.onSplit ?? (() => undefined), onStart: handlers.onStart ?? (() => undefined) }));
}

describe('Split & randomize', () => {
  it('appears for the leader only once every seated drafter of a room past 8 is ready', () => {
    const people = ids(9);
    const notYet = membersOf(people).map((m, i) => (i === 4 ? { ...m, ready: false } : m));
    const { rerender } = renderAction(pod(people), notYet, 'u-0');
    expect(screen.queryByTestId('pod-split')).toBeNull();

    const onSplit = vi.fn();
    const props = { pod: pod(people), members: membersOf(people), leaderId: 'u-0', onSplit, onStart: () => undefined };
    rerender(createElement(PodSplitAction, { ...props, myMemberId: 'u-3' }));
    expect(screen.queryByTestId('pod-split')).toBeNull();
    rerender(createElement(PodSplitAction, { ...props, myMemberId: 'u-0' }));
    expect(screen.getByTestId('pod-split').textContent).toBe('Split & randomize');
    fireEvent.click(screen.getByTestId('pod-split'));
    expect(onSplit).toHaveBeenCalledTimes(1);
  });

  it('is never offered to a room of 8 or fewer, which deals as soon as everyone is ready', () => {
    const people = ids(8);
    renderAction(pod(people), membersOf(people), 'u-0');
    expect(screen.queryByTestId('pod-split')).toBeNull();
    expect(podDealable(pod(people).seats, membersOf(people))).toBe(true);
    expect(podDealable(pod(ids(9)).seats, membersOf(ids(9)))).toBe(false);
  });

  it('shows each pod once split, the viewer’s own marked, with no countdown', () => {
    const people = ids(9);
    const pods = [['u-6', 'u-2', 'u-0', 'u-8', 'u-4'], ['u-1', 'u-7', 'u-3', 'u-5']];
    render(createElement(PodSplit, { pod: pod(people, { pods }), members: membersOf(people), myMemberId: 'u-3' }));
    expect(screen.getByTestId('pod-split-pod-0').textContent).toContain('Name u-6');
    expect(screen.getByTestId('pod-split-pod-1').dataset.mine).toBe('');
    expect(screen.getByTestId('pod-split-pod-0').dataset.mine).toBeUndefined();
    expect(screen.getByTestId('pod-split-pod-1').querySelectorAll('li')).toHaveLength(4);
    expect(screen.queryByTestId('pod-split-clock')).toBeNull();
  });

  it('reveals the pods top to bottom: every name carries its row, the same row across pods together', () => {
    const people = ids(9);
    const pods = [['u-6', 'u-2', 'u-0', 'u-8', 'u-4'], ['u-1', 'u-7', 'u-3', 'u-5']];
    render(createElement(PodSplit, { pod: pod(people, { pods }), members: membersOf(people), myMemberId: 'u-3' }));
    const rows = (k: number) => [...screen.getByTestId(`pod-split-pod-${k}`).querySelectorAll('li')].map((li) => li.style.getPropertyValue('--reveal-row'));
    expect(rows(0)).toEqual(['0', '1', '2', '3', '4']);
    expect(rows(1)).toEqual(['0', '1', '2', '3']);
  });

  it('once split, the leader alone gets Start draft, and the draft waits for it', () => {
    const people = ids(9);
    const pods = [['u-6', 'u-2', 'u-0', 'u-8', 'u-4'], ['u-1', 'u-7', 'u-3', 'u-5']];
    const onStart = vi.fn();
    const { rerender } = renderAction(pod(people, { pods }), membersOf(people), 'u-3', { onStart });
    expect(screen.queryByTestId('pod-split-start')).toBeNull();
    expect(screen.queryByTestId('pod-split')).toBeNull();
    rerender(createElement(PodSplitAction, { pod: pod(people, { pods }), members: membersOf(people), leaderId: 'u-0', myMemberId: 'u-0', onSplit: () => undefined, onStart }));
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByTestId('pod-split-start').textContent).toBe('Start draft');
    fireEvent.click(screen.getByTestId('pod-split-start'));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('draws nothing for a tournament pod, which never splits', () => {
    const people = ids(10);
    const { container } = renderAction(pod(people, { plan: null, roundNames: null, verdict: null }), membersOf(people), 'u-0');
    expect(container.innerHTML).toBe('');
  });
});
