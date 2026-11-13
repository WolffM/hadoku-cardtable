/*
 * Split & randomize, a draft room of more than 8's step between Ready and the draft (the operator,
 * 2026-10-31: *"it would be nice to have a 'split & randomize' button after everyone readies up and before
 * the drafting actually starts"*, then *"just give the leader a second button to confirm the start of the
 * draft, after everyone has readied up. once everyone is ready and the pods are created, noone can unready
 * anymore. their position is locked."*).
 *
 * Once every seated drafter is ready, the leader's `PodSplitAction` is Split & randomize; the server splits
 * the field at random (`games/magic/server/src/room/lobby.ts`'s `splitPod`, seeded and logged) and locks every seat
 * and Ready. `PodSplit` then draws every pod in the seats' place, the viewer's own marked, and the leader's
 * action becomes Start draft, which deals each pod its own draft.
 *
 * The pods reveal top to bottom (the operator: *"a reveal animation from top to bottom … that would be more
 * dramatic"*): each name carries its row (`--reveal-row`), and `PodSplit.css` staggers the rows, the same row
 * of every pod together.
 *
 * Nothing for a room of 8 or fewer (`podDealable` deals it as before) or a tournament pod, which drafts no
 * pool.
 */

import type { CSSProperties } from 'react';

import { ActionButton } from '../../components/ActionButton.tsx';
import { Avatar, faceOf } from '../../components/Avatar.tsx';
import { PlayerName } from '../../room/look.tsx';
import type { Look } from '@hadoku/shared';
import { podReady, POD_SEATS, seatedDrafters, type PodView } from './wire.ts';
import './PodSplit.css';

type Member = { id: string; name: string; ready: boolean; avatarId?: unknown; look?: Look };

/** The leader's split's pods while it stands, or null: never for a tournament pod, which drafts no pool. */
export function standingPods(pod: PodView): string[][] | null {
  return pod.phase === 'lobby' && pod.plan !== null ? (pod.pods ?? null) : null;
}

export interface PodSplitActionProps {
  pod: PodView;
  members: readonly Member[];
  leaderId: string;
  myMemberId: string | null;
  onSplit: () => void;
  onStart: () => void;
}

/** The leader's one button beside Ready: Split & randomize once the room past 8 is ready, then Start draft. */
export function PodSplitAction({ pod, members, leaderId, myMemberId, onSplit, onStart }: PodSplitActionProps) {
  if (pod.phase !== 'lobby' || pod.plan === null || myMemberId !== leaderId) return null;
  if (standingPods(pod) !== null) {
    return (
      <ActionButton action="start" className="lobby__go" data-testid="pod-split-start" onPress={onStart}>
        Start draft
      </ActionButton>
    );
  }
  if (seatedDrafters(pod.seats).length <= POD_SEATS || !podReady(pod.seats, members)) return null;
  return (
    <ActionButton action="split" className="lobby__go" data-testid="pod-split" onPress={onSplit}>
      Split & randomize
    </ActionButton>
  );
}

export interface PodSplitProps {
  pod: PodView;
  members: readonly Member[];
  myMemberId: string | null;
}

/** Every pod of the standing split, the viewer's own marked. */
export function PodSplit({ pod, members, myMemberId }: PodSplitProps) {
  const pods = standingPods(pod);
  if (pods === null) return null;
  const member = (id: string) => members.find((m) => m.id === id);
  return (
    <section className="pod-split" data-testid="pod-split-pods">
      {pods.map((drafters, k) => (
        <div key={k} className="pod-split__pod" data-testid={`pod-split-pod-${k}`} {...(myMemberId !== null && drafters.includes(myMemberId) ? { 'data-mine': '' } : {})}>
          <h3 className="pod-split__name">Pod {k + 1}</h3>
          <ol className="pod-split__drafters">
            {drafters.map((id, row) => {
              const m = member(id);
              return (
                <li key={id} className="pod-split__drafter" style={{ '--reveal-row': row } as CSSProperties}>
                  <Avatar {...faceOf(m)} fallback="initial" name={m?.name ?? ''} className="pod-split__face" fallbackClassName="pod-split__face" />
                  <PlayerName name={m?.name ?? id} face={faceOf(m)} className="pod-split__drafter-name" />
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </section>
  );
}
