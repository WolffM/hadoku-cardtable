/*
 * The banner's wildcard card (`docs/planning/wave77-2026-10-27.md` §A): a carousel of anything else,
 * moving on by itself every `ROTATE_MS` unless the viewer is hovering it, using it, or away
 * (`./wildcardItems.ts`'s `mayRotate`). Its items:
 *
 *   - **Open seats now** — the room closest to starting that the viewer could sit down in, from
 *     the list the room list below already reads (`../rooms/api.ts`'s `onRoomList`): no read of
 *     its own, so the lobby's read budget (`e2e/aa-polling.spec.ts`) is unchanged.
 *   - **Last game** — the newest replay, `GET /api/replays?limit=1` (lane C's contract 2).
 *   - **Cube spotlight** — a bundled or imported cube and three of its cards' art, through the art
 *     manifest (`../draft/cardImage.ts`), never a stored URL.
 *   - **Looking for a game** — the Discord invite (`../chrome/HeaderLinks.tsx`). Static, so the card
 *     never hides itself.
 *
 * A read that fails or answers nothing drops its item quietly: a reachability problem is not shown
 * as an error on the front page.
 */

import { useEffect, useRef, useState } from 'react';

import { apiUrl, bodyOf, getJson, isRecord } from '../http.ts';
import { DISCORD_INVITE_URL } from '../chrome/HeaderLinks.tsx';
import { coverCropStyle, ILLUSTRATION_BOX } from '../components/faceCrop.ts';
import { cardImageUrl } from '../draft/cardImage.ts';
import { onRoomList, poolsClient } from '../rooms/api.ts';
import { routeHash } from '../screens/route.ts';
import { ChevronLeftIcon, ChevronRightIcon } from './icons.tsx';
import { mayRotate, openSeats, ROTATE_MS, sampleArt, spotlightCube } from './wildcardItems.ts';

interface WildcardItem {
  key: string;
  kind: string;
  title: string;
  body: string;
  /** Absent: the item has nowhere to go. */
  link?: { href: string; label: string; external: boolean };
  /** Card art ids to draw across the top, in place of the plain banner. */
  arts?: readonly string[];
}

/** `.front-card__wildcard-art`'s own `aspect-ratio` in `front.css` — the two must agree. */
const ART_RATIO = 4 / 3;

const LOOKING_FOR_GAME: WildcardItem = {
  key: 'lfg',
  kind: 'Looking for a game',
  title: 'Short a player?',
  body: 'Ask in the Discord — someone is usually around.',
  link: { href: DISCORD_INVITE_URL, label: 'Open Discord', external: true },
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
          link: { href: `#/replay/${summary.matchId}`, label: 'Watch', external: false },
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

/** The room asking for players, from every room list the page reads (`../rooms/api.ts`'s `onRoomList`) — never a read of its own. */
function useOpenSeats(): WildcardItem | null {
  const [item, setItem] = useState<WildcardItem | null>(null);
  useEffect(
    () =>
      onRoomList((rooms) => {
        const open = openSeats(rooms);
        setItem(
          open === null
            ? null
            : {
                key: 'open-seats',
                kind: 'Open seats now',
                title: open.title,
                body: open.missing === 1 ? 'One more and it starts.' : 'Grab a seat.',
                link: { href: routeHash({ kind: 'room', roomId: open.roomId }), label: 'Join', external: false },
              },
        );
      }),
    [],
  );
  return item;
}

/** One cube and three of its cards, picked once per visit. */
function useCubeSpotlight(): WildcardItem | null {
  const [item, setItem] = useState<WildcardItem | null>(null);
  useEffect(() => {
    const pools = poolsClient();
    let live = true;
    pools
      .listCubes()
      .then(async (cubes) => {
        const cube = spotlightCube(cubes);
        if (cube === null) return;
        const cards = await pools.cubeCards(cube.id);
        if (!live) return;
        const arts = sampleArt(cards ?? [], 3);
        setItem({
          key: 'cube',
          kind: 'Cube spotlight',
          title: cube.name,
          body: `${String(cube.size)} cards`,
          ...(arts.length > 0 ? { arts } : cube.artId === null ? {} : { arts: [cube.artId] }),
        });
      })
      .catch(() => {
        // No cubes reachable: the card just has one less item.
      });
    return () => {
      live = false;
    };
  }, []);
  return item;
}

function ArtSlot({ artId }: { artId: string }) {
  const [failed, setFailed] = useState(false);
  const url = cardImageUrl(artId);
  return (
    <span className="front-card__wildcard-art">
      {url !== null && !failed && (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} style={coverCropStyle(ILLUSTRATION_BOX, ART_RATIO)} onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/** Whether the page is in a background tab, kept current. */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => globalThis.document?.hidden ?? false);
  useEffect(() => {
    const doc = globalThis.document;
    const onChange = (): void => setHidden(doc.hidden);
    doc.addEventListener('visibilitychange', onChange);
    return () => doc.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}

export function WildcardCard() {
  const openSeatsItem = useOpenSeats();
  const lastGame = useLastGame();
  const cube = useCubeSpotlight();
  const items = [openSeatsItem, lastGame, cube, LOOKING_FOR_GAME].filter((i): i is WildcardItem => i !== null);
  const [index, setIndex] = useState(0);
  const at = Math.min(index, items.length - 1);
  const item = items[at]!;

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hidden = usePageHidden();
  const rotating = mayRotate({ items: items.length, hovered, focused, hidden });
  // The interval reads the current length through a ref, so a newly arrived item does not restart the clock.
  const count = useRef(items.length);
  count.current = items.length;
  useEffect(() => {
    if (!rotating) return undefined;
    const timer = setInterval(() => setIndex((i) => (Math.min(i, count.current - 1) + 1) % count.current), ROTATE_MS);
    return () => clearInterval(timer);
  }, [rotating]);

  return (
    <section
      className="front-card front-card--wildcard"
      data-testid="front-wildcard"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      // Keyboard focus only: a clicked arrow keeps focus after the pointer leaves, and would pause it for good.
      onFocus={(e) => setFocused(e.target.matches(':focus-visible'))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
    >
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
      <div key={item.key} className="front-card__wildcard-item" data-testid={`front-wildcard-${item.key}`}>
        {item.arts === undefined ? (
          <div className="front-card__wildcard-banner" aria-hidden="true" />
        ) : (
          <div className="front-card__wildcard-arts" aria-hidden="true">
            {item.arts.map((id) => (
              <ArtSlot key={id} artId={id} />
            ))}
          </div>
        )}
        <p className="front-card__release-title">{item.title}</p>
        <p className="front-card__wildcard-body">{item.body}</p>
      </div>
      <div className="front-card__foot">
        {items.length > 1 && (
          <span className="front-card__dots">
            {items.map((it, i) => (
              <button key={it.key} type="button" className="front-card__dot" aria-label={it.kind} aria-current={i === at ? 'true' : undefined} onClick={() => setIndex(i)} />
            ))}
          </span>
        )}
        {item.link !== undefined && (
          <a className="button front-card__more" href={item.link.href} target={item.link.external ? '_blank' : undefined} rel={item.link.external ? 'noopener noreferrer' : undefined}>
            {item.link.label}
          </a>
        )}
      </div>
    </section>
  );
}
