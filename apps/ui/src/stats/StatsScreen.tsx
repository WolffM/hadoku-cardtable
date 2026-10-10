/*
 * `#/stats` and `#/stats/<name>`: a player's record and history, and the
 * friend group's boards — read from the game-stats store in prefs-api, which
 * this server reports every finished room match to (`apps/server/src/stats/`).
 *
 * Cardtable's composition of the generic tables in `StatsTables.tsx`: this file
 * is where Magic comes in — the colour pips and the deck on each seat — and
 * nothing in that file imports from here.
 *
 * Every section loads on its own, so one failed read leaves the others standing.
 * The store is same-origin (`hadoku.me/prefs`) and reads by the session cookie;
 * players are registry names, and the store marks the viewer's own rows.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { createGameStatsClient, type GameStatsClient, type SeatView } from '@wolffm/prefs-client/games';

import { ManaPip } from '../components/ManaPip.tsx';
import { routeHash } from '../screens/route.ts';
import { BreakdownTable, LeaderboardTable, MatchList, RecordSummary } from './StatsTables.tsx';

/** The rating pool every room match is reported in. */
export const STATS_MODE = 'constructed';

export interface StatsScreenProps {
  /** A registry name; absent is the viewer. */
  player?: string;
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: GameStatsClient;
}

type Load<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; message: string };

function useLoad<T>(load: () => Promise<T>, key: string): Load<T> {
  const [result, setResult] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setResult({ state: 'loading' });
    load().then(
      (value) => live && setResult({ state: 'ok', value }),
      (err: unknown) => live && setResult({ state: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
    // `key` names everything `load` closes over; `load` itself is a new closure every render.
  }, [key]);
  return result;
}

function Section<T>({
  title,
  load,
  wide,
  testId,
  children,
}: {
  title: string;
  load: Load<T>;
  wide?: boolean;
  testId: string;
  children: (value: T) => ReactNode;
}) {
  return (
    <section className={wide ? 'stats__section stats__section--wide' : 'stats__section'} data-testid={testId} aria-busy={load.state === 'loading'}>
      <h2 className="stats__heading">{title}</h2>
      {load.state === 'ok' && children(load.value)}
      {load.state === 'error' && <p className="stats__error">{load.message}</p>}
    </section>
  );
}

const EMPTY = <p className="stats__empty">No games yet</p>;

function PlayerLink({ name }: { name: string }) {
  return (
    <a className="shell__link" href={routeHash({ kind: 'stats', player: name })}>
      {name}
    </a>
  );
}

const renderName = (name: string) => <PlayerLink name={name} />;

function Pips({ colors }: { colors: readonly string[] }) {
  return (
    <span className="cost" data-colors={colors.join('')}>
      {colors.map((c) => (
        <ManaPip key={c} token={c} />
      ))}
    </span>
  );
}

function seatDeck(seat: SeatView): ReactNode {
  const deck = seat.attrs.deck;
  const colors = seat.attrs.colors;
  if (typeof deck !== 'string') return null;
  return (
    <span className="stats-seats__deck">
      {Array.isArray(colors) && <Pips colors={colors} />}
      {deck}
    </span>
  );
}

export function StatsScreen({ player, client: given }: StatsScreenProps) {
  const client = useMemo(() => given ?? createGameStatsClient({ gameId: 'cardtable' }), [given]);
  const scope = { mode: STATS_MODE, ...(player === undefined ? {} : { player }) };
  const who = player ?? '';

  const profile = useLoad(() => client.profile(scope), `profile:${who}`);
  const matches = useLoad(() => client.matches({ ...scope, limit: 20 }), `matches:${who}`);
  const colors = useLoad(() => client.breakdown('colors', scope), `colors:${who}`);
  const decks = useLoad(() => client.breakdown('deck', scope), `decks:${who}`);
  const winners = useLoad(() => client.breakdown('deck', { mode: STATS_MODE, player: '*' }), 'winners');
  const ratings = useLoad(() => client.leaderboard({ by: 'rating', mode: STATS_MODE }), 'ratings');

  return (
    <div className="shell stats" data-testid="stats">
      <header className="shell__head">
        <h1 className="shell__title">{player ?? 'Stats'}</h1>
      </header>
      <main className="stats__grid">
        <Section title="Record" load={profile} testId="stats-record-section">
          {(p) => <RecordSummary profile={p} mode={STATS_MODE} />}
        </Section>
        <Section title="Ratings" load={ratings} testId="stats-ratings-section">
          {(board) => (board.rows.length === 0 ? EMPTY : <LeaderboardTable rows={board.rows} valueLabel="Rating" renderName={renderName} />)}
        </Section>
        <Section title="Recent matches" load={matches} wide testId="stats-matches-section">
          {(page) =>
            page.matches.length === 0 ? (
              EMPTY
            ) : (
              <MatchList matches={page.matches} player={player} describeSeat={seatDeck} counter={{ key: 'turns', label: 'Turns' }} renderName={renderName} />
            )
          }
        </Section>
        <Section title="Colours" load={colors} testId="stats-colors-section">
          {(b) => (b.rows.length === 0 ? EMPTY : <BreakdownTable rows={b.rows} label="Colour" renderValue={(c) => <Pips colors={[c]} />} testId="stats-colors" />)}
        </Section>
        <Section title="Decks" load={decks} testId="stats-decks-section">
          {(b) => (b.rows.length === 0 ? EMPTY : <BreakdownTable rows={b.rows} label="Deck" testId="stats-decks" />)}
        </Section>
        <Section title="Decks that win" load={winners} wide testId="stats-winners-section">
          {(b) => (b.rows.length === 0 ? EMPTY : <BreakdownTable rows={b.rows} label="Deck" testId="stats-winners" />)}
        </Section>
      </main>
    </div>
  );
}
