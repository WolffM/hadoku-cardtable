/*
 * The stats popout's Tournaments tab (`#/tournaments`): every pod that played a
 * round, newest first, each with its final standings — kept by the server past
 * its room (`apps/server/src/room/tournaments.ts`), so a closed room's results
 * are still here (the operator, 2026-10-19: *"room results should be viewable
 * in the leaderboard page"*).
 */

import { useEffect, useState } from 'react';

import { PodStandings, type PodResultLike, type PodStandingsRowLike } from '../screens/pod/PodStandings.tsx';

export interface Tournament {
  id: string;
  name: string;
  endedAt: number;
  closed: boolean;
  names: Record<string, string>;
  standings: PodStandingsRowLike[];
  results: PodResultLike[];
}

function isTournament(v: unknown): v is Tournament {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.endedAt === 'number' &&
    typeof t.closed === 'boolean' &&
    typeof t.names === 'object' &&
    t.names !== null &&
    Array.isArray(t.standings) &&
    Array.isArray(t.results)
  );
}

function apiBase(): string {
  const base = import.meta.env?.BASE_URL;
  const b = typeof base === 'string' ? base : '/';
  return `${b}${b.endsWith('/') ? '' : '/'}api/`;
}

export async function fetchTournaments(fetchImpl: typeof fetch = fetch): Promise<Tournament[]> {
  const res = await fetchImpl(`${apiBase()}tournaments`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not load the tournaments (${res.status}).`);
  const body = (await res.json()) as { tournaments?: unknown };
  return Array.isArray(body.tournaments) ? body.tournaments.filter(isTournament) : [];
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
      <p className="lobby__error" role="alert" data-testid="tournaments-error">
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
      {list.map((t) => (
        <section key={t.id} className="ct-tournament" data-testid="tournament" data-closed={t.closed ? '' : undefined}>
          <h2 className="ct-tournament__head">
            <span>{t.name}</span>
            <time className="ct-tournament__date" dateTime={new Date(t.endedAt).toISOString()}>
              {DATE.format(t.endedAt)}
            </time>
            {t.closed && <span className="ct-tournament__closed">Closed early</span>}
          </h2>
          <PodStandings rows={t.standings} results={t.results} nameOf={(id) => t.names[id] ?? id} myMemberId={null} />
        </section>
      ))}
    </div>
  );
}
