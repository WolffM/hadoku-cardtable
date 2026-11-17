// @vitest-environment jsdom
/* The spectator row's Lead: drawn only when the caller hands it the leader's handler, never on the viewer. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { SpectatorRow } from './SpectatorRow.tsx';

afterEach(cleanup);

const spectators = [
  { id: 'u-alice', name: 'Alice' },
  { id: 'u-bob', name: 'Bob' },
];

describe('the spectator row', () => {
  it('offers Lead on every spectator but the viewer when given the handler', () => {
    const onMakeLeader = vi.fn();
    render(createElement(SpectatorRow, { spectators, myId: 'u-alice', leaderId: 'u-alice', onMakeLeader }));
    const leads = screen.getAllByTestId('spectator-make-leader');
    expect(leads.map((b) => b.dataset.member)).toEqual(['u-bob']);
    leads[0]!.click();
    expect(onMakeLeader).toHaveBeenCalledWith('u-bob');
  });

  it('draws no Lead without the handler', () => {
    render(createElement(SpectatorRow, { spectators, myId: 'u-bob', leaderId: 'u-alice' }));
    expect(screen.queryByTestId('spectator-make-leader')).toBeNull();
  });
});
