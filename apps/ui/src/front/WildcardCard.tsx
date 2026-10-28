/*
 * The banner's wildcard card (`docs/planning/wave77-2026-10-27.md` §A): ONE thing, picked once per
 * visit (`./wildcardItems.ts`'s `pickWildcard` — each kind's weight plus a random draw), never a
 * carousel (the operator, 2026-10-28: "let's not do that … pick a single thing to show"). It picks
 * once every source has answered, so it never flips from one to another as they arrive, and picks
 * again only if what it showed goes away (the room filled). The kinds:
 *
 *   - **Open seats now** — the room closest to starting that the viewer could sit down in, from
 *     the list the room list below already reads (`../rooms/api.ts`'s `onRoomList`): no read of
 *     its own, so the lobby's read budget (`e2e/aa-polling.spec.ts`) is unchanged.
 *   - **Cube spotlight** — a cube, three of its cards' art through the art manifest
 *     (`../draft/cardImage.ts`, never a stored URL), and Play now: a draft room on that cube.
 *   - **Last game** — the newest replay, `GET /api/replays?limit=1`; only while `REPLAYS_ON`.
 *   - **In the Discord** — #general's last few messages and Join Discord (`/api/discord/recent`,
 *     ArchiveBot's, prod only).
 *   - **Looking for a game** — the bare Discord invite (`../chrome/HeaderLinks.tsx`): there whenever
 *     the chat is not, so the card always has something.
 *
 * A read that fails or answers nothing drops its kind quietly: a reachability problem is not shown
 * as an error on the front page.
 */

import { useEffect, useState } from 'react';
import { DiscordRecentSchema, type DiscordMessage } from '@hadoku/shared';

import { apiUrl, bodyOf, getJson, isRecord } from '../http.ts';
import { DISCORD_INVITE_URL } from '../chrome/HeaderLinks.tsx';
import { coverCropStyle, ILLUSTRATION_BOX } from '../components/faceCrop.ts';
import { cardImageUrl } from '../draft/cardImage.ts';
import { onRoomList, poolsClient, roomsClient } from '../rooms/api.ts';
import { warmRoom } from '../rooms/warm.ts';
import { REPLAYS_ON } from '../replay/transport.ts';
import { navigate, routeHash } from '../screens/route.ts';
import { playRole } from '../sound/index.ts';
import { openSeats, pickWildcard, sampleArt, spotlightCube, type WildcardKind } from './wildcardItems.ts';

interface WildcardItem {
  key: WildcardKind;
  kind: string;
  title: string;
  body: string;
  /** The Discord's last few messages, newest last, drawn in place of the body. */
  messages?: readonly DiscordMessage[];
  /** Where its button goes, or what it does (Play now). Absent: no button. */
  action?: { label: string; href: string; external: boolean } | { label: string; run: () => Promise<string | null> };
  /** Card art ids to draw across the top. */
  arts?: readonly string[];
}

/** A source still asking, as opposed to one that answered with nothing (`null`). */
const ASKING = undefined;

/** `.front-card__wildcard-art`'s own `aspect-ratio` in `front.css` — the two must agree. */
const ART_RATIO = 4 / 3;

const LOOKING_FOR_GAME: WildcardItem = {
  key: 'lfg',
  kind: 'Looking for a game',
  title: 'Short a player?',
  body: 'Ask in the Discord — someone is usually around.',
  action: { href: DISCORD_INVITE_URL, label: 'Open Discord', external: true },
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

/** The newest replay, as a wildcard item: `ASKING` until the read answers, `null` when there is none. */
function useLastGame(): WildcardItem | null | typeof ASKING {
  const [item, setItem] = useState<WildcardItem | null | typeof ASKING>(REPLAYS_ON ? ASKING : null);
  useEffect(() => {
    if (!REPLAYS_ON) return undefined;
    let live = true;
    getJson(apiUrl('replays?limit=1'))
      .then(async (res) => (res.ok ? parseReplaySummary(await bodyOf(res)) : null))
      .then((summary) => {
        if (!live) return;
        setItem(
          summary === null
            ? null
            : {
                key: 'last-game',
                kind: 'Last game',
                title: summary.players.length > 0 ? summary.players.join(' vs ') : 'A recent match',
                body: 'Watch how it played out.',
                action: { href: `#/replay/${summary.matchId}`, label: 'Watch', external: false },
              },
        );
      })
      .catch(() => {
        // Not reachable: the card just has one less thing to pick from.
        if (live) setItem(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return item;
}

/** The room asking for players, from every room list the page reads (`../rooms/api.ts`'s `onRoomList`) — never a read of its own. */
function useOpenSeats(): WildcardItem | null | typeof ASKING {
  const [item, setItem] = useState<WildcardItem | null | typeof ASKING>(ASKING);
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
                action: { href: routeHash({ kind: 'room', roomId: open.roomId }), label: 'Join', external: false },
              },
        );
      }),
    [],
  );
  return item;
}

/** The Discord's last few #general messages (`/api/discord/recent`, prod only): `null` when there are none to show. */
function useDiscordChat(): WildcardItem | null | typeof ASKING {
  const [item, setItem] = useState<WildcardItem | null | typeof ASKING>(ASKING);
  useEffect(() => {
    let live = true;
    getJson(apiUrl('discord/recent'))
      .then(async (res) => (res.status === 200 ? DiscordRecentSchema.safeParse(await bodyOf(res)).data ?? null : null))
      .then((recent) => {
        if (!live) return;
        setItem(
          recent === null || recent.messages.length === 0
            ? null
            : {
                key: 'chat',
                kind: 'In the Discord',
                title: '#general',
                body: '',
                messages: recent.messages,
                action: { href: DISCORD_INVITE_URL, label: 'Join Discord', external: true },
              },
        );
      })
      .catch(() => {
        // Not reachable: the invite stands in for it.
        if (live) setItem(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return item;
}

/** A draft room on `cube`, every round its packs, with the viewer leading it: the spotlight's Play now. `null` once it opens, or what went wrong. */
async function playCube(cube: { id: string; name: string }): Promise<string | null> {
  const rooms = roomsClient();
  const made = await rooms.create({ name: cube.name, gameType: 'draft', clientMode: 'builtin' });
  if (!made.ok) return made.message;
  const source = { kind: 'cube' as const, cubeId: cube.id };
  const planned = await rooms.setPlan(made.room.id, { rounds: [source, source, source] });
  if (!planned.ok) return planned.message;
  await warmRoom(planned.room);
  navigate({ kind: 'room', roomId: planned.room.id });
  return null;
}

/** One cube and three of its cards, picked once per visit. */
function useCubeSpotlight(): WildcardItem | null | typeof ASKING {
  const [item, setItem] = useState<WildcardItem | null | typeof ASKING>(ASKING);
  useEffect(() => {
    const pools = poolsClient();
    let live = true;
    pools
      .listCubes()
      .then(async (cubes) => {
        const cube = spotlightCube(cubes);
        const cards = cube === null ? null : await pools.cubeCards(cube.id);
        if (!live) return;
        if (cube === null) {
          setItem(null);
          return;
        }
        const arts = sampleArt(cards ?? [], 3);
        setItem({
          key: 'cube',
          kind: 'Cube spotlight',
          title: cube.name,
          body: `${String(cube.size)} cards · 8-seat pod`,
          action: { label: 'Play now!', run: () => playCube(cube) },
          ...(arts.length > 0 ? { arts } : cube.artId === null ? {} : { arts: [cube.artId] }),
        });
      })
      .catch(() => {
        // No cubes reachable: the card just has one less thing to pick from.
        if (live) setItem(null);
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

/** How long the card waits on a slow source before picking without it. */
const PICK_WAIT_MS = 2_000;

export function WildcardCard() {
  const chat = useDiscordChat();
  const sources = [useOpenSeats(), useCubeSpotlight(), useLastGame(), chat];
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), PICK_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  // The chat has the Discord's own Join button, so the bare invite is only there without it.
  const available = [...sources.filter((s): s is WildcardItem => s !== ASKING && s !== null), ...(chat === ASKING || chat === null ? [LOOKING_FOR_GAME] : [])];
  const settled = waited || sources.every((s) => s !== ASKING);

  const [picked, setPicked] = useState<WildcardKind | null>(null);
  const showing = available.find((i) => i.key === picked);
  useEffect(() => {
    // Once, when every source has answered; again only if what it shows has gone (its room filled).
    if (settled && showing === undefined) setPicked(pickWildcard(available.map((i) => i.key)));
  }, [settled, showing, available]);

  return (
    <section className="front-card front-card--wildcard" data-testid="front-wildcard">
      {showing !== undefined && <WildcardBody key={showing.key} item={showing} />}
    </section>
  );
}

function WildcardBody({ item }: { item: WildcardItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = item.action;
  return (
    <>
      <header className="front-card__head">
        <h3 className="front-card__title">{item.kind}</h3>
      </header>
      <div className="front-card__wildcard-item" data-testid={`front-wildcard-${item.key}`}>
        {item.arts !== undefined && (
          <div className="front-card__wildcard-arts" aria-hidden="true">
            {item.arts.map((id) => (
              <ArtSlot key={id} artId={id} />
            ))}
          </div>
        )}
        <p className="front-card__release-title">{item.title}</p>
        {item.messages === undefined ? (
          <p className="front-card__wildcard-body">{item.body}</p>
        ) : (
          <ul className="front-card__chat" data-testid="front-wildcard-messages">
            {item.messages.map((m, i) => (
              <li key={i} className="front-card__chat-line">
                <span className="front-card__chat-author">{m.author}</span> {m.text}
              </li>
            ))}
          </ul>
        )}
        {error !== null && (
          <p className="ct-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {action !== undefined && (
        <div className="front-card__foot">
          {'run' in action ? (
            <button
              type="button"
              className="button front-card__more"
              data-testid="front-wildcard-action"
              disabled={busy}
              onClick={() => {
                playRole('ui.select');
                setBusy(true);
                setError(null);
                void action.run().then((failed) => {
                  setBusy(false);
                  if (failed === null) return;
                  playRole('ui.deny');
                  setError(failed);
                });
              }}
            >
              {action.label}
            </button>
          ) : (
            <a className="button front-card__more" data-testid="front-wildcard-action" href={action.href} target={action.external ? '_blank' : undefined} rel={action.external ? 'noopener noreferrer' : undefined}>
              {action.label}
            </a>
          )}
        </div>
      )}
    </>
  );
}
