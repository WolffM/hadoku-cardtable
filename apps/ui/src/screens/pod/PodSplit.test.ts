// @vitest-environment jsdom
/*
 * Split & randomize (wave 84, the operator, 2026-10-31: *"it would be nice to have a 'split & randomize'
 * button after everyone readies up and before the drafting actually starts. that would give everyone time
 * to go to their own rooms."*): the leader's button once a draft room of more than 8 is all ready, then
 * each pod with the viewer's own marked, then the draft a moment later.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PodSplit } from './PodSplit.tsx';
import { podDealable, POD_SPLIT_GRACE_MS, type PodView } from './wire.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

function renderSplit(view: PodView, members: ReturnType<typeof membersOf>, myMemberId: string, handlers: { onSplit?: () => void; onStart?: () => void } = {}) {
  return render(createElement(PodSplit, { pod: view, members, leaderId: 'u-0', myMemberId, onSplit: handlers.onSplit ?? (() => undefined), onStart: handlers.onStart ?? (() => undefined) }));
}

describe('Split & randomize', () => {
  it('appears for the leader only once every seated drafter of a room past 8 is ready', () => {
    const people = ids(9);
    const notYet = membersOf(people).map((m, i) => (i === 4 ? { ...m, ready: false } : m));
    const { rerender } = renderSplit(pod(people), notYet, 'u-0');
    expect(screen.queryByTestId('pod-split')).toBeNull();

    const onSplit = vi.fn();
    const props = { pod: pod(people), members: membersOf(people), leaderId: 'u-0', onSplit, onStart: () => undefined };
    rerender(createElement(PodSplit, { ...props, myMemberId: 'u-3' }));
    expect(screen.queryByTestId('pod-split')).toBeNull();
    rerender(createElement(PodSplit, { ...props, myMemberId: 'u-0' }));
    expect(screen.getByTestId('pod-split').textContent).toBe('Split & randomize');
    fireEvent.click(screen.getByTestId('pod-split'));
    expect(onSplit).toHaveBeenCalledTimes(1);
  });

  it('is never offered to a room of 8 or fewer, which deals as soon as everyone is ready', () => {
    const people = ids(8);
    renderSplit(pod(people), membersOf(people), 'u-0');
    expect(screen.queryByTestId('pod-split')).toBeNull();
    expect(podDealable(pod(people).seats, membersOf(people))).toBe(true);
    expect(podDealable(pod(ids(9)).seats, membersOf(ids(9)))).toBe(false);
  });

  it('shows each pod once split, the viewer’s own marked, and starts the draft a moment later', () => {
    vi.useFakeTimers();
    const people = ids(9);
    const pods = [['u-6', 'u-2', 'u-0', 'u-8', 'u-4'], ['u-1', 'u-7', 'u-3', 'u-5']];
    const onStart = vi.fn();
    renderSplit(pod(people, { pods }), membersOf(people), 'u-3', { onStart });
    expect(screen.queryByTestId('pod-split')).toBeNull();
    expect(screen.getByTestId('pod-split-pod-0').textContent).toContain('Name u-6');
    expect(screen.getByTestId('pod-split-pod-1').dataset.mine).toBe('');
    expect(screen.getByTestId('pod-split-pod-0').dataset.mine).toBeUndefined();
    expect(screen.getByTestId('pod-split-pod-1').querySelectorAll('li')).toHaveLength(4);

    vi.advanceTimersByTime(POD_SPLIT_GRACE_MS - 1);
    expect(onStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('draws nothing for a tournament pod, which never splits', () => {
    const people = ids(10);
    const { container } = renderSplit(pod(people, { plan: null, roundNames: null, verdict: null }), membersOf(people), 'u-0');
    expect(container.innerHTML).toBe('');
  });
});
