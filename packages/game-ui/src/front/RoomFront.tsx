/*
 * The front-page module, settled for every game cardtable or another site hosts (wave 120 §F; the
 * contract is frozen in `docs/planning/wave120-2026-11-17.md` — bomberman's own wave `bm1` consumes
 * this from npmjs the moment it publishes, so its exported names and prop shapes may not drift
 * without the tracker's say).
 *
 * This is the generic list/filter/sort/follow/create-dialog machinery that used to live, entangled
 * with Magic's own fields, in `games/magic/ui/src/rooms/RoomList.tsx` (`RoomRow` and
 * `CreateRoomDialog`). What is Magic's stays Magic's: the mode chip's icon, the room's background
 * scene, the trophy, the series chip and the "legacy" streamed-client line are all drawn by
 * `rowExtras`; a game's own create-form fields (and a wholly different creation, such as Magic's
 * Challenge) are drawn and may be submitted by `createFields`. A room arrives here already carrying
 * its own computed `view` (seats, state, the primary action) — that derivation is a game's own (a
 * pod's phase, a table's series), never this file's.
 *
 * Platform: imports nothing from `@hadoku/magic-ui`, any `games/**` package, or `@hadoku/shared`
 * (the layer ratchet resolves that package as Magic even through `/platform`, bar the handful of
 * files it whitelists itself). No CSS is imported here either: a caller's own stylesheet draws these
 * classes (cardtable's `games/magic/ui/src/rooms/rooms.css`, unmoved, still does for cardtable's own
 * app) — the DOM this file emits is exactly the markup `rooms.css` was already written against.
 */

import { useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '@wolffm/themes';

import { Avatar, faceOf } from '../components/Avatar.tsx';
import { OverPage } from '../components/OverPage.tsx';
import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';
import { TopLayer } from '../topLayer.tsx';
import { uiLength } from '@hadoku/ui-shell/settings';
import { Reveal } from '@hadoku/ui-shell/components';
import { FrontGateContext, usePartShown } from './gate.ts';
import { MAX_ROOM_GHOSTS } from './shape.ts';
import { ConstructedIcon, LockIcon, PersonIcon } from './icons.tsx';
import { useWhoami } from '../room/whoami.ts';
import { playRole } from '../sound/index.ts';
import type { Look } from '@hadoku/platform-wire/look';

/* ── the generic room shape ──────────────────────────────────────────── */

export interface RoomFrontMember {
  id: string;
  name: string;
  avatarId?: string;
  /** Their picture and cosmetics: drawn instead of the character, as chat and the seats draw them. */
  look?: Look;
}

/** Every number and label a row draws besides its name, its lock and its roster — a game's own derivation, computed before the room reaches this file. */
export interface RoomFrontView {
  seatsFilled: number;
  seatsCapacity: number;
  state: { key: string; label: string; detail: string | null };
  primaryAction: 'Join' | 'Watch';
  /** A second, explicit Watch beside the primary action (the room is in progress, say). */
  extraWatch: boolean;
}

export interface RoomFrontRoom {
  id: string;
  name: string;
  gameType: string;
  locked: boolean;
  /** An admin-seeded testing room: its own section, folded by default preference, never sent to a non-admin at all. */
  testing?: boolean;
  members: readonly RoomFrontMember[];
  you: { id: string };
  view: RoomFrontView;
}

export type RoomFrontJoinOutcome<V> =
  | { ok: true; room: V }
  | { ok: false; reason: 'refused' }
  | { ok: false; reason: 'rate-limited' }
  | { ok: false; reason: 'error'; message: string };

export type RoomFrontCreateOutcome<V> = { ok: true; room: V } | { ok: false; message: string };

/** A client over game-server's generic room routes (`GET/POST /api/rooms`, the room view as `room-core.ts` answers it) — no Magic types. */
export interface RoomFrontClient<V extends RoomFrontRoom> {
  list(): Promise<{ rooms: readonly V[] }>;
  create(body: Record<string, unknown> & { name: string; gameType: string }): Promise<RoomFrontCreateOutcome<V>>;
  join(roomId: string, password?: string): Promise<RoomFrontJoinOutcome<V>>;
  /** An admin's reset of a seeded testing room; omitted when a caller offers no testing rooms at all. */
  reset?(roomId: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

/** What says the list changed, without polling it (`games/magic/ui/src/rooms/follow.ts`'s shape). Defaults to reading once and never again. */
export interface RoomFrontFeed {
  follow(target: string, refresh: () => void): () => void;
}

const NEVER_FOLLOWED: RoomFrontFeed = {
  follow(_target, refresh) {
    refresh();
    return () => undefined;
  },
};

export interface RoomFrontGameType {
  id: string;
  label: string;
}

export interface RoomFrontCreateSlot {
  node?: ReactNode;
  /**
   * Takes over this kind's whole creation — a wholly different write than the generic
   * `rooms.create()` (Magic's Challenge, say, which is whole-born from an event rather than named
   * and typed). When set, the generic name field and the generic POST are both skipped for this kind.
   */
  submit?: () => Promise<RoomFrontCreateOutcome<never>>;
  /** No generic name field for this kind (set together with `submit` for a whole-born kind). */
  nameless?: boolean;
  /** The submit button stays disabled until this is true (default true — ready at once). */
  ready?: boolean;
  /** Extra fields merged into the generic POST body, alongside `name` and `gameType` (ignored when `submit` is set). */
  body?: Record<string, unknown>;
}

export interface RoomFrontRowExtras {
  /** The room's own background scene, large and faint behind the row's info. */
  scene?: ReactNode;
  /** The room's own type glyph, beside its name. */
  typeIcon?: ReactNode;
  trophy?: ReactNode;
  modeChip?: ReactNode;
  seriesChip?: ReactNode;
  /** The row's trailing, screen-reader-mostly line (a streamed client's own label, say). */
  legacyMeta?: ReactNode;
  /** `data-family` on the row — which background gradient it draws (`rooms.css`). */
  family?: string;
}

export interface RoomFrontProps<V extends RoomFrontRoom> {
  rooms: RoomFrontClient<V>;
  /** The create form's own radio: every type a caller may make, id and label, at least one. With only one, no radio is drawn. */
  gameTypes: readonly RoomFrontGameType[];
  createFields?: (kind: string) => RoomFrontCreateSlot | null;
  rowExtras?: (room: V) => RoomFrontRowExtras;
  /** A Twitch-like banner above the list — omitted draws none of its markup (no wrapper element). */
  banner?: ReactNode;
  /** The header's own tools row — omitted draws no `<nav>` at all. */
  navTools?: ReactNode;
  /** A slot beside `banner`, for a caller with no fused banner of its own — omitted draws nothing. */
  featured?: ReactNode;
  onOpenRoom: (id: string) => void;
  /** Extra content in the list's own head row, beside the title and before Create room (a game's own filter bar, say). */
  headExtras?: ReactNode;
  /** Extra content beside Create room, in the same actions group (a game's own "Create event", say). */
  actionsExtras?: ReactNode;
  feed?: RoomFrontFeed;
  /**
   * Whether `room` matches every filter the caller is tracking that is currently ON — recomputed
   * fresh every render (a filter toggle lives in the caller's own state, outside this list's own),
   * never baked into a room at the time it was read. Rooms are never hidden by a filter, only
   * sorted and dimmed: unset or always-true never dims anything.
   */
  matches?: (room: V) => boolean;
  /**
   * A chance to do something other than `onOpenRoom` once a room is freshly joined or created (Magic
   * starts a scenario room against the AI directly, say, rather than opening the room screen for it).
   * `true`: handled, `onOpenRoom` is skipped for this one.
   */
  beforeOpenRoom?: (room: V) => Promise<boolean> | boolean;
  nameMaxLength?: number;
  passwordMaxLength?: number;
  /** The key `localStorage` remembers the Testing section's fold under. A caller with no testing rooms never reads it. */
  testingStorageKey?: string;
  /**
   * The create form's name field starts prefilled with this (the viewer's own name, from the
   * platform's own `useWhoami`, and a fresh random draw, so a word drawn once per opening) rather
   * than empty. `viewerName` is `null` until the fleet has answered or has none for this viewer.
   */
  defaultName?: (viewerName: string | null, random: () => number) => string;
  /** The list's own `<section>`, the moment it mounts and again on unmount — a caller's own tooltip or scroll mechanism attaches here, same as it would to any other section it owns. */
  onSectionRef?: (el: HTMLElement | null) => void;
  /**
   * The create dialog's own panel class (default: an unstyled block of this module's own,
   * `room-front-create`). A caller with its own "raised surface" convention supplies its exact
   * class string here rather than this file hard-coding one — Magic's `RoomList.tsx` passes
   * `"rooms__create ct-surface ct-panel"`, the same classes base's own `CreateRoomDialog` always
   * drew, from the one file (`RoomList.tsx`, through `CreateEventDialog.tsx`'s own import of
   * `Modal.tsx`) `css-ownership.test.ts` already knows reaches the tree that owns `.ct-surface` —
   * this module never does, and must not have to.
   *
   * Named `createPanelClassName`, not the bare `className` an earlier draft of this prop used
   * (`docs/planning/s3-2026-11-17.md` §G.5): a plain `className` on a component that is not a
   * simple DOM wrapper reads as "the root element's own class", when this is actually one nested
   * CREATE DIALOG panel's — a different, narrower thing a careless caller could otherwise pass
   * believing it styled the whole list. `css-ownership.test.ts`'s own "is this really a class
   * list" check (`CLASS_AT`) used to recognise ONLY a literal sitting right after a bare
   * `className=`/`class=`, which is exactly why that draft kept the confusing name — any camelCase
   * prefix broke the check. `CLASS_AT` now also matches `\w*ClassName=` generically, so a
   * caller's own call-site literal (`<RoomFront createPanelClassName="rooms__create ct-surface
   * ct-panel" />`) is still recognised as a real class list, the same as a bare `className=` is.
   */
  createPanelClassName?: string;
}

type ListState<V> =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; rooms: readonly V[]; stale: string | null };

const DEFAULT_NAME_MAX = 60;
const DEFAULT_PASSWORD_MAX = 200;
const DEFAULT_TESTING_KEY = 'room-front.testingFolded';

/**
 * Whether `node` is one of React's own "renders nothing" values — `null`, `undefined`, `false`,
 * `''`, or an array holding only such values — rather than merely `!== undefined`. The settled
 * contract's own words: "empty or absent renders nothing (no wrapper element)" for `banner`,
 * `navTools` and `featured` — `undefined` is one way a caller omits a slot, but `null`, `false`
 * and `[]` are the others a caller passes when it computes the slot conditionally (`cond && <X/>`,
 * or `cond ? <X/> : null`), and each must draw no wrapper of its own either.
 */
function isRenderable(node: ReactNode): boolean {
  if (node === null || node === undefined || node === false || node === '') return false;
  if (Array.isArray(node)) return node.some(isRenderable);
  return true;
}

/** Whether the viewer is already a member — a room never hides its own occupant's name from them. */
const isMine = <V extends RoomFrontRoom>(room: V): boolean => room.members.some((m) => m.id === room.you.id);

const normalRooms = <V extends RoomFrontRoom>(rooms: readonly V[]): V[] => rooms.filter((r) => r.testing !== true);
const testingRooms = <V extends RoomFrontRoom>(rooms: readonly V[]): V[] => rooms.filter((r) => r.testing === true);

/** `rooms`, with every matching one (by `matches`) moved ahead of every room that is not — a stable partition. */
function orderByMatch<T>(rooms: readonly T[], matches: (room: T) => boolean): T[] {
  return [...rooms.filter(matches), ...rooms.filter((r) => !matches(r))];
}

function loadTestingFolded(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function saveTestingFolded(key: string, folded: boolean): void {
  try {
    if (folded) globalThis.localStorage?.setItem(key, '1');
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Unremembered is the whole fallback; nothing else to do.
  }
}

export function RoomFront<V extends RoomFrontRoom>({
  rooms: client,
  gameTypes,
  createFields,
  rowExtras,
  banner,
  navTools,
  featured,
  onOpenRoom,
  headExtras,
  actionsExtras,
  feed = NEVER_FOLLOWED,
  matches: matchesFilter,
  beforeOpenRoom,
  nameMaxLength = DEFAULT_NAME_MAX,
  passwordMaxLength = DEFAULT_PASSWORD_MAX,
  testingStorageKey = DEFAULT_TESTING_KEY,
  defaultName,
  onSectionRef,
  createPanelClassName: createSurfaceClassName = 'room-front-create',
}: RoomFrontProps<V>) {
  const [state, setState] = useState<ListState<V>>({ kind: 'loading' });
  const [creating, setCreating] = useState(false);
  const [testingFolded, setTestingFolded] = useState<boolean>(() => loadTestingFolded(testingStorageKey));
  const toggleTesting = (): void => {
    playRole('ui.select');
    setTestingFolded((was) => {
      saveTestingFolded(testingStorageKey, !was);
      return !was;
    });
  };

  // Latest-wins: a read the server answers after a newer one has already landed changes nothing —
  // never an older list overwriting a newer one, and never a late failure marking a fresh list stale.
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const gen = ++generation.current;
    try {
      const { rooms: next } = await client.list();
      if (gen !== generation.current) return;
      setState({ kind: 'ready', rooms: next, stale: null });
    } catch (err) {
      if (gen !== generation.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => (prev.kind === 'ready' ? { ...prev, stale: message } : { kind: 'failed', message }));
    }
  }, [client]);

  useEffect(() => {
    let live = true;
    const stop = feed.follow('list', () => {
      if (live) void refresh();
    });
    return () => {
      live = false;
      stop();
    };
  }, [refresh, feed]);

  const retry = (): void => {
    playRole('ui.select');
    setState({ kind: 'loading' });
    void refresh();
  };

  const normal = state.kind === 'ready' ? normalRooms(state.rooms) : [];
  const testing = state.kind === 'ready' ? testingRooms(state.rooms) : [];
  const matches = (room: V): boolean => matchesFilter?.(room) ?? true;
  const ordered = (list: readonly V[]): V[] => orderByMatch(orderByMatch(list, isMine), matches);
  const orderedNormal = ordered(normal);
  const orderedTesting = ordered(testing);

  const { shape, remember } = useContext(FrontGateContext);
  const shown = usePartShown('rooms', state.kind !== 'loading');
  const drawnRooms = state.kind === 'ready' ? Math.min(normal.length, MAX_ROOM_GHOSTS) : null;
  useEffect(() => {
    if (drawnRooms !== null) remember({ rooms: drawnRooms });
  }, [drawnRooms, remember]);

  return (
    <>
      {isRenderable(navTools) && <nav className="shell__tools">{navTools}</nav>}
      {isRenderable(featured) && featured}
      {isRenderable(banner) && banner}
      <section className="rooms ct-panel" data-testid="rooms" aria-labelledby="rooms-title" aria-busy={!shown} ref={onSectionRef}>
        <div className="rooms__head">
          <h2 id="rooms-title" className="rooms__title ct-panel__title">
            Rooms
          </h2>
          {headExtras}
          <span className="rooms__actions">
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
            {actionsExtras}
          </span>
        </div>

        <Reveal name="rooms" shown={shown} skeleton={<RoomGhosts count={shape.rooms} />} layerClassName="rooms__layer">
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
                <RoomRow key={room.id} room={room} client={client} rowExtras={rowExtras} matches={matches} onGone={() => void refresh()} onOpenRoom={onOpenRoom} beforeOpenRoom={beforeOpenRoom} passwordMaxLength={passwordMaxLength} />
              ))}
            </ul>
          )}

          {state.kind === 'ready' && testing.length > 0 && (
            <div className="rooms__testing" data-testid="rooms-testing">
              <h3 className="rooms__title ct-panel__title">
                <button
                  type="button"
                  className="rooms__fold"
                  aria-expanded={!testingFolded}
                  aria-controls="room-list-testing"
                  data-testid="rooms-testing-fold"
                  onClick={toggleTesting}
                >
                  <svg className="rooms__fold-chevron" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                  Testing
                </button>
              </h3>
              {!testingFolded && (
                <ul className="rooms__list" id="room-list-testing" data-testid="room-list-testing">
                  {orderedTesting.map((room) => (
                    <RoomRow key={room.id} room={room} client={client} rowExtras={rowExtras} matches={matches} onGone={() => void refresh()} onOpenRoom={onOpenRoom} beforeOpenRoom={beforeOpenRoom} passwordMaxLength={passwordMaxLength} />
                  ))}
                </ul>
              )}
            </div>
          )}

          {state.kind === 'ready' && state.stale !== null && (
            <p className="rooms__stale" data-testid="rooms-stale">
              List may be out of date.
            </p>
          )}
        </Reveal>

        {creating && (
          <CreateRoomDialog
            client={client}
            gameTypes={gameTypes}
            createFields={createFields}
            onClose={() => setCreating(false)}
            onOpenRoom={onOpenRoom}
            beforeOpenRoom={beforeOpenRoom}
            nameMaxLength={nameMaxLength}
            defaultName={defaultName}
            surfaceClassName={createSurfaceClassName}
          />
        )}
        <TopLayer fixed />
      </section>
    </>
  );
}

/* ── until the list arrives ─────────────────────────────────────────── */

function RoomGhosts({ count }: { count: number }) {
  if (count === 0) {
    return (
      <p className="rooms__status" data-testid="rooms-loading">
        <span className="ghost ghost--text">No rooms yet.</span>
      </p>
    );
  }
  return (
    <ul className="rooms__list" data-testid="rooms-loading">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="room-card" data-skeleton={`room-${i}`}>
          <div className="room-card__body">
            <div className="room-card__row1">
              <span className="room-card__type-icon ghost">
                <ConstructedIcon />
              </span>
              <span className="room-card__name">
                <span className="ghost ghost--text">A room&apos;s name</span>
              </span>
              <span className="room-card__seats ghost">
                <PersonIcon />
                0/2
              </span>
            </div>
            <div className="room-card__row2">
              <span className="room-card__mode-chip ghost">
                <span className="room-card__mode-text">Mode unset</span>
              </span>
              <span className="room-card__series-chip ghost">Bo1</span>
            </div>
            <div className="room-card__row3">
              <span className="room-card__state ghost">Lobby</span>
              <span className="room-card__state-detail">
                <span className="ghost ghost--text">Waiting for players</span>
              </span>
            </div>
            <div className="room-card__row4">
              <button type="button" className="rooms__enter room-card__go ghost" tabIndex={-1} disabled>
                Join
              </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ── one row ─────────────────────────────────────────────────────────── */

function RoomRow<V extends RoomFrontRoom>({
  room,
  client,
  rowExtras,
  matches,
  onGone,
  onOpenRoom,
  beforeOpenRoom,
  passwordMaxLength,
}: {
  room: V;
  client: RoomFrontClient<V>;
  rowExtras?: (room: V) => RoomFrontRowExtras;
  matches: (room: V) => boolean;
  onGone: () => void;
  onOpenRoom: (id: string) => void;
  beforeOpenRoom?: (room: V) => Promise<boolean> | boolean;
  passwordMaxLength: number;
}) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLSpanElement>(null);
  const [nameTruncated, setNameTruncated] = useState(false);
  useEffect(() => {
    const el = nameRef.current;
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
    if (outcome.ok) {
      // Still busy: the room is warmed (and a scenario's vs-bot start tried) before this row ever
      // reconsiders it, so the button never flashes "not busy" between the join and leaving the page.
      const handled = beforeOpenRoom === undefined ? false : await beforeOpenRoom(outcome.room);
      setBusy(false);
      if (!handled) onOpenRoom(outcome.room.id);
      return;
    }
    setBusy(false);
    // Every arm below is a refusal, and `deny` is the cue for exactly that — raised once, here,
    // rather than in each arm, so a new failure reason cannot arrive without it.
    playRole('ui.deny');
    switch (outcome.reason) {
      case 'refused':
        setError(room.locked ? 'No room with that name and password.' : 'No such room.');
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
    // `select` for the press itself, whichever branch it takes.
    playRole('ui.select');
    if (room.locked && !isMine(room)) {
      setAsking(true);
      setError(null);
      return;
    }
    void enter();
  };

  const onResetClick = async (): Promise<void> => {
    if (client.reset === undefined) return;
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
  const view = room.view;
  const extras = rowExtras?.(room) ?? {};

  return (
    <li
      className="room-card"
      data-testid="room-row"
      data-room-id={room.id}
      data-mine={isMine(room) ? '' : undefined}
      data-match={matches(room) ? undefined : 'false'}
      data-family={extras.family}
    >
      {extras.scene !== undefined && (
        <span className="room-card__mark" aria-hidden="true">
          {extras.scene}
        </span>
      )}
      <div className="room-card__body">
        <div className="room-card__row1">
          {extras.typeIcon !== undefined && (
            <span className="room-card__type-icon" aria-hidden="true">
              {extras.typeIcon}
            </span>
          )}
          <span
            ref={nameRef}
            className="room-card__name"
            data-testid="room-name"
            data-tip={nameTruncated ? room.name : undefined}
            tabIndex={nameTruncated ? 0 : undefined}
          >
            {room.name}
          </span>
          {extras.trophy !== undefined && <span className="room-card__trophy">{extras.trophy}</span>}
          <span className="room-card__seats" data-testid="room-seats">
            <PersonIcon />
            {view.seatsFilled}/{view.seatsCapacity}
          </span>
        </div>

        {(extras.modeChip !== undefined || extras.seriesChip !== undefined) && (
          <div className="room-card__row2">
            {extras.modeChip}
            {extras.seriesChip}
          </div>
        )}

        <div className="room-card__row3">
          <span className="room-card__state" data-testid="room-state" data-state={view.state.key}>
            <span className="room-card__dot" aria-hidden="true" />
            {view.state.label}
          </span>
          {view.state.detail !== null && <span className="room-card__state-detail">{view.state.detail}</span>}
        </div>

        <span className="rooms__members rooms__sr" data-testid="room-members">
          {room.members.map((m) => (
            <Avatar key={m.id} {...faceOf(m)} fallback="none" className="rooms__face" data-testid="room-face" data-avatar-id={m.avatarId} title={m.name} width={18} height={18} loading="lazy" />
          ))}
          {names.join(', ')}
        </span>

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

          {!asking && room.testing === true && client.reset !== undefined && (
            <button type="button" className="rooms__enter room-card__go" data-testid="room-reset" aria-label={`Reset ${room.name}`} disabled={busy} onClick={() => void onResetClick()}>
              Reset
            </button>
          )}

          {extras.legacyMeta !== undefined && <div className="rooms__meta room-card__legacy">{extras.legacyMeta}</div>}
        </div>
      </div>

      {asking && (
        <form className="rooms__password" onSubmit={onPassword}>
          <label htmlFor={`room-password-${room.id}`}>Password for {room.name}</label>
          <input
            id={`room-password-${room.id}`}
            data-testid="room-password"
            type="password"
            maxLength={passwordMaxLength}
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
    </li>
  );
}

/* ── create ──────────────────────────────────────────────────────────── */

function CreateRoomDialog<V extends RoomFrontRoom>({
  client,
  gameTypes,
  createFields,
  onClose,
  onOpenRoom,
  beforeOpenRoom,
  nameMaxLength,
  defaultName,
  surfaceClassName,
}: {
  client: RoomFrontClient<V>;
  gameTypes: readonly RoomFrontGameType[];
  createFields?: (kind: string) => RoomFrontCreateSlot | null;
  onClose: () => void;
  onOpenRoom: (id: string) => void;
  beforeOpenRoom?: (room: V) => Promise<boolean> | boolean;
  nameMaxLength: number;
  defaultName?: (viewerName: string | null, random: () => number) => string;
  surfaceClassName: string;
}) {
  // The word half of the prefill is drawn once per opening (this component remounts fresh each
  // time `creating` turns true) and stays put across re-renders; the viewer's own name half keeps
  // tracking `who` until it resolves, same as the viewer's own name would if typed by hand — except
  // nothing here has been typed yet.
  const who = useWhoami();
  const [draw] = useState(Math.random);
  const [typed, setTyped] = useState<string | null>(null);
  const viewerName = who === 'pending' ? null : (who?.name ?? null);
  const name = typed ?? (who === 'pending' || defaultName === undefined ? '' : defaultName(viewerName, () => draw));
  const [kind, setKind] = useState<string>(gameTypes[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slot = createFields?.(kind) ?? null;
  const nameless = slot?.nameless === true;
  const ready = slot?.ready ?? true;
  // `RadioCards` wants `{ value, label }`; the settled contract wants `{ id, label }` — this is the
  // one place the two meet.
  const kindOptions: readonly RadioCard<string>[] = gameTypes.map((g) => ({ value: g.id, label: g.label }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.document?.addEventListener('keydown', onKey);
    return () => globalThis.document?.removeEventListener('keydown', onKey);
  }, [onClose]);

  const opened = async (outcome: RoomFrontCreateOutcome<V>): Promise<void> => {
    if (!outcome.ok) {
      setBusy(false);
      playRole('ui.deny');
      setError(outcome.message);
      return;
    }
    const handled = beforeOpenRoom === undefined ? false : await beforeOpenRoom(outcome.room);
    setBusy(false);
    if (!handled) onOpenRoom(outcome.room.id);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (slot?.submit !== undefined) {
      playRole('ui.select');
      setBusy(true);
      setError(null);
      await opened(await (slot.submit() as Promise<RoomFrontCreateOutcome<V>>));
      return;
    }
    const trimmed = name.trim();
    if (!nameless && trimmed === '') {
      playRole('ui.deny');
      setError('Name required.');
      return;
    }
    playRole('ui.select');
    setBusy(true);
    setError(null);
    await opened(await client.create({ name: trimmed, gameType: kind, ...(slot?.body ?? {}) }));
  };

  return (
    <OverPage>
      <div
        className="rooms__backdrop"
        data-testid="room-create-backdrop"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <form
          className={surfaceClassName}
          data-testid="room-create"
          role="dialog"
          aria-modal="true"
          aria-labelledby="room-create-title"
          autoComplete="off"
          onSubmit={(e) => void submit(e)}
        >
          <div className="rooms__create-head">
            <h3 id="room-create-title">Create a room</h3>
            <button type="button" className="rooms__create-close" aria-label="Close" data-testid="room-create-close" onClick={onClose}>
              <Icon name="close" size={uiLength('1rem')} />
            </button>
          </div>

          {/* One type is no choice: a game with a single room type asks nothing (the operator, 2026-11-18). */}
          {kindOptions.length > 1 && (
            <>
              <span className="rooms__caption">Game type</span>
              <RadioCards name="room-create-type" label="Game type" options={kindOptions} value={kind} onChange={setKind} testId="room-create-type" />
            </>
          )}

          {!nameless && (
            <>
              <label htmlFor="room-create-name">Name</label>
              <input
                id="room-create-name"
                data-testid="room-create-name"
                value={name}
                maxLength={nameMaxLength}
                placeholder="Friday night"
                autoComplete="nickname"
                autoFocus
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError(null);
                }}
              />
            </>
          )}

          {slot?.node}

          <button type="submit" className="lobby__go" data-testid="room-create-submit" disabled={busy || !ready}>
            Create room
          </button>

          {error !== null && (
            <p className="ct-error rooms__error" role="alert" data-testid="room-create-error">
              {error}
            </p>
          )}
        </form>
      </div>
    </OverPage>
  );
}
