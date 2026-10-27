/*
 * The room list — the front page, in the operator's words: *"all they see on
 * the front page is a list of rooms and they can either join a room or create
 * a new one."*
 *
 * Every room the server knows is listed to every friend, with its name, its
 * game type, who is in it, and whether it has a password. A locked room asks
 * for the password when you try to enter it, not before; a wrong password is
 * reported in words that do not say whether the room still exists, because
 * the server deliberately answers "wrong password" and "no such room" alike.
 *
 * ## Four states, each with something to do
 *
 *   loading  — says so; Create room already works
 *   failed   — says why, and offers Retry
 *   empty    — says so, with Create room above it
 *   rooms    — the list
 *
 * ## Just the rooms (2026-10-10)
 *
 * The operator: *"let's have it just show the rooms. the entire 'Create a room'
 * ui can be shown in a popout modal instead behind a button … at the bottom
 * right of the rooms list. also the 'Which Client' question should not exist
 * for now"*. So the form is `CreateRoomDialog`, behind `room-create-open` — at
 * the top of the list, beside its title, since 2026-10-23 (the operator: *"lets
 * move the 'Create room' button to the top of the room list rather than the
 * bottom"*) — and
 * every room it makes is our table. The streamed mode is not gone: the server
 * still takes `clientMode: 'streamed'`, a streamed room still lists and plays,
 * and `e2e/room-mode.spec.ts` makes one through the API. Offering it again is
 * the radio group this file used to draw.
 *
 * ## Freshness
 *
 * Read again whenever the server says a room changed (`./feed.ts`), and once
 * when the tab is shown again. A friend's new room shows up without a reload,
 * and nobody's open lobby reads the list on a timer — a backgrounded one reads
 * nothing at all. A read that fails after the list has loaded keeps the list
 * and says it is stale, rather than throwing away rooms a person may be about
 * to click.
 *
 * This does not mount a `RoomChrome`: `App` mounts exactly one, and a second
 * would share and then tear down the first's socket.
 *
 * ## Sound
 *
 * Buttons on this screen play `ui.select` and a refusal plays `ui.deny`. Every
 * cue is a `playRole` call; this file constructs nothing (`../sound/index.ts`).
 * Mute and volume are in cardtable's own settings (`../settings/Settings.tsx`).
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '@wolffm/themes';
import { ROOM_NAME_MAX, ROOM_PASSWORD_MAX, type ConstructedMode } from '@hadoku/shared';

import { navigate } from '../screens/route.ts';
import { tablesClient } from '../screens/tables.ts';
import { openNewMatch } from '../play/live/matchStart.ts';
import { warmRoom } from './warm.ts';
import { roomFeed, type RoomFeed } from './feed.ts';
import { playRole } from '../sound/index.ts';
import {
  clientModeLabel,
  gameTypeLabel,
  roomsClient,
  type FeaturedPick,
  type GameType,
  type RoomView,
  type RoomsClient,
} from './api.ts';
import { Avatar } from '../components/Avatar.tsx';
import { RadioCards } from '../components/RadioCards.tsx';
import { GameTypeRow } from './GameTypeRow.tsx';
import { latestReads } from './latest.ts';
import { freshRoomMode, MODE_CARDS } from '../screens/constructed-mode/ModeRow.tsx';
import { roomCardView } from '../front/roomCard.ts';
import { roomArtId } from '../front/roomArt.ts';
import { cardImageUrl } from '../draft/cardImage.ts';
import { ConstructedIcon, DieIcon, DraftIcon, LockIcon, PersonIcon, StaircaseIcon, SwordsIcon, TrophyIcon } from '../front/icons.tsx';
import { loadRoomFilters, matchesRoomFilters, orderByMatch, saveRoomFilters, type RoomFilters } from '../front/roomFilters.ts';
import { mountTips } from '../play/tip/index.ts';
import { TopLayer } from '../topLayer.tsx';
import './rooms.css';
import { uiLength } from '../settings/ui-scale.ts';

type ListState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; rooms: RoomView[]; stale: string | null };

export interface RoomListProps {
  /** Tests pass a client over a stubbed fetch. Production passes nothing. */
  client?: RoomsClient;
  /** What says the list changed. Tests pass their own; production passes nothing. */
  feed?: RoomFeed;
  /**
   * Told every time a fresh list lands, with the server's own pick for the banner's live slot
   * (`GET /api/rooms`'s `featured`). The list is the one place that already reads this route, so
   * the banner is told rather than fetching its own copy.
   */
  onFeatured?: (pick: FeaturedPick | null) => void;
}

export function RoomList({ client: given, feed = roomFeed(), onFeatured }: RoomListProps) {
  const client = useRef(given ?? roomsClient()).current;
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [creating, setCreating] = useState(false);
  const closeCreate = useCallback((): void => setCreating(false), []);

  /** The viewer's own filters (ruling 6), remembered per-browser; read once, written on every change. */
  const [filters, setFilters] = useState<RoomFilters>(() => loadRoomFilters());
  const setAndSaveFilters = useCallback((next: RoomFilters): void => {
    setFilters(next);
    saveRoomFilters(next);
  }, []);

  /*
   * The ONE surviving tooltip (ruling 11, amended mid-wave by the operator — every other hover tip
   * this screen tried was pulled): a room's name, shown in full ONLY when its own ellipsis is
   * actually truncating it. Drawn by `../play/tip/index.ts`'s own `mountTips` — the board's
   * mechanism, extended to this screen rather than duplicated — into `<TopLayer fixed />` below:
   * fixed, because this list has no board-shaped box of its own to be absolute in, and a card's own
   * `overflow: hidden` (its art) must never clip it.
   */
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = sectionRef.current;
    if (el === null) return undefined;
    return mountTips(el);
  }, []);

  /** The list's reads, latest-wins (`./latest.ts`): this screen writes no list, so a read is kept or dropped. */
  const [reads] = useState(latestReads);

  const refresh = useCallback(async (): Promise<void> => {
    const landed = reads.read();
    try {
      const { rooms, featured } = await client.list();
      if (landed() !== 'keep') return;
      setState({ kind: 'ready', rooms, stale: null });
      onFeatured?.(featured);
    } catch (err) {
      if (landed() !== 'keep') return;
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => (prev.kind === 'ready' ? { ...prev, stale: message } : { kind: 'failed', message }));
    }
  }, [client, reads, onFeatured]);

  useEffect(() => {
    let live = true;
    const stopFollowing = feed.follow('list', () => {
      if (live) void refresh();
    });
    return () => {
      live = false;
      stopFollowing();
    };
  }, [refresh, feed]);

  const retry = (): void => {
    playRole('ui.select');
    setState({ kind: 'loading' });
    void refresh();
  };

  const normal = state.kind === 'ready' ? normalRooms(state.rooms) : [];
  const testing = state.kind === 'ready' ? testingRooms(state.rooms) : [];

  /*
   * Order: a room that matches every filter that is ON sorts ahead of one that does not (ruling 6);
   * within each of those two groups, your own rooms still come first (the ordering this screen
   * always drew, now the secondary key rather than the only one). A room that stops matching is
   * never hidden — `RoomRow` below still draws its buttons, just dimmed (`rooms.css`).
   */
  const matches = (room: RoomView): boolean => matchesRoomFilters(room, roomCardView(room, isMine(room)), filters);
  const mineFirst = (rooms: RoomView[]): RoomView[] => orderByMatch(rooms, isMine);
  const orderedNormal = [...mineFirst(normal.filter(matches)), ...mineFirst(normal.filter((r) => !matches(r)))];

  return (
    <section className="rooms ct-panel" data-testid="rooms" aria-labelledby="rooms-title" ref={sectionRef}>
      <div className="rooms__head">
        <h2 id="rooms-title" className="rooms__title ct-panel__title">
          Rooms
        </h2>
        <RoomFilterBar filters={filters} onChange={setAndSaveFilters} />
        <button
          type="button"
          className="lobby__go"
          data-testid="room-create-open"
          aria-haspopup="dialog"
          onClick={() => {
            playRole('ui.select');
            setCreating(true);
          }}
        >
          Create room
        </button>
      </div>

      {state.kind === 'loading' && (
        <p className="rooms__status" role="status" data-testid="rooms-loading">
          Loading rooms&hellip;
        </p>
      )}

      {state.kind === 'failed' && (
        <div className="rooms__status rooms__status--bad" role="alert" data-testid="rooms-error">
          <p>{state.message}</p>
          <button type="button" data-testid="rooms-retry" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {state.kind === 'ready' && normal.length === 0 && testing.length === 0 && (
        <p className="rooms__status" data-testid="rooms-empty">
          No rooms yet.
        </p>
      )}

      {state.kind === 'ready' && normal.length > 0 && (
        <ul className="rooms__list" data-testid="room-list">
          {orderedNormal.map((room) => (
            <RoomRow key={room.id} room={room} client={client} matchesFilters={matches(room)} onGone={() => void refresh()} />
          ))}
        </ul>
      )}

      {/*
       * Admin only, visible by construction: `GET /rooms` omits every testing
       * room from a non-admin's list entirely (`http/rooms.ts`), so this
       * section is present exactly when the list it was handed carries one —
       * never a client-side tier check. Same row component as the normal
       * list, a separate `<ul>` under its own heading.
       */}
      {state.kind === 'ready' && testing.length > 0 && (
        <div className="rooms__testing" data-testid="rooms-testing">
          <h3 className="rooms__title ct-panel__title">Testing</h3>
          <ul className="rooms__list" data-testid="room-list-testing">
            {testing.map((room) => (
              <RoomRow key={room.id} room={room} client={client} matchesFilters onGone={() => void refresh()} />
            ))}
          </ul>
        </div>
      )}

      {state.kind === 'ready' && state.stale !== null && (
        <p className="rooms__stale" data-testid="rooms-stale">
          List may be out of date.
        </p>
      )}

      {creating && <CreateRoomDialog client={client} onClose={closeCreate} />}
      <TopLayer fixed />
    </section>
  );
}

/* ── filters (ruling 6) ──────────────────────────────────────────────── */

const TYPE_FILTERS: ReadonlyArray<{ value: 'draft' | 'constructed'; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'constructed', label: 'Constructed' },
];
const KIND_FILTERS: ReadonlyArray<{ value: 'tournament' | 'duel'; label: string }> = [
  { value: 'tournament', label: 'Tournament' },
  { value: 'duel', label: 'Duel' },
];

/** A [Draft|Constructed] pair, a [Not full] toggle and a [Tournament|Duel] pair — beside "Rooms". */
function RoomFilterBar({ filters, onChange }: { filters: RoomFilters; onChange: (next: RoomFilters) => void }) {
  const toggle = (next: RoomFilters): void => {
    playRole('ui.select');
    onChange(next);
  };
  return (
    <div className="room-filters">
      <div className="room-filters__group" role="group" aria-label="Room type">
        {TYPE_FILTERS.map((f) => {
          const on = filters.type === f.value;
          return (
            <button
              key={f.value}
              type="button"
              className="room-filters__btn"
              aria-pressed={on}
              data-testid={`room-filter-type-${f.value}`}
              onClick={() => toggle({ ...filters, type: on ? null : f.value })}
            >
              {f.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="room-filters__btn room-filters__btn--standalone"
        aria-pressed={filters.notFull}
        data-testid="room-filter-not-full"
        onClick={() => toggle({ ...filters, notFull: !filters.notFull })}
      >
        Not full
      </button>
      <div className="room-filters__group" role="group" aria-label="Kind">
        {KIND_FILTERS.map((f) => {
          const on = filters.kind === f.value;
          return (
            <button
              key={f.value}
              type="button"
              className="room-filters__btn"
              aria-pressed={on}
              data-testid={`room-filter-kind-${f.value}`}
              onClick={() => toggle({ ...filters, kind: on ? null : f.value })}
            >
              {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── one row ─────────────────────────────────────────────────────────── */

/** Whether I am a member: closing the tab never leaves a room, so this is where I come back to. */
const isMine = (room: RoomView): boolean => room.members.some((m) => m.id === room.you.id);

/** Every room this list carries that is NOT a seeded testing room — the list the front page's normal section draws. */
const normalRooms = (rooms: RoomView[]): RoomView[] => rooms.filter((r) => !r.testing);

/** A seeded testing room, its own section, in the list's own order. Empty for every non-admin: the server never sends one. */
const testingRooms = (rooms: RoomView[]): RoomView[] => rooms.filter((r) => r.testing);

function RoomRow({
  room,
  client,
  matchesFilters,
  onGone,
}: {
  room: RoomView;
  client: RoomsClient;
  /** Whether this room matches every filter that is ON — dims the card when it does not (ruling 6). */
  matchesFilters: boolean;
  onGone: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artLoaded, setArtLoaded] = useState(false);

  /*
   * The name's own tooltip shows only when the name is actually clipped by its ellipsis — an
   * untruncated name shows nothing (ruling 11, amended). `scrollWidth > clientWidth` is the
   * standard overflow test; a `ResizeObserver` re-checks it whenever the card's own width changes
   * (a narrower viewport, the browser's own zoom), not only once at mount.
   */
  const nameRef = useRef<HTMLSpanElement>(null);
  const [nameTruncated, setNameTruncated] = useState(false);
  useEffect(() => {
    const el = nameRef.current;
    // No `ResizeObserver` in a test DOM (`zone-box.ts`'s own comment: "there is no layout to
    // measure either") — `nameTruncated` just stays `false` there, same as an untruncated name.
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const check = (): void => setNameTruncated(el.scrollWidth > el.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [room.name]);

  const enter = async (withPassword?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const outcome = await client.join(room.id, withPassword);
    if (outcome.ok && room.scenario !== undefined && room.pod === null) {
      // A board-state room (no pod: a tournament's board is its round's table) opens on its game, the one already running or a new one against the AI.
      const started = await tablesClient().startVsBot(room.id);
      if (started.ok) {
        openNewMatch(started.matchId);
        return;
      }
    }
    if (outcome.ok) {
      // Still busy: the room is read before it is shown, so it opens drawn.
      await warmRoom(outcome.room);
      setBusy(false);
      navigate({ kind: 'room', roomId: outcome.room.id });
      return;
    }
    setBusy(false);
    // Every arm below is a refusal, and `deny` is the cue for exactly that —
    // the one sound in the vocabulary that means "no". Raised once, here, rather
    // than in each arm, so a new failure reason cannot arrive without it.
    playRole('ui.deny');
    switch (outcome.reason) {
      case 'refused':
        setError(
          room.locked
            ? 'No room with that name and password.'
            : 'No such room.',
        );
        onGone();
        return;
      case 'rate-limited':
        setError('Too many attempts.');
        return;
      case 'error':
        setError(outcome.message);
    }
  };

  const onEnterClick = (): void => {
    // `select` for the press itself, whichever branch it takes: opening the
    // password prompt is a thing that happened, and a button that is silent
    // half the time reads as a button that did not work.
    playRole('ui.select');
    // A member is already in: the server waives the password for them, so it is not asked.
    if (room.locked && !isMine(room)) {
      setAsking(true);
      setError(null);
      return;
    }
    void enter();
  };

  /** A seeded testing room, reset where it is listed: the server closes it and seeds it fresh. */
  const onResetClick = async (): Promise<void> => {
    playRole('ui.select');
    setBusy(true);
    setError(null);
    const outcome = await client.reset(room.id);
    setBusy(false);
    if (!outcome.ok) {
      playRole('ui.deny');
      setError(outcome.message);
    }
    onGone();
  };

  const onPassword = (e: FormEvent): void => {
    e.preventDefault();
    if (password === '') {
      playRole('ui.deny');
      setError('Password required.');
      return;
    }
    playRole('ui.select');
    void enter(password);
  };

  const names = room.members.map((m) => m.name);
  const view = roomCardView(room, isMine(room));
  const artId = roomArtId(room);
  const artUrl = artId === undefined ? null : cardImageUrl(artId);

  return (
    <li
      className="room-card"
      data-testid="room-row"
      data-room-id={room.id}
      data-mine={isMine(room) ? '' : undefined}
      data-match={matchesFilters ? undefined : 'false'}
    >
      {/* Art behind the card, with a dark gradient wash under the info (`rooms.css`): a lookup, never
          a URL (`../front/roomArt.ts`). It never delays the card — the text draws first, and the
          image fades in once it has actually decoded. */}
      {artUrl !== null && (
        <span className="room-card__art" aria-hidden="true">
          <img
            className={artLoaded ? 'room-card__art-img room-card__art-img--loaded' : 'room-card__art-img'}
            src={artUrl}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setArtLoaded(true)}
            onError={() => setArtLoaded(false)}
          />
        </span>
      )}
      <div className="room-card__body">
        {/* Row 1: type, name, trophy, seats — one line, never wraps (ruling 1). The lock (ruling 8,
            amended by the operator mid-wave) is no longer here: it leads the primary button, row 4.
            No tooltips here (the operator, mid-wave: "i hate all the tooltips, they all seem
            useless") — the icons keep only their own `aria-label` for a screen reader, invisible
            otherwise. The one survivor is the name's own, and only when it is actually truncated. */}
        <div className="room-card__row1">
          <span className="room-card__type-icon" aria-hidden="true">
            {room.gameType === 'draft' ? <DraftIcon /> : <ConstructedIcon />}
          </span>
          <span
            ref={nameRef}
            className="room-card__name"
            data-testid="room-name"
            data-tip={nameTruncated ? room.name : undefined}
            tabIndex={nameTruncated ? 0 : undefined}
          >
            {room.name}
          </span>
          {view.tournament && (
            <span className="room-card__trophy">
              <TrophyIcon />
            </span>
          )}
          <span className="room-card__seats" data-testid="room-seats">
            <PersonIcon />
            {view.seatsFilled}/{view.seatsCapacity}
          </span>
        </div>

        {/* Row 2: the mode chip (or a draft's cube), then Bo1/Bo3. */}
        <div className="room-card__row2">
          <span className="room-card__mode-chip" data-testid="room-mode-chip">
            {view.mode.icon === 'classic' && <SwordsIcon />}
            {view.mode.icon === 'gauntlet' && <StaircaseIcon />}
            {view.mode.icon === 'random' && <DieIcon />}
            <span className="room-card__mode-text">{view.mode.text}</span>
          </span>
          {view.series !== null && <span className="room-card__series-chip">{view.series}</span>}
        </div>

        {/* Row 3: the state pill and its one detail, on the same row (ruling 4), the detail ellipsised. */}
        <div className="room-card__row3">
          <span className="room-card__state" data-testid="room-state" data-state={view.state.key}>
            <span className="room-card__dot" aria-hidden="true" />
            {view.state.label}
          </span>
          {view.state.detail !== null && <span className="room-card__state-detail">{view.state.detail}</span>}
        </div>

        {/* The room's own details: still the exact words a streamed or already-dealt room always said. */}
        <div className="rooms__meta room-card__legacy">
          <span className="rooms__sr" data-testid="room-type">
            {gameTypeLabel(room.gameType)}
          </span>
          {/* Only on a streamed room (the operator, 2026-10-10): the form makes
              nothing but our table now, so the label is said where it is the
              exception, not on every row. */}
          {room.clientMode === 'streamed' && (
            <span className="rooms__mode" data-testid="room-mode" data-mode={room.clientMode}>
              {clientModeLabel(room.clientMode)}
            </span>
          )}
          {room.matchId !== null && (
            <span className="rooms__playing" data-testid="room-playing">
              playing
            </span>
          )}
          {/* A draft room whose pod has been dealt. Without this the row is
              identical to one still sitting in its lobby, and Enter would take
              you to a pack instead of a Ready button with nothing to explain
              the difference. A late arrival is welcome — they evict a bot — so
              this is a label, not a closed door. */}
          {room.draftStartedAt !== null && (
            <span className="rooms__playing" data-testid="room-drafting">
              drafting
            </span>
          )}
        </div>

        {/* The roster, for a screen reader only: the seats count (row 1) is what the card shows, and the
            operator cut the visible names line (2026-10-27) — the card is four rows. */}
        <span className="rooms__members rooms__sr" data-testid="room-members">
          {/* A face per member who HAS one, and nothing at all for a member who
              does not — never a placeholder square, because a row of identical
              squares says less than the names already beside them. */}
          {room.members.map((m) => (
            <Avatar key={m.id} id={m.avatarId} fallback="none" className="rooms__face" data-testid="room-face" data-avatar-id={m.avatarId} title={m.name} width={18} height={18} loading="lazy" />
          ))}
          {names.join(', ')}
        </span>

        {/* Row 4: the way in, chosen by state — Sit down, Join or Watch — plus a second Watch when a game is on.
            A password-protected room (ruling 8, amended mid-wave by the operator): the lock glyph leads the
            PRIMARY button's own label, inside it, rather than sitting in the title row. */}
        <div className="room-card__row4">
        {!asking && (
          <button
            type="button"
            className="rooms__enter room-card__go"
            data-testid="room-enter"
            aria-label={`${view.primaryAction} ${room.name}`}
            disabled={busy}
            onClick={onEnterClick}
          >
            {room.locked && (
              <span className="room-card__lock" data-testid="room-locked" aria-hidden="true">
                <LockIcon />
              </span>
            )}
            {view.primaryAction}
          </button>
        )}

        {!asking && view.extraWatch && (
          <button type="button" className="rooms__enter room-card__go room-card__go--watch" data-testid="room-watch" aria-label={`Watch ${room.name}`} disabled={busy} onClick={onEnterClick}>
            Watch
          </button>
        )}

        {!asking && room.testing && (
          <button type="button" className="rooms__enter" data-testid="room-reset" aria-label={`Reset ${room.name}`} disabled={busy} onClick={() => void onResetClick()}>
            Reset
          </button>
        )}
      </div>

      {asking && (
        <form className="rooms__password" onSubmit={onPassword}>
          <label htmlFor={`room-password-${room.id}`}>Password for {room.name}</label>
          <input
            id={`room-password-${room.id}`}
            data-testid="room-password"
            type="password"
            maxLength={ROOM_PASSWORD_MAX}
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
          />
          <button type="submit" data-testid="room-password-submit" aria-label={`Enter ${room.name}`} disabled={busy}>
            Enter
          </button>
          <button
            type="button"
            className="rooms__cancel"
            onClick={() => {
              setAsking(false);
              setPassword('');
              setError(null);
            }}
          >
            Cancel
          </button>
        </form>
      )}

      {error !== null && (
        <p className="ct-error rooms__error" role="alert" data-testid="room-join-error">
          {error}
        </p>
      )}
      </div>
    </li>
  );
}

/* ── create ──────────────────────────────────────────────────────────── */

/**
 * The create form, as a modal over the list. Escape, the close button and a
 * press on the backdrop close it; the name field has the focus when it opens.
 */
function CreateRoomDialog({ client, onClose }: { client: RoomsClient; onClose: () => void }) {
  const [name, setName] = useState('');
  const [gameType, setGameType] = useState<GameType>('constructed-1v1');
  /** Optional: a Constructed room created with none asks its leader first. */
  const [mode, setMode] = useState<ConstructedMode | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      playRole('ui.deny');
      setError('Name required.');
      return;
    }
    playRole('ui.select');
    setBusy(true);
    setError(null);
    const outcome = await client.create({
      name: trimmed,
      gameType,
      clientMode: 'builtin',
      password,
      ...(gameType === 'constructed-1v1' && mode !== null ? { mode: freshRoomMode(mode) } : {}),
    });
    if (!outcome.ok) {
      setBusy(false);
      playRole('ui.deny');
      setError(outcome.message);
      return;
    }
    // Still busy: the new room is read before it is shown, so it opens drawn
    // rather than filling in piece by piece (`warm.ts`).
    await warmRoom(outcome.room);
    setBusy(false);
    navigate({ kind: 'room', roomId: outcome.room.id });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.document?.addEventListener('keydown', onKey);
    return () => globalThis.document?.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="rooms__backdrop"
      data-testid="room-create-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="rooms__create ct-surface ct-panel"
        data-testid="room-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-create-title"
        // Firefox's form history obeys "off" only on the form (FormHistoryChild.sys.mjs), so past
        // room names are never offered; the name's own token below keeps the password manager off.
        autoComplete="off"
        onSubmit={(e) => void submit(e)}
      >
        <div className="rooms__create-head">
          <h3 id="room-create-title">Create a room</h3>
          <button type="button" className="rooms__create-close" aria-label="Close" data-testid="room-create-close" onClick={onClose}>
            <Icon name="close" size={uiLength('1rem')} />
          </button>
        </div>

        <label htmlFor="room-create-name">Name</label>
        <input
          id="room-create-name"
          data-testid="room-create-name"
          value={name}
          maxLength={ROOM_NAME_MAX}
          placeholder="Friday night"
          // Firefox counts a text field before a password field as the username when its token is
          // empty, on, off, username, email or tel (LoginManager.shared.sys.mjs); any other opts it out.
          autoComplete="nickname"
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />

        <span className="rooms__caption">Game type</span>
        <GameTypeRow testId="room-create-type" value={gameType} onChange={setGameType} />

        {gameType === 'constructed-1v1' && (
          <>
            <span className="rooms__caption">Mode (optional)</span>
            <RadioCards
              name="room-create-constructed-mode"
              label="Mode"
              options={MODE_CARDS}
              value={mode}
              onChange={setMode}
              testId="room-create-constructed-mode"
            />
          </>
        )}

        <label htmlFor="room-create-password">Password (optional)</label>
        <input
          id="room-create-password"
          data-testid="room-create-password"
          type="password"
          maxLength={ROOM_PASSWORD_MAX}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="lobby__go" data-testid="room-create-submit" disabled={busy}>
          Create room
        </button>

        {error !== null && (
          <p className="ct-error rooms__error" role="alert" data-testid="room-create-error">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
