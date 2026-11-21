/*
 * Who has pressed Play, one pill per drafter.
 *
 * Drawn above the deck builder (`DeckScreen.tsx`) for as long as the pod builds
 * or plays, and on the room's hub while anyone is still building. The drafter
 * list is the server's own (`PodView.drafters`), without the bots: in the
 * rounds it names every entrant, and a bot built its deck as it drafted. Round 1 is dealt when the
 * draft ends (`room/lobby.ts`'s `podDraftDone`); a Play seats that drafter's
 * deck at their table (`playPod`).
 */

import { StatusPill } from '@hadoku/game-ui/components/StatusPill.tsx';
import { isPodAi, type PodView } from './wire.ts';
import './PodBuilding.css';

export interface PodBuildingProps {
  pod: PodView;
  nameOf: (id: string) => string;
}

export function PodBuilding({ pod, nameOf }: PodBuildingProps) {
  return (
    <section className="pod-building" data-testid="pod-building">
      <ul className="pod-building__built" data-testid="pod-built">
        {pod.drafters.filter((id) => !isPodAi(id)).map((id) => {
          const isBuilt = pod.built.includes(id);
          return (
            <li key={id} data-testid={`pod-built-${id}`} data-built={isBuilt ? '' : undefined}>
              <StatusPill
                testId={`pod-built-${id}-pill`}
                state={isBuilt ? 'yes' : 'no'}
                mark={isBuilt ? 'tick' : 'ring'}
                label={`${nameOf(id)} — ${isBuilt ? 'ready' : 'building'}`}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
