// @vitest-environment jsdom
/*
 * A Lead press asks before it hands the room over: nothing is sent until Make
 * leader, and Cancel, Escape and Enter-on-the-default all leave the room as it was.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useLeaderAsk } from './LeaderAsk.tsx';

afterEach(cleanup);

const names: Record<string, string> = { 'u-bob': 'Bob' };

function Harness({ pass }: { pass: (id: string) => void }) {
  const leaderAsk = useLeaderAsk((id) => names[id], pass);
  return createElement('div', null, createElement('button', { type: 'button', 'data-testid': 'lead', onClick: () => leaderAsk.ask('u-bob') }), leaderAsk.sheet);
}

const open = (pass: (id: string) => void): void => {
  render(createElement(Harness, { pass }));
  expect(screen.queryByTestId('leader-ask')).toBeNull();
  act(() => screen.getByTestId('lead').click());
};

describe('passing the room leader', () => {
  it('asks first, naming the member, and passes only on Make leader', () => {
    const pass = vi.fn();
    open(pass);
    expect(screen.getByTestId('leader-ask-sheet').textContent).toContain('Make Bob the room leader?');
    expect(pass).not.toHaveBeenCalled();
    act(() => screen.getByTestId('leader-ask-yes').click());
    expect(pass).toHaveBeenCalledExactlyOnceWith('u-bob');
    expect(screen.queryByTestId('leader-ask')).toBeNull();
  });

  it('Cancel closes it and passes nothing', () => {
    const pass = vi.fn();
    open(pass);
    act(() => screen.getByTestId('leader-ask-no').click());
    expect(screen.queryByTestId('leader-ask')).toBeNull();
    expect(pass).not.toHaveBeenCalled();
  });

  it('Escape closes it and passes nothing', () => {
    const pass = vi.fn();
    open(pass);
    fireEvent.keyDown(screen.getByTestId('leader-ask-no'), { key: 'Escape' });
    expect(screen.queryByTestId('leader-ask')).toBeNull();
    expect(pass).not.toHaveBeenCalled();
  });

  it('focuses Cancel, so an unread Enter keeps the room', () => {
    open(vi.fn());
    expect(document.activeElement).toBe(screen.getByTestId('leader-ask-no'));
  });
});
