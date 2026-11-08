/*
 * The wildcard's tournament page: a finished tournament's name, how many played, and its top three on
 * a small podium, second, first and third on blocks banded in their medal, with a crown on the winner.
 * Ported from the pod's own podium (`../screens/pod/PodPodium.tsx`), cut to the front card's size and
 * without its confetti. The blocks rise and the three drop on, third to first, once the card is shown
 * (`front.css`); reduced motion shows it still.
 */

import type { Tournament } from '@hadoku/shared';

import { Avatar } from '../components/Avatar.tsx';
import { PlayerName } from '../room/look.tsx';
import { podiumOf } from './wildcardItems.ts';

/** Left to right: second, first, third. */
const STAND = [2, 1, 3] as const;

export function FrontPodium({ tournament }: { tournament: Tournament }) {
  const places = podiumOf(tournament);
  return (
    <div className="front-podium" data-testid="front-podium">
      <p className="front-card__release-title front-podium__name">{tournament.name}</p>
      <p className="front-podium__meta">{tournament.standings.length} players</p>
      <div className="front-podium__stands" aria-label="Top three">
        {STAND.map((place) => {
          const p = places[place - 1];
          if (p === undefined) return null;
          return (
            <div key={place} className="front-podium__stand" data-place={place} data-testid={`front-podium-${String(place)}`}>
              <div className="front-podium__figure">
                {place === 1 && (
                  <svg className="front-podium__crown" viewBox="0 0 44 30" aria-hidden="true">
                    <path d="M3 26 L7 6 L16 16 L22 2 L28 16 L37 6 L41 26 Z" />
                  </svg>
                )}
                <span className="front-podium__frame">
                  <Avatar {...p.face} fallback="initial" name={p.name} className="front-podium__face" fallbackClassName="front-podium__face front-podium__face--none" width={64} height={64} draggable={false} />
                </span>
              </div>
              <PlayerName name={p.name} face={p.face} className="front-podium__who" />
              <span className="front-podium__line">{p.record}</span>
              <div className="front-podium__block">
                <span className="front-podium__number">{place}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
