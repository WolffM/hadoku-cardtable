/*
 * A pod, as the second phase of a draft ROOM.
 *
 * The engine runs on the server, and this browser renders what it is sent.
 *
 * ## Mounting this no longer creates anything (w23)
 *
 * It used to: `#/draft/<id>` was its own route, the id was minted in the
 * browser, and the server's `join` handler opened the room and dealt the draft
 * on first connect — so every seat nobody had taken was a bot by the time the
 * second person arrived. The operator, of the button that did that: *"old
 * cruft that seems to auto-start with all bots"*.
 *
 * So a draft is a room now. `ConstructedScreen` renders this only once the
 * ROOM's `draftStartedAt` is set, `draftId` IS the room's own id, and the
 * server refuses a `join` for a room whose draft has not started
 * (`apps/server/src/room/socket.ts`). Joining deals nothing; the room's
 * readiness gate is what deals, and the bots fill whatever seats are still
 * empty at that instant.
 *
 * ## Everything on the status bar comes off the server's own snapshot
 *
 * The cube name and size come from the `state` message's `cube`; the seats,
 * the capacity and who is human come from `view.seats`. Nothing here is a
 * client-side guess about what the server is doing, which is why there is no
 * cube dropdown and no pod-size selector — the server exposes neither, and a
 * control that cannot change anything is worse than an absent one.
 *
 * ## The transport is injectable
 *
 * `startDraft` defaults to a real same-origin socket.io connection. A test
 * passes a stub, the same way `socket.test.ts` does, so the pod can be driven
 * end to end without a server and without an open handle. `ConstructedScreen`
 * threads it through under the same name.
 *
 * ## A finished draft goes straight to the deck builder
 *
 * The operator: *"I dont need the 'confirm your draft' phase at all, should go
 * straight to deck building."* Once this seat's pool is complete and the room
 * is not yet in `rounds`/`done`, this screen replaces itself with
 * `#/deck/<podId>` — on the last pick, and on a reload or rejoin of a room
 * whose draft is already over for you. The builder carries the `building`
 * phase (`pod/PodBuilding.tsx`) and comes back here when rounds start. It waits
 * for the room's first read, so a reload during `rounds` stays on the tables.
 *
 * A drafter who has pressed Play is done building: they wait here, on the pod —
 * who is ready, and the rounds to come — until the last drafter's Play deals
 * round 1 (the operator, 2026-10-20: *"ideally it brings me to the game lobby
 * until my opponent is ready"*), not back in the builder.
 *
 * The rounds are the room's hub (`pod/RoomHub.tsx`) and one page per table
 * (`pod/TablePage.tsx`, `tableId`), which a paired player is carried to once.
 *
 * `mountInspector` is mounted ONCE here, over this screen's whole root, rather
 * than inside `DraftScreen` — this is the one component the pick screen and
 * the rounds pass through, so one mount covers the hover-to-read behaviour on
 * every card this pod ever draws.
 */

import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';

import {
  applyPick as socketPick,
  closeDraft,
  isComplete,
  startDraft,
  watchSeat,
  type DraftTransport,
  type SocketDraft,
} from '../draft/socket.ts';
import { initialState, type TableState } from '../draft/table.ts';
import { DraftScreen, fitToWindow } from '../components/DraftScreen.tsx';
import { useFitScale } from '../components/cardFit.ts';
import type { PackLayout } from '../components/PackView.tsx';
import { mountInspector } from '../play/inspect/index.ts';
import { navigate, routeHash } from './route.ts';
import { TopLayer } from '../topLayer.tsx';
import { SettingsGear } from '../settings/Settings.tsx';
import { livePodSource, useFollowMyTable, usePodContext, type PodSource } from './pod/client.ts';
import { PodBuilding } from './pod/PodBuilding.tsx';
import { PodSpectators } from './pod/PodSpectators.tsx';
import { RoomHub } from './pod/RoomHub.tsx';
import { TablePage } from './pod/TablePage.tsx';
import { preloadCubeArt, viewerCards } from '../play/live/art-preload.ts';
import { CloseRoom } from '../rooms/CloseRoom.tsx';
import { cubeIdsOf } from './DraftLobby.tsx';
import { poolsClient, roomsClient } from '../rooms/api.ts';
import { deckStoreClient } from '../deck/deckStore.ts';
import './PodScreen.css';

export interface PodScreenProps {
  /** The ROOM's id. The draft runs against it. */
  draftId: string;
  /** The route's table of the rounds (`TablePage`); absent is the hub. */
  tableId?: string;
  /** Tests pass a stub. Production leaves it undefined and gets socket.io. */
  makeTransport?: () => DraftTransport;
  /** Tests pass a stub. Production leaves it undefined and reads the room over the feed. */
  podSource?: PodSource;
}

export function PodScreen({ draftId, tableId, makeTransport, podSource = livePodSource }: PodScreenProps) {
  const [draft, setDraft] = useState<SocketDraft | null>(null);
  const [table, setTable] = useState<TableState | null>(null);
  const [layout, setLayout] = useState<PackLayout>('fan');
  /**
   * The driver is a mutable handle — a socket's state changes under you. This
   * is what tells React something happened; the handle keeps its identity so
   * `socketPick(draft, …)` reads the same as the in-process engine's call.
   */
  const [, changed] = useReducer((n: number) => n + 1, 0);

  /** The inspector, mounted over this whole screen's root — see the header. */
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    return el === null ? undefined : mountInspector(el);
  }, []);

  useEffect(() => {
    // The last payload rendered. A rejection or a reconnect notifies too, and
    // rebuilding the table on those would throw away the pending pick the
    // screen is showing.
    let shown = '';
    setTable(null);
    const live = startDraft({
      draftId,
      transport: makeTransport?.(),
      onChange: (d) => {
        changed();
        if (d.view === null) {
          shown = '';
          setTable(null);
          return;
        }
        // The watched seat too: a watcher switching seats is the same moment of the draft.
        const stamp = `${d.view.epoch}:${d.view.seq}:${d.view.viewer.kind === 'watcher' ? d.view.viewer.seatId : ''}`;
        if (stamp === shown) return;
        shown = stamp;
        setTable(initialState(d.view));
      },
    });
    setDraft(live);
    return () => {
      closeDraft(live);
      setDraft(null);
    };
  }, [draftId, makeTransport]);

  const view = table?.view ?? null;
  const seats = view?.seats ?? [];
  const humans = seats.filter((s) => s.occupant?.kind === 'human').length;
  const bots = seats.filter((s) => s.occupant?.kind === 'bot').length;
  const open = seats.filter((s) => s.occupant === null).length;
  const done = draft !== null && isComplete(draft);

  // This seat's visible cards, warmed in the background as each new pack or pool arrives
  // (wave 73 §B: the plan's own cards, since no bundled file names them any more — see `art-preload.ts`'s header).
  useEffect(() => {
    if (view !== null) preloadCubeArt(viewerCards(view));
  }, [view]);

  /** The ROOM's own pod state — `null` until the first read answers. */
  const ctx = usePodContext(draftId, podSource);
  const phase = ctx?.pod?.phase;
  const inRounds = phase === 'rounds' || phase === 'done';

  // The plan's own cube(s), warmed from `GET /api/pools/cubes/:id/cards` —
  // a reload mid-draft lands here directly, never through `DraftLobby.tsx`,
  // so the lobby's own warm-up (same idea, same helper) never ran for it.
  const poolsForArt = useMemo(() => poolsClient(), []);
  const planCubeIdsKey = cubeIdsOf(ctx?.pod?.plan).join(',');
  useEffect(() => {
    if (planCubeIdsKey === '') return;
    let cancelled = false;
    for (const id of planCubeIdsKey.split(',')) {
      poolsForArt.cubeCards(id).then((cards) => {
        if (!cancelled && cards !== null) preloadCubeArt(cards);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [planCubeIdsKey, poolsForArt]);

  const closeClient = useMemo(() => roomsClient(), []);
  const buildStore = useMemo(() => ({ podId: draftId, client: deckStoreClient() }), [draftId]);
  // Closed by its owner: there is nothing left here to show.
  const gone = ctx?.gone === true;
  useEffect(() => {
    if (gone) navigate({ kind: 'lobby' }, { replace: true });
  }, [gone]);

  const myMemberId = ctx?.me ?? null;
  const nameOf = (id: string): string => ctx?.names[id] ?? id;
  const avatarOf = (id: string): string | null => ctx?.avatars[id] ?? null;

  /** Pressed Play, and the rest of the pod is still building. */
  const ready = phase === 'building' && myMemberId !== null && ctx?.pod?.built.includes(myMemberId) === true;
  /** The header's own rule: a finished draft goes to the builder unless the pod is already playing, or I am done building. */
  const toBuilder = done && ctx !== null && !inRounds && !ready;
  useEffect(() => {
    if (toBuilder) navigate({ kind: 'deck', draftId }, { replace: true });
  }, [toBuilder, draftId]);

  useFollowMyTable(draftId, ctx?.pod ?? null, ctx?.tables ?? [], myMemberId, tableId);

  /** The room's bar: on top of the pod, or at the top of the draft's side column while drafting. */
  const bar = (
    <>
      <div className="pod__who">
        {ctx !== null && ctx.name !== '' && <strong className="pod__name" data-testid="pod-name">{ctx.name}</strong>}
      </div>

      {/* What is being drafted and who is at the table, on one line under the room's name. */}
      <div className="pod__meta">
        {/* Round 1's source name today (the Cube tab fills every round alike); a per-round label is wave 74's Custom tab. */}
        {ctx?.pod != null && ctx.pod.planName !== '' && <span className="pod__cube">{ctx.pod.planName}</span>}
        <PodSeats
          connected={draft?.connected === true}
          everConnected={draft?.everConnected === true}
          seated={seats.length}
          humans={humans}
          bots={bots}
          open={open}
        />
      </div>

      {ctx?.leader === true && <CloseRoom roomId={draftId} rooms={closeClient} />}
      <SettingsGear />
    </>
  );
  // Not `done`: that is a drafter's own pool, and a member who never drafted watches the rounds too.
  const rounds = ctx?.pod !== null && ctx?.pod !== undefined && inRounds;
  /** The draft's layout, drawn or still coming: the room's bar is in its side column, not on top. */
  const drafting = !rounds && !done && !inRounds;
  const side = (
    <div className="pod__bar pod__bar--side">
      {bar}
      {ctx?.pod != null && <PodSpectators pod={ctx.pod} members={ctx.members} myId={myMemberId} leaderId={ctx.leaderId} />}
    </div>
  );

  return (
    <div className="shell" data-testid="pod" ref={host}>
      {!drafting && <header className="pod__bar">{bar}</header>}

      {draft !== null && draft.lastError !== null && (
        <p className="ct-error" role="alert" data-testid="pod-error">
          The server refused that: <strong>{draft.lastError.code}</strong>
          {draft.lastError.detail === undefined ? null : ` — ${draft.lastError.detail}`}
        </p>
      )}

      {(rounds || (done && ready)) && tableId !== undefined && ctx!.pod!.phase !== 'building' ? (
        <TablePage
          roomId={draftId}
          pod={ctx!.pod!}
          table={ctx!.tables.find((t) => t.id === tableId)}
          myMemberId={myMemberId}
          nameOf={nameOf}
          avatarOf={avatarOf}
          refresh={ctx}
        />
      ) : rounds || (done && ready) ? (
        <RoomHub
          roomId={draftId}
          pod={ctx!.pod!}
          tables={ctx!.tables}
          myMemberId={myMemberId}
          nameOf={nameOf}
          avatarOf={avatarOf}
          members={ctx!.members}
          leaderId={ctx!.leaderId}
        >
          {ctx!.pod!.phase === 'building' && (
            <>
              <PodBuilding pod={ctx!.pod!} nameOf={nameOf} />
              <a
                className="shell__link"
                href={routeHash({ kind: 'deck', draftId })}
                data-testid="pod-edit-deck"
                onClick={(e) => {
                  e.preventDefault();
                  navigate({ kind: 'deck', draftId });
                }}
              >
                Edit deck
              </a>
            </>
          )}
        </RoomHub>
      ) : done || inRounds ? null : table === null ? (
        <DraftSkeleton side={side} />
      ) : (
        <DraftScreen
          state={table}
          onChange={setTable}
          onPick={(cardId) => {
            if (draft !== null) socketPick(draft, cardId);
          }}
          nextPayload={null}
          layout={layout}
          onLayoutChange={setLayout}
          buildStore={buildStore}
          arrivedWhole={draft?.arrivedWhole ?? false}
          side={side}
          onWatch={(seatId) => {
            if (draft !== null) watchSeat(draft, seatId);
          }}
        />
      )}
      <TopLayer fixed />
    </div>
  );
}

/* ── until the draft's table arrives ──────────────────────────────────── */

/**
 * The draft's own layout with nothing in it yet: the pack and the picks as
 * placeholders, the room's bar already in the side column, so the draft lands
 * on the same lines and the page changes once (the operator, 2026-10-20: *"can
 * we add a loading skeleton while this is still loading so i dont see the page
 * change so many times?"*).
 */
function DraftSkeleton({ side }: { side: ReactNode }) {
  const fitAside = useFitScale();
  return (
    <div className="draft" data-testid="pod-waiting" aria-busy="true">
      <div className="draft__body" ref={fitToWindow}>
        <span className="skeleton pod__skeleton-pack" />
        <span className="skeleton pod__skeleton-pool" />
        <aside className="draft__aside fit-scale" ref={fitAside}>{side}</aside>
      </div>
    </div>
  );
}


/* ── who is at the table ─────────────────────────────────────────────── */

interface PodSeatsProps {
  connected: boolean;
  everConnected: boolean;
  seated: number;
  humans: number;
  bots: number;
  open: number;
}

/**
 * The connection, as a dot, and who is at the table, from the server's
 * snapshot and from nothing else — nothing at all before the first payload.
 */
function PodSeats(props: PodSeatsProps) {
  const { connected, everConnected, seated, humans, bots, open } = props;

  return (
    <div className="pod__seats" data-testid="pod-seats">
      <span
        className={connected ? 'pod__dot pod__dot--on' : 'pod__dot'}
        data-testid="pod-conn"
        data-state={connected ? 'connected' : everConnected ? 'reconnecting' : 'connecting'}
        role="img"
        aria-label={connected ? 'connected' : everConnected ? 'reconnecting' : 'connecting'}
      />
      {seated > 0 && (
        <span className="pod__tally" data-testid="pod-tally">
          {humans} {humans === 1 ? 'person' : 'people'} · {bots} {bots === 1 ? 'bot' : 'bots'}
          {open === 0 ? '' : ` · ${open} open`}
        </span>
      )}
    </div>
  );
}
