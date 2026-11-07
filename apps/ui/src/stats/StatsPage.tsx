/*
 * The stats page: a page of its own the lobby's trophy opens (`./StatsButton.tsx`), on three tabs —
 * the Leaderboard (`#/stats`), Your profile (`#/profile`, and any player's at `#/stats/<name>`)
 * and Tournaments (`#/tournaments`). It replaced the popout over the lobby (the operator approved
 * the redesign, 2026-11-02), and like every page the lobby opens it heads itself with the way home.
 *
 * The page is a chunk of its own (`../lazy.ts`); the trophy warms it and every read its Leaderboard
 * opens with, and the Your profile tab warms the profile's on hover, into one cache
 * (`./source.ts`), so a tab opens drawn and refreshes behind what it shows — for a signed-in
 * viewer only, and never again after a refusal (`signedInStatsClient`).
 *
 * The rankings, match feeds, profile header, rating line and head to head are
 * `@wolffm/game-stats-ui`'s, shared by every hadoku game, and so is the card every section is
 * drawn in. The Magic is here: pips, decks and their lists on hover (`./StatsDecks.tsx`), colours
 * (`./Colours.tsx`), and a match's format, era, turns and ending (`./magic.tsx`).
 */

import { useId, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '@wolffm/themes';
import { useStatsLoad } from '@wolffm/game-stats-ui';
import '@wolffm/game-stats-ui/style.css';

import { useChromeShell } from '@hadoku/ui-shell/chrome/shell';
import { HomeHead } from '../screens/HomeHead.tsx';
import { navigate, routeHash, type Route } from '../screens/route.ts';
import { uiLength } from '@hadoku/ui-shell/settings';
import { Leaderboard } from './Leaderboard.tsx';
import { Profile } from './Profile.tsx';
import { everyone, prefetchLeaderboard, prefetchProfile, sharedSource, type StatsSource } from './source.ts';
import { DeckPeekHost, deckLookup, type DeckLookup } from './StatsDecks.tsx';
import { Tournaments } from './Tournaments.tsx';
import type { ParkedGame } from './UnfinishedGames.tsx';
import './stats.css';

type Tab = 'leaderboard' | 'profile' | 'tournaments';

const TABS: readonly { tab: Tab; label: string; route: Route; warm?: (source: StatsSource) => void }[] = [
  { tab: 'leaderboard', label: 'Leaderboard', route: { kind: 'stats' }, warm: prefetchLeaderboard },
  { tab: 'profile', label: 'Your profile', route: { kind: 'stats', tab: 'profile' }, warm: prefetchProfile },
  { tab: 'tournaments', label: 'Tournaments', route: { kind: 'stats', tab: 'tournaments' } },
];

export interface StatsPageProps {
  /** The route's tab; absent, the Leaderboard. */
  tab?: 'profile' | 'tournaments' | undefined;
  /** A registry name: that player's profile. */
  player?: string | undefined;
  /** Tests pass a client over a stub fetch, and its cache. Production passes nothing. */
  source?: StatsSource;
  /** Where a deck row's list comes from. Tests pass a stub; production the API's. */
  decks?: DeckLookup;
  /** The viewer's unfinished games. Tests pass a stub; production the server's. */
  parked?: () => Promise<ParkedGame[]>;
}

let sharedLookup: DeckLookup | undefined;

export function StatsPage({ tab, player, source = sharedSource(), decks, parked }: StatsPageProps) {
  const shellRef = useChromeShell('fit');
  const lookup = useMemo(() => decks ?? (sharedLookup ??= deckLookup()), [decks]);
  /** The tab drawn; another player's profile is none of the three. */
  const current: Tab | null = player !== undefined ? null : (tab ?? 'leaderboard');
  return (
    <div ref={shellRef} className="shell shell--fit ct-stats" data-testid="stats">
      <HomeHead title="Stats" tools={current === 'leaderboard' ? <FindPlayer source={source} /> : undefined}>
        <nav className="ct-stats__tabs" aria-label="Stats sections">
          {TABS.map((t) => (
            <a
              key={t.tab}
              className="ct-stats__tab"
              href={routeHash(t.route)}
              aria-current={t.tab === current ? 'page' : undefined}
              data-testid={`stats-tab-${t.tab}`}
              onPointerEnter={t.warm === undefined ? undefined : () => t.warm?.(source)}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </HomeHead>
      <main className="ct-stats__body">
        {current === 'tournaments' ? (
          <section className="gs-card ct-stats__tournaments" aria-label="Tournaments">
            {/* TODO: the tournament bracket view. The operator, 2026-11-02: "i'd prefer a nice bracket view … there is
                another session working on rebuilding that so hold off on the tournament view for now". Until that
                rebuild lands, this tab keeps the standings list it always had, so players still see past results. */}
            <Tournaments />
          </section>
        ) : (
          <DeckPeekHost lookup={lookup} ownDecks={current === 'profile'}>
            {current === 'leaderboard' ? <Leaderboard source={source} /> : <Profile key={player ?? ''} source={source} player={player} parked={parked} />}
          </DeckPeekHost>
        )}
      </main>
    </div>
  );
}

/** A search box for a player by name, offering the ranked ones; Enter opens their profile. */
function FindPlayer({ source }: { source: StatsSource }) {
  const listId = useId();
  const [name, setName] = useState('');
  const board = everyone.board(source.client, 'rating');
  const ranked = useStatsLoad(board.load, board.key, source.cache);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted !== '') navigate({ kind: 'stats', player: wanted });
  };
  return (
    <form className="ct-stats__find" role="search" onSubmit={submit}>
      <label className="ct-stats__search">
        <Icon name="magnifier" size={uiLength('1rem')} />
        <input type="search" placeholder="Find a player" aria-label="Find a player" list={listId} value={name} onChange={(e) => setName(e.target.value)} data-testid="stats-find" />
      </label>
      <datalist id={listId}>{ranked.state === 'ok' && ranked.value.rows.map((r) => <option key={r.name} value={r.name} />)}</datalist>
    </form>
  );
}
