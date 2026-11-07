/*
 * The Gauntlet, as the room draws it once its mode is chosen and both seats are ready
 * (`docs/planning/constructed-modes-plan.md`): the reveal and the ban/pick board, the secret
 * choice before each game (which stays up while the game is played), and the result. Presentational: the room passes the
 * server's view and the three acts, and this fetches nothing.
 *
 * The step from the board into the choice is drawn as a transition (`arrive.ts`): for its length the
 * board as it was left lies under the choose screen, and the snake's last pick sounds as it flies,
 * as every other pick sounded on the board.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNamedArt } from '../libraryPeek.ts';

import type { GauntletView } from '@hadoku/shared';

import { playRole } from '../../sound/index.ts';
import { boardToLeave } from './arrive.ts';
import { GauntletBoard } from './GauntletBoard.tsx';
import { GauntletChoose } from './GauntletChoose.tsx';
import { GauntletResult } from './GauntletResult.tsx';
import { gauntletDeckOptions } from './decks.ts';
import { poolChangeRoles } from './sounds.ts';
import { SeatFaces } from './seats.tsx';
import { NO_FACE, type Face } from '../../components/Avatar.tsx';
import './gauntlet.css';

export interface GauntletScreenProps {
  view: GauntletView;
  onBan: (deckId: string) => void;
  onPick: (deckId: string) => void;
  onChoose: (deckId: string) => void;
  /** Each table seat's face (`seatFaces`), for the coin and the names. */
  faces?: readonly [Face, Face];
}

/** The board being left for the choice, and what its last act sounds. */
interface Leaving {
  board: GauntletView;
  sounds: readonly string[];
}

const noop = (): void => undefined;

const NO_FACES: readonly [Face, Face] = [NO_FACE, NO_FACE];

export function GauntletScreen({ view, onBan, onPick, onChoose, faces = NO_FACES }: GauntletScreenProps) {
  return (
    <SeatFaces.Provider value={faces}>
      <GauntletPhase view={view} onBan={onBan} onPick={onPick} onChoose={onChoose} />
    </SeatFaces.Provider>
  );
}

function GauntletPhase({ view, onBan, onPick, onChoose }: Omit<GauntletScreenProps, 'faces'>) {
  // The tiles depend only on which ten decks were drawn, not on where each stands.
  const drawn = view.decks.map((d) => d.id).join();
  // A tile's art is the server's answer for its cards' names: drawn again when it arrives.
  const namedArt = useNamedArt();
  const options = useMemo(() => gauntletDeckOptions(view.decks), [drawn, namedArt]);

  // The view this screen last drew, so the step out of ban/pick is seen as a step, here and on the other seat's screen alike.
  const [shown, setShown] = useState(view);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  if (shown !== view) {
    setShown(view);
    const board = boardToLeave(shown, view);
    if (board !== null) setLeaving({ board, sounds: poolChangeRoles(board.decks, view.decks) });
    else if (view.phase !== 'choose' && view.phase !== 'playing') setLeaving(null);
  }
  useEffect(() => {
    for (const role of leaving?.sounds ?? []) playRole(role);
  }, [leaving]);

  switch (view.phase) {
    case 'options':
      return null;
    case 'reveal':
    case 'banpick':
      return <GauntletBoard view={view} options={options} onBan={onBan} onPick={onPick} />;
    // From the choice to the board, and while the game is played, the choose screen as both left it.
    case 'choose':
    case 'playing':
      return (
        <GauntletChoose
          view={view}
          options={options}
          onChoose={onChoose}
          leaving={leaving === null ? null : <GauntletBoard view={leaving.board} options={options} onBan={noop} onPick={noop} leaving />}
          onArrived={() => setLeaving(null)}
        />
      );
    case 'done':
      return <GauntletResult view={view} options={options} />;
  }
}
