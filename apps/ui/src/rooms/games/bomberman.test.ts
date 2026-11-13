/**
 * Bomberman's own room UI registration — the wiring only. What `<BundleSlot>` itself does with
 * what it is handed is `BundleSlot.test.ts`'s own proof; this file proves `rooms/games/bomberman.tsx`
 * registers the right thing, under the right id, forwarding the right props, with no `setup`.
 */
import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { gameTypeSpec } from '@hadoku/shared';

import { BundleSlot } from '@hadoku/game-ui/rooms/BundleSlot.tsx';
import { gameRoomUiFor } from '@hadoku/game-ui/rooms/game-setup.ts';
import type { GameSetupProps } from '@hadoku/game-ui/rooms/game-setup.ts';
import { BOMBERMAN_EMBED_SRC } from './bomberman.tsx';

describe('rooms/games/bomberman.tsx', () => {
  it("registers bomberman's spec on the client too, relay runtime and all, so its room gets a channel", () => {
    expect(gameTypeSpec('bomberman')).toMatchObject({ runtime: 'relay', seatRejoinGraceMs: 120_000, seats: { min: 2, max: 10 } });
  });

  it('registers "bomberman" with no setup (nothing above the seats) and a game that is a BundleSlot at the embed path', () => {
    const ui = gameRoomUiFor('bomberman');
    expect(ui).not.toBeNull();
    expect(ui?.setup).toBeUndefined();

    const props: GameSetupProps = {
      view: { id: 'r-1', name: 'Boom room', gameType: 'bomberman', members: [{ id: 'm1', name: 'alice' }], seats: ['m1'], you: { id: 'm1', leader: true } },
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
