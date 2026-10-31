/*
 * Split & randomize, a draft room of more than 8's step between Ready and the draft (the operator,
 * 2026-10-31: *"it would be nice to have a 'split & randomize' button after everyone readies up and before
 * the drafting actually starts. that would give everyone time to go to their own rooms."*).
 *
 * Once every seated drafter is ready, the leader gets the button; the server splits the field at random
 * (`apps/server/src/room/lobby.ts`'s `splitPod`, seeded and logged) and the room shows every pod, the
 * viewer's own marked. `POD_SPLIT_GRACE_MS` later each browser asks for the deal, as a room of one pod's
 * browsers do the moment it is ready (`ConstructedScreen.tsx`); the server deals once, each pod on its own
 * draft. The bar under the pods drains over that moment, and says nothing in words.
 *
 * Nothing for a room of 8 or fewer (`podDealable` deals it as before) or a tournament pod, which drafts no
 * pool.
 */

import { useEffect, useRef } from 'react';

import { ActionButton } from '../../components/ActionButton.tsx';
import { Avatar } from '../../components/Avatar.tsx';
import { podReady, POD_SEATS, POD_SPLIT_GRACE_MS, seatedDrafters, type PodView } from './wire.ts';
import './PodSplit.css';

export interface PodSplitProps {
  pod: PodView;
  members: readonly { id: string; name: string; ready: boolean; avatarId?: unknown }[];
  leaderId: string;
  myMemberId: string | null;
  onSplit: () => void;
  /** The split has stood its moment: ask for the deal. */
  onStart: () => void;
}

export function PodSplit({ pod, members, leaderId, myMemberId, onSplit, onStart }: PodSplitProps) {
  const pods = pod.phase === 'lobby' && pod.plan !== null ? (pod.pods ?? null) : null;
  const key = pods?.map((p) => p.join()).join('|') ?? null;
  const start = useRef(onStart);
  start.current = onStart;
  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => start.current(), POD_SPLIT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  if (pod.phase !== 'lobby' || pod.plan === null) return null;
  if (pods === null) {
    const offered = myMemberId === leaderId && seatedDrafters(pod.seats).length > POD_SEATS && podReady(pod.seats, members);
    return offered ? (
      <ActionButton action="split" className="lobby__go" data-testid="pod-split" onPress={onSplit}>
        Split & randomize
      </ActionButton>
    ) : null;
  }

  const member = (id: string) => members.find((m) => m.id === id);
  return (
    <section className="pod-split" data-testid="pod-split-pods">
      <div className="pod-split__pods">
        {pods.map((drafters, k) => (
          <div key={k} className="pod-split__pod" data-testid={`pod-split-pod-${k}`} {...(myMemberId !== null && drafters.includes(myMemberId) ? { 'data-mine': '' } : {})}>
            <h3 className="pod-split__name">Pod {k + 1}</h3>
            <ol className="pod-split__drafters">
              {drafters.map((id) => {
                const m = member(id);
                const avatarId = typeof m?.avatarId === 'string' ? m.avatarId : undefined;
                return (
                  <li key={id} className="pod-split__drafter">
                    <Avatar id={avatarId} fallback="initial" name={m?.name ?? ''} className="pod-split__face" fallbackClassName="pod-split__face" />
                    <span className="pod-split__drafter-name">{m?.name ?? id}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
      <span key={key} className="pod-split__clock" data-testid="pod-split-clock" style={{ animationDuration: `${POD_SPLIT_GRACE_MS}ms` }} aria-hidden="true" />
    </section>
  );
}
