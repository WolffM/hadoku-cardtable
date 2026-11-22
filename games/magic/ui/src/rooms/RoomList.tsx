/*
 * Magic's own composition over the front-page module (`@hadoku/game-ui/front/RoomFront.tsx`, wave
 * 120 §F — the generic list/filter/sort/follow/create-dialog machinery used to live here, entangled
 * with Magic's own fields, as `RoomRow` and `CreateRoomDialog`). This file keeps only what is
 * Magic's: the room's own computed card view (`../front/roomCard.ts`'s `roomCardView`, state/seats/
 * the primary action), its filters (`../front/roomFilters.ts`), its icons and chips (`rowExtras`),
 * its own create-form fields and its Challenge flow, which is a wholly different creation
 * (`createFields`'s `submit` override) rather than one more `gameType`.
 *
 * ## Four states, each with something to do
 *
 *   loading  — the list's skeleton, as many rooms as it drew last visit (`../front/shape.ts`), in
 *              the cards' own markup, crossfaded into the list once the page shows itself
 *              (`../front/gate.ts`); Create room already works
 *   failed   — says why, and offers Retry
 *   empty    — says so, with Create room above it
 *   rooms    — the list
 *
 * ## Freshness
 *
 * Read again whenever the server says a room changed (`@hadoku/game-ui/rooms/feed.ts`), and once when the tab is
 * shown again. A friend's new room shows up without a reload.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { usePrefs } from '@wolffm/prefs-client/react';
import { magicGame, PAGE_EVENT_PATH, type ChallengeEvent } from '@hadoku/shared';

import { apiUrl, sendJson } from '@hadoku/game-ui/http.ts';
import { atLeastFriend, useWhoami } from '@hadoku/game-ui/room/whoami.ts';
import { everyFrame } from '@hadoku/ui-shell/motion';
import { usePageFrames } from './page-frames.ts';
import { navigate } from '@hadoku/game-ui/screens/route.ts';
import {
  RoomFront,
  type RoomFrontClient,
  type RoomFrontCreateOutcome,
  type RoomFrontCreateSlot,
  type RoomFrontGameType,
  type RoomFrontRowExtras,
} from '@hadoku/game-ui/front/RoomFront.tsx';
import { ConstructedIcon, DecksFacingScene, DieIcon, DraftIcon, PodScene, StaircaseIcon, SwordsIcon, TrophyIcon } from '@hadoku/game-ui/front/icons.tsx';
import { tablesClient } from '../screens/tables.ts';
import { openNewMatch } from '../play/live/matchStart.ts';
import { warmRoom } from './warm.ts';
import type { RoomFeed } from '@hadoku/game-ui/rooms/feed.ts';
import { getPlayPrefsClient, PLAY_PREFS_DEFAULTS } from '../play/live/prefs.ts';
import {
  clientModeLabel,
  GAME_TYPES,
  gameTypeLabel,
  roomsClient,
  type CreateRequest,
  type FeaturedPick,
  type RoomView,
  type RoomsClient,
} from './api.ts';
import { NEW_ROOM_FIELDS, RoomFields, roomRequest, type RoomFieldValues } from './RoomFields.tsx';
import { ChallengeFields, firstChoice, type ChallengeChoice } from './ChallengeFields.tsx';
import { CreateEventDialog } from './CreateEventDialog.tsx';
import { roomCardView } from '../front/roomCard.ts';
import { loadRoomFilters, matchesRoomFilters, saveRoomFilters, type RoomFilters } from '../front/roomFilters.ts';
import { defaultRoomName } from './roomName.ts';
import { EXTERNAL_GAMES } from '@hadoku/game-ui/rooms/external-games.tsx';
import { mountTips } from '../play/tip/index.ts';
import { watchScroll } from './scroll-watch.ts';
import { playRole } from '@hadoku/game-ui/sound/index.ts';
import './rooms.css';

export interface RoomListProps {
  /** Tests pass a client over a stubbed fetch. Production passes nothing. */
  client?: RoomsClient;
  /** What says the list changed. Tests pass their own; production passes nothing, and `RoomFront` follows the page's room feed. */
  feed?: RoomFeed;
  /**
   * Told every time a fresh list lands, with the server's own pick for the banner's live slot
   * (`GET /api/rooms`'s `featured`). The list is the one place that already reads this route, so
   * the banner is told rather than fetching its own copy.
   */
  onFeatured?: (pick: FeaturedPick | null) => void;
}

/** The generic shape `RoomFront` draws a row from: every `RoomView` field it needs, plus the card's own numbers. */
type FrontRoom = RoomView & { view: ReturnType<typeof frontView> };

/** Whether I am a member: closing the tab never leaves a room, so this is where I come back to. */
const isMine = (room: RoomView): boolean => room.members.some((m) => m.id === room.you.id);

function frontView(room: RoomView, mine: boolean) {
  const view = roomCardView(room, mine);
  return {
    seatsFilled: view.seatsFilled,
    // A tournament grows past its draft size, so its open seats say nothing: the card counts its players.
    seatsCapacity: view.tournament ? null : view.seatsCapacity,
    state: view.state,
    primaryAction: view.primaryAction,
    extraWatch: view.extraWatch,
  };
}

function toFrontRoom(room: RoomView): FrontRoom {
  return { ...room, view: frontView(room, isMine(room)) };
}

/** `api.ts`'s own `GAME_TYPES` ({ value, label }), as the settled contract's `{ id, label }`. */
const MAGIC_GAME_TYPES: readonly RoomFrontGameType[] = GAME_TYPES.map((g) => ({ id: g.value, label: g.label }));
const CHALLENGE_TYPE: RoomFrontGameType = { id: 'challenge', label: 'Challenge' };

/**
 * `EXTERNAL_GAMES`' own `e2eOnly` entries (`e2e-toy-relay`) are never offered by the create
 * dialog's radio in a real browser: Experimental features is a per-MEMBER preference, so "gated
 * on `CARDTABLE_EXPERIMENTAL_GAMES` server-side" alone still lets any member who turns it on see
 * a fake game type in prod. `window.__cardtableE2eToyGames` is the one escape, set by
 * `e2e/external-game-room.spec.ts`'s own `context.addInitScript` before the page loads — read
 * fresh here, at render time, never cached at module load, so a real browser's answer is always
 * `false`.
 */
function e2eToyGamesEnabled(): boolean {
  return (globalThis as { __cardtableE2eToyGames?: boolean }).__cardtableE2eToyGames === true;
}

/** A card's wash, by its format family: the colour-pie hues (`styles.css`), the same in every theme. */
const FAMILY_TINT: Readonly<Record<string, string>> = {
  standard: 'var(--c-blue)',
  modern: 'color-mix(in srgb, var(--c-blue) 50%, var(--c-red))',
  legacy: 'var(--c-red)',
  draft: 'var(--c-green)',
};

/** A card's state dot, by the state `roomCardView` names: lobby and done stay neutral. */
const STATE_DOT: Readonly<Record<string, string>> = {
  drafting: 'var(--color-primary)',
  building: 'var(--color-warning)',
  sideboarding: 'var(--color-warning)',
  playing: 'var(--color-danger)',
  rounds: 'var(--color-danger)',
};

/** The row's own colours (`@hadoku/game-ui/front/RoomFront.css`'s per-row custom properties). */
function rowVars(family: string, state: string): NonNullable<RoomFrontRowExtras['vars']> {
  const dot = STATE_DOT[state];
  return {
    '--room-front-tint': FAMILY_TINT[family] ?? 'var(--c-generic)',
    ...(dot === undefined ? {} : { '--room-front-dot': dot }),
    ...(state === 'done' ? { '--room-front-state-ink': 'var(--color-text-secondary)' } : {}),
  };
}

/**
 * Every external game cardtable may draw a room for, offered on the create form only with
 * Experimental features on (the same gate Challenge uses) — an `e2eOnly` entry only on top of that,
 * and only for the e2e harness; a friends-only game (`minTier`) only to a friend or above, whom the
 * server alone would let make one anyway.
 */
function externalGameTypes(friend: boolean): readonly RoomFrontGameType[] {
  const toyGames = e2eToyGamesEnabled();
  return EXTERNAL_GAMES.filter((g) => (g.e2eOnly !== true || toyGames) && (g.minTier === undefined || friend)).map((g) => ({ id: g.id, label: g.label }));
}

/** Whether every room of `gameType` is friends-only already, so the switch has nothing to choose. */
function friendsOnlyGame(gameType: string): boolean {
  return EXTERNAL_GAMES.some((g) => g.id === gameType && g.minTier !== undefined);
}

export function RoomList({ client: given, feed, onFeatured }: RoomListProps) {
  const client = useRef(given ?? roomsClient()).current;

  /** The viewer's own filters (ruling 6), remembered per-browser. */
  const [filters, setFilters] = useState<RoomFilters>(() => loadRoomFilters());
  const setAndSaveFilters = useCallback((next: RoomFilters): void => {
    setFilters(next);
    saveRoomFilters(next);
  }, []);

  const onFeaturedRef = useRef(onFeatured);
  onFeaturedRef.current = onFeatured;

  /** How many rooms the list draws, for the scroll telemetry below — the latest read's count; 0 again on one that fails. */
  const roomCount = useRef(0);
  // The front page's frame rate, in the server's log (`page-frames.ts`): its bad stretches and a summary as it closes.
  usePageFrames('front', true, () => ({ rooms: roomCount.current }));

  const frontClient = useMemo<RoomFrontClient<FrontRoom>>(
    () => ({
      async list() {
        try {
          const { rooms, featured } = await client.list();
          onFeaturedRef.current?.(featured);
          roomCount.current = rooms.length;
          return { rooms: rooms.map(toFrontRoom) };
        } catch (err) {
          roomCount.current = 0;
          throw err;
        }
      },
      async create(body) {
        const outcome = await client.create(body as unknown as CreateRequest);
        return outcome.ok ? { ok: true, room: toFrontRoom(outcome.room) } : outcome;
      },
      async join(roomId, password) {
        const outcome = await client.join(roomId, password);
        return outcome.ok ? { ok: true, room: toFrontRoom(outcome.room) } : outcome;
      },
      reset(roomId) {
        return client.reset(roomId);
      },
    }),
    [client],
  );

  const experimental = usePrefs(getPlayPrefsClient()).prefs?.experimental ?? PLAY_PREFS_DEFAULTS.experimental;
  const friend = atLeastFriend(useWhoami());
  const gameTypes: readonly RoomFrontGameType[] = experimental ? [...MAGIC_GAME_TYPES, ...externalGameTypes(friend), CHALLENGE_TYPE] : MAGIC_GAME_TYPES;

  /* ── Create room's own fields, and Challenge's wholly different creation ───────────────────── */

  const [fields, setFields] = useState<RoomFieldValues>(NEW_ROOM_FIELDS);
  const [events, setEvents] = useState<readonly ChallengeEvent[] | null>(null);
  const [choice, setChoice] = useState<ChallengeChoice | null>(null);
  const fetchingEvents = useRef(false);

  const createFields = useCallback(
    (kind: string): RoomFrontCreateSlot | null => {
      if (kind === 'challenge') {
        if (events === null) {
          if (!fetchingEvents.current) {
            fetchingEvents.current = true;
            client.challenges().then(
              (list) => {
                setEvents(list);
                if (list.length > 0) setChoice(firstChoice(list[0]!));
              },
              () => {
                // Not reachable: the dialog just has nothing to offer Challenge with; the radio
                // itself still works for every other kind.
                setEvents([]);
              },
            );
          }
          return { nameless: true, ready: false };
        }
        if (choice === null) return { nameless: true, ready: false };
        return {
          nameless: true,
          ready: true,
          node: <ChallengeFields idPrefix="room-create" events={events} value={choice} onChange={setChoice} />,
          submit: () => client.createChallenge(choice) as unknown as Promise<RoomFrontCreateOutcome<never>>,
        };
      }
      const offerFriendsOnly = friend && !friendsOnlyGame(kind);
      const value: RoomFieldValues = { ...fields, gameType: kind, friendsOnly: offerFriendsOnly && fields.friendsOnly };
      return {
        node: <RoomFields idPrefix="room-create" value={value} onChange={setFields} showType={false} offerFriendsOnly={offerFriendsOnly} />,
        body: roomRequest(value),
      };
    },
    [events, choice, fields, client, friend],
  );

  /* ── the row's own icons and chips ──────────────────────────────────────────────────────────── */

  const rowExtras = useCallback((room: FrontRoom): RoomFrontRowExtras => {
    const view = roomCardView(room, isMine(room));
    return {
      scene: room.gameType === 'draft' ? <PodScene /> : room.gameType === 'constructed-1v1' ? <DecksFacingScene /> : null,
      typeIcon: room.gameType === 'draft' ? <DraftIcon /> : room.gameType === 'constructed-1v1' ? <ConstructedIcon /> : null,
      trophy: view.tournament ? <TrophyIcon /> : undefined,
      modeChip: (
        <span className="room-card__mode-chip" data-testid="room-mode-chip">
          {view.mode.icon === 'classic' && <SwordsIcon />}
          {view.mode.icon === 'gauntlet' && <StaircaseIcon />}
          {view.mode.icon === 'random' && <DieIcon />}
          <span className="room-card__mode-text">{view.mode.text}</span>
        </span>
      ),
      seriesChip: view.series !== null ? <span className="room-card__series-chip">{view.series}</span> : undefined,
      legacyMeta: (
        <>
          <span className="rooms__sr" data-testid="room-type">
            {gameTypeLabel(room.gameType)}
          </span>
          {magicGame(room).clientMode === 'streamed' && (
            <span className="room-client-mode" data-testid="room-mode" data-mode="streamed">
              {clientModeLabel('streamed')}
            </span>
          )}
        </>
      ),
      family: view.family,
      vars: rowVars(view.family, room.view.state.key),
    };
  }, []);

  const matches = useCallback((room: FrontRoom): boolean => matchesRoomFilters(room, roomCardView(room, isMine(room)), filters), [filters]);

  /* ── before a freshly joined or created room opens ──────────────────────────────────────────── */

  const beforeOpenRoom = useCallback(async (room: FrontRoom): Promise<boolean> => {
    // A board-state room (no pod: a tournament's board is its round's table) opens on its game, the
    // one already running or a new one against the AI, rather than the room screen.
    const { scenario, pod } = magicGame(room);
    if (scenario !== undefined && pod === null) {
      const started = await tablesClient().startVsBot(room.id);
      if (started.ok) {
        openNewMatch(started.matchId);
        return true;
      }
    }
    await warmRoom(room);
    return false;
  }, []);

  const defaultName = useCallback((viewerName: string | null, random: () => number): string => defaultRoomName(viewerName, random), []);

  const stopTips = useRef<(() => void) | null>(null);
  /** How smoothly the list scrolls, one summary per scroll burst, in the server's log (`./scroll-watch.ts`). */
  const stopScrollWatch = useRef<(() => void) | null>(null);
  const onSectionRef = useCallback((el: HTMLElement | null): void => {
    stopTips.current?.();
    stopScrollWatch.current?.();
    if (el === null) {
      stopTips.current = null;
      stopScrollWatch.current = null;
      return;
    }
    stopTips.current = mountTips(el);
    stopScrollWatch.current = watchScroll({
      win: window,
      frame: everyFrame,
      doc: document,
      now: () => performance.now(),
      userAgent: navigator.userAgent,
      scrolls: (target) => target instanceof Element && target.contains(el),
      rooms: () => roomCount.current,
      ui: __HADOKU_UI_VERSION__,
      send: (data) => {
        void sendJson(apiUrl(PAGE_EVENT_PATH), 'POST', { page: 'front', kind: 'perf', data }, undefined, { keepalive: true }).catch((err: unknown) =>
          console.warn('[rooms] could not report scroll', err),
        );
      },
    });
  }, []);

  const [scheduling, setScheduling] = useState(false);

  return (
    <>
      <RoomFront<FrontRoom>
        rooms={frontClient}
        gameTypes={gameTypes}
        createFields={createFields}
        rowExtras={rowExtras}
        headExtras={<RoomFilterBar filters={filters} onChange={setAndSaveFilters} />}
        actionsExtras={
          <button
            type="button"
            className="lobby__go"
            data-testid="event-create-open"
            aria-haspopup="dialog"
            onClick={() => {
              playRole('ui.select');
              setScheduling(true);
            }}
          >
            Create event
          </button>
        }
        matches={matches}
        feed={feed}
        beforeOpenRoom={beforeOpenRoom}
        defaultName={defaultName}
        onSectionRef={onSectionRef}
        // The raised surface and its trim, added to the dialog's own panel — kept here, not in
        // `RoomFront.tsx`, so `.ct-surface` is still drawn by a tree that reaches the one that
        // owns it (`./CreateEventDialog.tsx`'s own import of `Modal.tsx`, `css-ownership.test.ts`'s rule B).
        createPanelClassName="ct-surface ct-panel"
        testingStorageKey="cardtable.rooms.testingFolded"
        onOpenRoom={(roomId) => navigate({ kind: 'room', roomId })}
      />
      {scheduling && <CreateEventDialog onClose={() => setScheduling(false)} />}
    </>
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
