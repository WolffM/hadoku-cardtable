/*
 * The banner's wildcard card (`docs/planning/wave77-2026-10-27.md` §A): a small carousel of
 * anything else. Two items for now — "Looking for a game" (the Discord invite,
 * `../chrome/HeaderLinks.tsx`) and "Last game" (the newest replay, `GET /api/replays?limit=1`,
 * lane C's contract 2). The Discord item is static, so the card never hides itself; "Last game"
 * drops out quietly when the route is not there yet or answers nothing — a reachability problem
 * is not shown as an error on the front page.
 */

import { useEffect, useState } from 'react';

import { apiUrl, bodyOf, getJson, isRecord } from '../http.ts';
import { DISCORD_INVITE_URL } from '../chrome/HeaderLinks.tsx';
import { ChevronLeftIcon, ChevronRightIcon } from './icons.tsx';

interface WildcardItem {
  key: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  external: boolean;
}

const LOOKING_FOR_GAME: WildcardItem = {
  key: 'lfg',
  kind: 'Looking for a game',
  title: 'Short a player?',
  body: 'Ask in the Discord — someone is usually around.',
  href: DISCORD_INVITE_URL,
  external: true,
};

interface ReplaySummary {
  matchId: string;
  players: readonly string[];
}

/** The newest replay's own summary, or `null` for anything that is not one — never thrown. */
function parseReplaySummary(body: unknown): ReplaySummary | null {
  if (!isRecord(body) || !Array.isArray(body.replays)) return null;
  const first = body.replays[0];
  if (!isRecord(first) || typeof first.matchId !== 'string') return null;
  const players = Array.isArray(first.players) ? first.players.filter((p): p is string => typeof p === 'string') : [];
  return { matchId: first.matchId, players };
}

/** The newest replay, as a wildcard item — `null` while loading, or when there is none yet. */
function useLastGame(): WildcardItem | null {
  const [item, setItem] = useState<WildcardItem | null>(null);
  useEffect(() => {
    let live = true;
    getJson(apiUrl('replays?limit=1'))
      .then(async (res) => (res.ok ? parseReplaySummary(await bodyOf(res)) : null))
      .then((summary) => {
        if (!live || summary === null) return;
        setItem({
          key: 'last-game',
          kind: 'Last game',
          title: summary.players.length > 0 ? summary.players.join(' vs ') : 'A recent match',
          body: 'Watch how it played out.',
          href: `#/replay/${summary.matchId}`,
          external: false,
        });
      })
      .catch(() => {
        // Not reachable, or not shipped yet (lane C): the card just has one less item.
      });
    return () => {
      live = false;
    };
  }, []);
  return item;
}

export function WildcardCard() {
  const lastGame = useLastGame();
  const items = [LOOKING_FOR_GAME, ...(lastGame === null ? [] : [lastGame])];
  const [index, setIndex] = useState(0);
  const at = Math.min(index, items.length - 1);
  const item = items[at]!;

  return (
    <section className="front-card front-card--wildcard" data-testid="front-wildcard">
      <header className="front-card__head">
        <h3 className="front-card__title">{item.kind}</h3>
        {items.length > 1 && (
          <span className="front-card__carousel-nav">
            <button type="button" className="front-card__arrow" aria-label="Previous" onClick={() => setIndex((at - 1 + items.length) % items.length)}>
              <ChevronLeftIcon />
            </button>
            <button type="button" className="front-card__arrow" aria-label="Next" onClick={() => setIndex((at + 1) % items.length)}>
              <ChevronRightIcon />
            </button>
          </span>
        )}
      </header>
      <div className="front-card__wildcard-banner" aria-hidden="true" />
      <p className="front-card__release-title">{item.title}</p>
      <p className="front-card__wildcard-body">{item.body}</p>
      <div className="front-card__foot">
        <a className="front-card__link" href={item.href} target={item.external ? '_blank' : undefined} rel={item.external ? 'noopener noreferrer' : undefined}>
          {item.external ? 'Open Discord' : 'Watch'}
        </a>
        {items.length > 1 && (
          <span className="front-card__dots">
            {items.map((it, i) => (
              <span key={it.key} className="front-card__dot" data-active={i === at ? '' : undefined} />
            ))}
          </span>
        )}
      </div>
    </section>
  );
}
