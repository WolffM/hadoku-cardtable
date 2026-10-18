/*
 * The pod's `building` phase: who has built, and the leader's Start round 1.
 *
 * Drawn above the deck builder (`DeckScreen.tsx`), because that is where every
 * drafter is while the phase lasts: a finished draft goes straight to the
 * builder. The drafter list is the server's own (`PodView.drafters`), the same
 * list its gate for starting `rounds` checks, so the button enables exactly
 * when the server would accept it.
 */

import { useState } from 'react';

import { StatusPill } from '../ConstructedScreen.tsx';
import { startPodRounds } from './client.ts';
import type { PodView } from './wire.ts';
import './PodBuilding.css';

export interface PodBuildingProps {
  roomId: string;
  pod: PodView;
  nameOf: (id: string) => string;
  youLead: boolean;
}

export function PodBuilding({ roomId, pod, nameOf, youLead }: PodBuildingProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const everyoneBuilt = pod.drafters.length > 0 && pod.drafters.every((id) => pod.built.includes(id));

  const begin = (): void => {
    setBusy(true);
    setError(null);
    startPodRounds(roomId)
      .then((r) => {
        if (!r.ok) setError(r.message);
      })
      .finally(() => setBusy(false));
  };

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
                label={`${nameOf(id)} — ${isBuilt ? 'built' : 'building'}`}
              />
            </li>
          );
        })}
      </ul>
      {youLead && (
        <button
          type="button"
          className="button"
          data-testid="pod-start-rounds"
          disabled={busy || !everyoneBuilt}
          onClick={begin}
        >
          Start round 1
        </button>
      )}
      {error !== null && (
        <p className="pod__error" role="alert" data-testid="pod-rounds-error">
          {error}
        </p>
      )}
    </section>
  );
}
