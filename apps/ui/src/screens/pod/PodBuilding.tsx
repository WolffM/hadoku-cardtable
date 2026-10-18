/*
 * The pod's `building` phase: who has pressed Play.
 *
 * Drawn above the deck builder (`DeckScreen.tsx`), because that is where every
 * drafter is while the phase lasts: a finished draft goes straight to the
 * builder. The drafter list is the server's own (`PodView.drafters`). Nobody
 * starts the rounds: the last drafter's Play deals round 1 (`room/lobby.ts`'s
 * `playPod`).
 */

import { StatusPill } from '../ConstructedScreen.tsx';
import type { PodView } from './wire.ts';
import './PodBuilding.css';

export interface PodBuildingProps {
  pod: PodView;
  nameOf: (id: string) => string;
}

export function PodBuilding({ pod, nameOf }: PodBuildingProps) {
  return (
    <section className="pod-building" data-testid="pod-building">
      <ul className="pod-building__built" data-testid="pod-built">
        {pod.drafters.map((id) => {
          const isBuilt = pod.built.includes(id);
          return (
            <li key={id} data-testid={`pod-built-${id}`} data-built={isBuilt ? '' : undefined}>
              <StatusPill
                kind="ready"
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
