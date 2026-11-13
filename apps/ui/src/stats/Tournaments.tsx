/*
 * The stats page's Tournaments tab (`#/tournaments`): every pod that played a
 * round, newest first, each with its final standings — kept by the server past
 * its room (`games/magic/server/src/room/tournaments.ts`), so a closed room's results
 * are still here (the operator, 2026-10-19: *"room results should be viewable
 * in the leaderboard page"*). Each draws its top three on the pod's podium beside
 * the standings, played as it is scrolled to (`PodPodium`'s `compact`). Only pods
 * two or more people played are served (`playedByPeople`).
 */

import { useEffect, useState } from 'react';

import { TournamentSchema, type Tournament } from '@hadoku/shared';

import { apiUrl, getJson, type Fetch } from '../http.ts';
import { PodPodium } from '../screens/pod/PodPodium.tsx';
import { PodStandings } from '../screens/pod/PodStandings.tsx';
import { faceOf } from '../components/Avatar.tsx';

export async function fetchTournaments(fetchImpl?: Fetch): Promise<Tournament[]> {
  const res = await getJson(apiUrl('tournaments'), fetchImpl);
  if (!res.ok) throw new Error(`Could not load the tournaments (${res.status}).`);
  const body = (await res.json()) as { tournaments?: unknown };
  return Array.isArray(body.tournaments) ? body.tournaments.flatMap((t) => TournamentSchema.safeParse(t).data ?? []) : [];
}

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function Tournaments({ load = fetchTournaments }: { load?: () => Promise<Tournament[]> }) {
  const [list, setList] = useState<Tournament[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((t) => live && setList(t))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [load]);

  if (error !== null) {
    return (
      <p className="ct-error" role="alert" data-testid="tournaments-error">
        {error}
      </p>
    );
  }
  if (list === null) {
    return (
      <div className="ct-tournaments" aria-busy="true" data-testid="tournaments-pending">
        <span className="skeleton skeleton--row" />
        <span className="skeleton skeleton--row" />
        <span className="skeleton skeleton--row" />
      </div>
    );
  }
  if (list.length === 0) return <p data-testid="tournaments-none">No tournaments yet</p>;
  return (
    <div className="ct-tournaments" data-testid="tournaments">
      {list.map((t) => {
        const nameOf = (id: string): string => t.names[id] ?? id;
        const avatarOf = (id: string) => faceOf(t.faces?.[id]);
        return (
          <section key={t.id} className="ct-tournament" data-testid="tournament" data-closed={t.closed ? '' : undefined}>
            <h2 className="ct-tournament__head">
              <span>{t.name}</span>
              <time className="ct-tournament__date" dateTime={new Date(t.endedAt).toISOString()}>
                {DATE.format(t.endedAt)}
              </time>
              <span className="ct-tournament__date">{t.standings.length} players</span>
              {t.closed && <span className="ct-tournament__closed">Closed early</span>}
            </h2>
            <div className="ct-tournament__body">
              <PodPodium compact rows={t.standings} results={t.results} nameOf={nameOf} avatarOf={avatarOf} myMemberId={null} />
              <PodStandings rows={t.standings} results={t.results} nameOf={nameOf} avatarOf={avatarOf} myMemberId={null} />
            </div>
          </section>
        );
      })}
    </div>
  );
}
