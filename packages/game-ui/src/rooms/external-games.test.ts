/**
 * The client half of cardtable's external-game room types — the wiring only. What `<BundleSlot>`
 * itself does with what it is handed is `BundleSlot.test.ts`'s own proof; this file proves
 * `rooms/external-games.tsx` registers each `EXTERNAL_GAMES` entry's room UI under its own id,
 * forwarding the right props, with no `setup`, and no client spec (the server reads the seats). Ported from the old
 * `bomberman.test.ts`, proved generically (wave 119 §U) rather than by bomberman's name alone.
 */
import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { gameTypeSpec } from '../../../../packages/shared/src/game-type-spec.ts';

import { BundleSlot } from './BundleSlot.tsx';
import { gameRoomUiFor } from './game-setup.ts';
import type { GameSetupProps } from './game-setup.ts';
import { EXTERNAL_GAMES } from './external-games.tsx';

describe('rooms/external-games.tsx', () => {
  it('EXTERNAL_GAMES names at least bomberman, so deleting its one entry is what removes it', () => {
    expect(EXTERNAL_GAMES.some((g) => g.id === 'bomberman')).toBe(true);
  });

  for (const game of EXTERNAL_GAMES) {
    describe(`"${game.id}"`, () => {
      it('registers no spec on the client: its seat range is the server\'s, from the game\'s own manifest', () => {
        expect(gameTypeSpec(game.id)).toBeUndefined();
      });

      it('registers with no setup (nothing above the seats) and a game that is a BundleSlot at the embed path', () => {
        const ui = gameRoomUiFor(game.id);
        expect(ui).not.toBeNull();
        expect(ui?.setup).toBeUndefined();

        const props: GameSetupProps = {
          view: { id: 'r-1', name: 'Boom room', gameType: game.id, members: [{ id: 'm1', name: 'alice' }], seats: ['m1'], you: { id: 'm1', leader: true } },
          me: { userId: 'm1', seat: null, isLeader: true },
          underway: true,
        };
        const node = ui?.game(props);
        expect(isValidElement(node)).toBe(true);
        if (!isValidElement(node)) throw new Error('not an element');
        expect(node.type).toBe(BundleSlot);
        expect(node.props).toEqual({ src: game.embedSrc, view: props.view, me: props.me, relay: true });
      });
    });
  }
});
