/*
 * The Gauntlet, as the room draws it once its mode is chosen and both seats are ready
 * (`docs/planning/constructed-modes-plan.md`): the reveal and the ban/pick board, the secret
 * choice before each game (which stays up while the game is played), and the result. Presentational: the room passes the
 * server's view and the three acts, and this fetches nothing.
 */
import { useMemo } from 'react';

import type { GauntletView } from '@hadoku/shared';

import { GauntletBoard } from './GauntletBoard.tsx';
import { GauntletChoose } from './GauntletChoose.tsx';
import { GauntletResult } from './GauntletResult.tsx';
import { gauntletDeckOptions } from './decks.ts';
import './gauntlet.css';

export interface GauntletScreenProps {
  view: GauntletView;
  onBan: (deckId: string) => void;
  onPick: (deckId: string) => void;
  onChoose: (deckId: string) => void;
  /** Each table seat's avatar, for the coin's faces. */
  avatars?: readonly [string | undefined, string | undefined];
}

export function GauntletScreen({ view, onBan, onPick, onChoose, avatars }: GauntletScreenProps) {
  // The tiles depend only on which ten decks were drawn, not on where each stands.
  const drawn = view.decks.map((d) => d.id).join();
  const options = useMemo(() => gauntletDeckOptions(view.decks), [drawn]);
  switch (view.phase) {
    case 'options':
      return null;
    case 'reveal':
    case 'banpick':
      return <GauntletBoard view={view} options={options} avatars={avatars} onBan={onBan} onPick={onPick} />;
    // From the choice to the board, and while the game is played, the choose screen as both left it.
    case 'choose':
    case 'playing':
      return <GauntletChoose view={view} options={options} onChoose={onChoose} />;
    case 'done':
      return <GauntletResult view={view} options={options} />;
  }
}
