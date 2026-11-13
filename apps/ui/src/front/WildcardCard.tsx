/*
 * The banner's wildcard card: a manual gallery (`./Gallery.tsx`) of everything it has to show. It
 * opens on one weighted pick (`./wildcardItems.ts`'s `pickWildcard` — each kind's priority plus a
 * random draw) and the reader turns to the rest, highest priority first (`wildcardPages`) — the
 * operator, 2026-10-30: "manual is better, but let's still have the priority system for what is
 * shown by default and the randomness system beyond that". A featured tournament skips the draw: it
 * is always the page it opens on, for its week. It picks once every source has
 * answered, so it never opens on one and jumps to another as they arrive, and picks again only if
 * what it opened on goes away (the room filled). The kinds:
 *
 *   - **Tournament results** — the finished tournament holding the front page's seat
 *     (`/api/tournaments/featured`, `games/magic/server/src/room/featured-tournament.ts`): its top three on a
 *     small podium (`./FrontPodium.tsx`), ported from the pod's own (`../screens/pod/PodPodium.tsx`).
 *   - **Open seats now** — the room closest to starting that the viewer could sit down in, from
 *     the list the room list below already reads (`../rooms/api.ts`'s `onRoomList`): no read of
 *     its own, so the lobby's read budget (`e2e/aa-polling.spec.ts`) is unchanged.
 *   - **Cube spotlight** — a cube, three of its cards' art through the art manifest
 *     (`../draft/cardImage.ts`, never a stored URL), and Play now: a draft room on that cube. Its
 *     art is drawn all at once, only when every picture is decoded (`useArtLoaded`): a turn to it
 *     never shows a picture landing.
 *   - **In the Discord** — #general's recent messages, scrollable and opened on the newest, and Join
 *     Discord (`/api/discord/recent`, ArchiveBot's, prod only), asked for again hourly.
 *   - **Looking for a game** — the bare Discord invite (`../chrome/HeaderLinks.tsx`): there whenever
 *     the chat is not, so the card always has something.
 *
 * A read that fails or answers nothing drops its kind quietly: a reachability problem is not shown
 * as an error on the front page.
 *
 * Until it has picked, and the page it opens on has its art, the card stands as its skeleton — the
 * gallery's head, a title and a line, the dots and a button — and crossfades in with the rest of the
 * page (`./gate.ts`).
 *
 * Once it has shown, the pictures of its other pages (the cube's art, the chat's avatars) are warmed
 * in the background, a few at a time, at low priority, when the page is idle (`warmArt`), so turning to
 * one draws it at once — the operator, 2026-11-01: "preload the images after the core sight as loaded
 * with lazy load". Never before the page has shown (it must not compete with the first paint), at most
 * `PRELOAD_MAX` of them, and not at all when the viewer asks to save data or is on a 2G connection.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DiscordRecentSchema, FeaturedTournamentSchema, type DiscordMessage, type Tournament } from '@hadoku/shared';

import { apiUrl, bodyOf, getJson } from '../http.ts';
import { DISCORD_INVITE_URL } from '../chrome/HeaderLinks.tsx';
import { coverCropStyle, ILLUSTRATION_BOX } from '../components/faceCrop.ts';
import { Reveal } from '@hadoku/ui-shell/components';
import { cardImageUrl, warmArt } from '../draft/cardImage.ts';
import { useArtLoaded, usePicturesLoaded } from '../draft/useArtLoaded.ts';
import { facePictures } from '../components/Avatar.tsx';
import { onRoomList, poolsClient, roomsClient } from '../rooms/api.ts';
import { warmRoom } from '../rooms/warm.ts';
import { navigate, routeHash } from '../screens/route.ts';
import { playRole } from '../sound/index.ts';
import { avatarColour, avatarInitial, discordTime, groupMessages } from './discordChat.ts';
import { usePartShown } from './gate.ts';
import { ArrowGlyph, Gallery } from './Gallery.tsx';
import { FrontPodium } from './FrontPodium.tsx';
import { openSeats, pickWildcard, podiumOf, spotlightCube, wildcardPages, type OpenSeats, type WildcardKind } from './wildcardItems.ts';
import { RoomSeats } from './RoomSeats.tsx';
import { SwordsIcon, StaircaseIcon, DieIcon } from './icons.tsx';

interface WildcardItem {
  key: WildcardKind;
  kind: string;
  title: string;
  body: string;
  /** The Discord's recent messages, newest last, drawn as Discord's own client draws them in place of the title and body. */
  messages?: readonly DiscordMessage[];
  /** Where its button goes, or what it does (Play now). Absent: no button. */
  action?: { label: string; href: string; external: boolean } | { label: string; run: () => Promise<string | null> };
  /** Card art ids to draw across the top. */
  arts?: readonly string[];
  /** A finished tournament, drawn as its podium in place of the title and body. */
  podium?: Tournament;
  /** Every other picture it draws (the podium's faces), by URL: waited on like its art. */
  pictures?: readonly string[];
  /** A room asking for players, drawn with its format and its seats in place of the body; an open seat enters it, as Join does. */
  seats?: Pick<OpenSeats, 'room' | 'view'>;
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
                seats: { room: open.room, view: open.view },
                action: { href: routeHash({ kind: 'room', roomId: open.roomId }), label: 'Join', external: false },
              },
        );
      }),
    [],
  );
  return item;
}

/** The tournament holding the front page's seat, asked for once per visit; `null` when none holds it, or it cannot be read. */
function useFeaturedTournament(): WildcardItem | null | typeof ASKING {
  const [item, setItem] = useState<WildcardItem | null | typeof ASKING>(ASKING);
  useEffect(() => {
    let live = true;
    getJson(apiUrl('tournaments/featured'))
      .then(async (res) => (res.status === 200 ? (FeaturedTournamentSchema.safeParse(await bodyOf(res)).data?.tournament ?? null) : null))
      .then((t) => {
        if (live) setItem(t === null ? null : podiumItem(t));
      })
      .catch(() => {
        // Not reachable: the card shows what else it has.
        if (live) setItem(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return item;
}

function podiumItem(t: Tournament): WildcardItem {
  return {
    key: 'tournament',
    kind: 'Tournament results',
    title: t.name,
    body: '',
    podium: t,
    // The face each place will draw: the first it tries (`facePictures`).
    pictures: podiumOf(t).flatMap((p) => facePictures(p.face).slice(0, 1)),
    action: { href: routeHash({ kind: 'stats', tab: 'tournaments' }), label: 'Full standings', external: false },
  };
}

/** How often an open front page asks for the chat again: the server refreshes its own copy hourly too. */
const CHAT_REFRESH_MS = 60 * 60_000;

/** The chat as the wildcard shows it, or `null` when there are no messages. */
function chatItem(messages: readonly DiscordMessage[]): WildcardItem | null {
  return messages.length === 0
    ? null
    : {
        key: 'chat',
        kind: 'In the Discord',
        title: '#general',
        body: '',
        messages,
        action: { href: DISCORD_INVITE_URL, label: 'Join Discord', external: true },
      };
}

/**
 * The Discord's recent #general messages (`/api/discord/recent`, prod only), asked for again every
 * `CHAT_REFRESH_MS` while the page is open: `null` when there are none to show. A later ask that
 * fails keeps the chat already shown.
 */
function useDiscordChat(): WildcardItem | null | typeof ASKING {
  const [item, setItem] = useState<WildcardItem | null | typeof ASKING>(ASKING);
  useEffect(() => {
    let live = true;
    const ask = () =>
      getJson(apiUrl('discord/recent'))
        .then(async (res) => (res.status === 200 ? DiscordRecentSchema.safeParse(await bodyOf(res)).data ?? null : null))
        .then((recent) => {
          if (live) setItem(recent === null ? null : chatItem(recent.messages));
        })
        .catch(() => {
          // Not reachable: the invite stands in for it, unless a chat is already up.
          if (live) setItem((shown) => (shown === ASKING ? null : shown));
        });
    void ask();
    const timer = setInterval(() => void ask(), CHAT_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
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
        const sampled = cube === null ? null : await pools.cubeArts(cube.id, 3);
        if (!live) return;
        if (cube === null) {
          setItem(null);
          return;
        }
        const arts = sampled !== null && sampled.length > 0 ? sampled : cube.artId === null ? [] : [cube.artId];
        setItem({
          key: 'cube',
          kind: 'Cube spotlight',
          title: cube.name,
          body: `${String(cube.size)} cards · 8-seat pod`,
          action: { label: 'Play now!', run: () => playCube(cube) },
          ...(arts.length > 0 ? { arts } : {}),
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

/** `drawn`: every picture of the set is decoded (`useArtLoaded`); until then the box stands empty, in its own size. */
function ArtSlot({ artId, drawn }: { artId: string; drawn: boolean }) {
  const [failed, setFailed] = useState(false);
  const url = cardImageUrl(artId);
  return (
    <span className="front-card__wildcard-art">
      {drawn && url !== null && !failed && (
        <img src={url} alt="" fetchPriority="high" decoding="async" draggable={false} style={coverCropStyle(ILLUSTRATION_BOX, ART_RATIO)} onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/** The most pictures the card warms for its other pages: the cube's three, and a page of avatars. */
const PRELOAD_MAX = 12;

/** Every picture a page draws: its art, and the chat's avatars. */
function picturesOf(item: WildcardItem): string[] {
  const arts = (item.arts ?? []).map((id) => cardImageUrl(id));
  const avatars = item.messages === undefined ? [] : groupMessages(item.messages).map((g) => g.avatar);
  return [...new Set([...arts, ...avatars, ...(item.pictures ?? [])].filter((url): url is string => url !== null))];
}

/** The viewer asked to save data, or is on 2G: nothing is fetched before it is needed. */
function savingData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return connection?.saveData === true || /2g$/.test(connection?.effectiveType ?? '');
}

/** How long the card waits on a slow source before picking without it. */
const PICK_WAIT_MS = 2_000;

export function WildcardCard() {
  const chat = useDiscordChat();
  const sources = [useFeaturedTournament(), useOpenSeats(), useCubeSpotlight(), chat];
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), PICK_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  // The chat has the Discord's own Join button, so the bare invite is only there without it.
  const available = [...sources.filter((s): s is WildcardItem => s !== ASKING && s !== null), ...(chat === ASKING || chat === null ? [LOOKING_FOR_GAME] : [])];
  const settled = waited || sources.every((s) => s !== ASKING);

  const [picked, setPicked] = useState<WildcardKind | null>(null);
  const opened = available.some((i) => i.key === picked);
  useEffect(() => {
    // Once, when every source has answered; again only if what it opened on has gone (its room filled).
    if (settled && !opened) setPicked(pickWildcard(available.map((i) => i.key)));
  }, [settled, opened, available]);
  const pages = settled && opened ? wildcardPages(available.map((i) => i.key), picked).map((key) => available.find((i) => i.key === key)!) : [];
  /** What went wrong with a page's action (Play now), shown on that page. */
  const [errors, setErrors] = useState<Partial<Record<WildcardKind, string>>>({});
  const setError = (key: WildcardKind, message: string | null): void => setErrors((e) => ({ ...e, [key]: message ?? undefined }));

  // The page it opens on is drawn with its art and its faces, or not yet at all.
  const opening = pages[0];
  const openingArt = usePicturesLoaded(opening === undefined ? null : [...(opening.arts ?? []).map((id) => cardImageUrl(id)), ...(opening.pictures ?? [])]);
  const shown = usePartShown('wildcard', pages.length > 0 && openingArt);
  const otherPictures = pages.slice(1).flatMap(picturesOf).slice(0, PRELOAD_MAX).join(' ');
  // After the crossfade, as the Reveal itself says: the page has settled before anything it does not show is fetched.
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    if (faded && otherPictures !== '' && !savingData()) warmArt(otherPictures.split(' '));
  }, [faded, otherPictures]);

  return (
    <section className="front-card front-card--wildcard" data-testid="front-wildcard">
      <Reveal name="wildcard" shown={shown} onShown={setFaded} skeleton={<WildcardSkeleton />} className="front-card__body" layerClassName="front-card__layer">
        <Gallery testId="front-wildcard" pages={pages.map((item) => ({ key: item.key, title: item.kind, body: <WildcardBody item={item} error={errors[item.key] ?? null} />, action: <WildcardAction item={item} onError={(m) => setError(item.key, m)} /> }))} />
      </Reveal>
    </section>
  );
}

/** The gallery before it has picked: its head, a title and a line, its dots and a button, as placeholders. */
function WildcardSkeleton() {
  return (
    <>
      <header className="front-card__head">
        <h3 className="front-card__title">
          <span className="ghost ghost--text">Looking for a game</span>
        </h3>
        <span className="gallery__arrows">
          <span className="gallery__arrow ghost">
            <ArrowGlyph dir="prev" />
          </span>
          <span className="gallery__arrow ghost">
            <ArrowGlyph dir="next" />
          </span>
        </span>
      </header>
      <div className="gallery__page">
        <div className="front-card__wildcard-item">
          <p className="front-card__release-title">
            <span className="ghost ghost--text">Short a player?</span>
          </p>
          <p className="front-card__wildcard-body">
            <span className="ghost ghost--text">Ask in the Discord, someone is around.</span>
          </p>
        </div>
      </div>
      <div className="front-card__foot">
        <span className="gallery__dots">
          <span className="gallery__dot ghost" />
          <span className="gallery__dot ghost" />
          <span className="gallery__dot ghost" />
        </span>
        <span className="button front-card__more ghost">Open Discord</span>
      </div>
    </>
  );
}

/** The chat drawn as Discord's own client draws a channel: its header, then the messages grouped under the authors' own avatars and role colours (`./discordChat.ts`), scrolled to the newest. */
function DiscordChat({ channel, messages }: { channel: string; messages: readonly DiscordMessage[] }) {
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [messages]);
  return (
    <div className="discord-chat">
      <p className="discord-chat__channel">
        <span className="discord-chat__hash" aria-hidden="true">
          #
        </span>
        {channel.replace(/^#/, '')}
      </p>
      <ol ref={list} className="discord-chat__messages" data-testid="front-wildcard-messages">
        {groupMessages(messages).map((g, i) => (
          <li key={i} className="discord-chat__group">
            {g.avatar === null ? (
              <span className={`discord-chat__avatar discord-chat__avatar--${String(avatarColour(g.author))}`} aria-hidden="true">
                {avatarInitial(g.author)}
              </span>
            ) : (
              <img className="discord-chat__avatar" src={g.avatar} alt="" draggable={false} />
            )}
            <div className="discord-chat__body">
              <p className="discord-chat__head">
                <span className="discord-chat__author" style={g.color === null ? undefined : { color: g.color }}>
                  {g.author}
                </span>
                <time className="discord-chat__time" dateTime={g.at}>
                  {discordTime(g.at)}
                </time>
              </p>
              {g.texts.map((text, j) => (
                <p key={j} className="discord-chat__text">
                  {text}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function WildcardBody({ item, error }: { item: WildcardItem; error: string | null }) {
  const drawn = useArtLoaded(item.arts ?? []);
  return (
    <div className="front-card__wildcard-item" data-testid={`front-wildcard-${item.key}`}>
      {item.arts !== undefined && (
        <div className="front-card__wildcard-arts" aria-hidden="true">
          {item.arts.map((id) => (
            <ArtSlot key={id} artId={id} drawn={drawn} />
          ))}
        </div>
      )}
      {item.podium !== undefined ? (
        <FrontPodium tournament={item.podium} />
      ) : item.seats !== undefined ? (
        <OpenSeatsBody title={item.title} seats={item.seats} />
      ) : item.messages === undefined ? (
        <>
          <p className="front-card__release-title">{item.title}</p>
          <p className="front-card__wildcard-body">{item.body}</p>
        </>
      ) : (
        <DiscordChat channel={item.title} messages={item.messages} />
      )}
      {error !== null && (
        <p className="ct-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A room asking for players: who needs how many, its format and series, then its seats — an open one enters the room, as Join does. */
function OpenSeatsBody({ title, seats: { room, view } }: { title: string; seats: Pick<OpenSeats, 'room' | 'view'> }) {
  const enter = (): void => {
    playRole('ui.select');
    navigate({ kind: 'room', roomId: room.id });
  };
  return (
    <div className="front-open-seats">
      <p className="front-card__release-title">{title}</p>
      <p className="front-open-seats__meta">
        {view.mode.icon === 'classic' && <SwordsIcon />}
        {view.mode.icon === 'gauntlet' && <StaircaseIcon />}
        {view.mode.icon === 'random' && <DieIcon />}
        <span className="front-open-seats__mode">{view.mode.text}</span>
        {view.series !== null && <span className="front-open-seats__series">{view.series}</span>}
      </p>
      <RoomSeats room={room} view={view} onTake={enter} />
    </div>
  );
}

function WildcardAction({ item, onError }: { item: WildcardItem; onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const action = item.action;
  if (action === undefined) return null;
  if (!('run' in action)) {
    return (
      <a className="button front-card__more" data-testid="front-wildcard-action" href={action.href} target={action.external ? '_blank' : undefined} rel={action.external ? 'noopener noreferrer' : undefined}>
        {action.label}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="button front-card__more"
      data-testid="front-wildcard-action"
      disabled={busy}
      onClick={() => {
        playRole('ui.select');
        setBusy(true);
        onError(null);
        void action.run().then((failed) => {
          setBusy(false);
          if (failed === null) return;
          playRole('ui.deny');
          onError(failed);
        });
      }}
    >
      {action.label}
    </button>
  );
}
