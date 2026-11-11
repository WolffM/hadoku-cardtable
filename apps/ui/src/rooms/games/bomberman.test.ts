/**
 * Bomberman's own room UI registration — the wiring only. What `<BundleSlot>` itself does with
 * what it is handed is `BundleSlot.test.ts`'s own proof; this file proves `rooms/games/bomberman.tsx`
 * registers the right thing, under the right id, forwarding the right props, with no `setup`.
 */
import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';

import { BundleSlot } from '../BundleSlot.tsx';
import { gameRoomUiFor } from '../game-setup.ts';
import type { GameSetupProps } from '../game-setup.ts';
import { BOMBERMAN_EMBED_SRC } from './bomberman.tsx';

describe('rooms/games/bomberman.tsx', () => {
  it('registers "bomberman" with no setup (nothing above the seats) and a game that is a BundleSlot at the embed path', () => {
    const ui = gameRoomUiFor('bomberman');
    expect(ui).not.toBeNull();
    expect(ui?.setup).toBeUndefined();

    const props: GameSetupProps = {
      view: { id: 'r-1', name: 'Boom room', gameType: 'bomberman', members: [{ id: 'm1', name: 'alice' }], you: { id: 'm1', leader: true } },
      me: { userId: 'm1', seat: null, isLeader: true },
      underway: true,
    };
    const node = ui?.game(props);
    expect(isValidElement(node)).toBe(true);
    if (!isValidElement(node)) throw new Error('not an element');
    expect(node.type).toBe(BundleSlot);
    expect(node.props).toEqual({ src: BOMBERMAN_EMBED_SRC, view: props.view, me: props.me });
  });
});
