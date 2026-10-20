/*
 * A pod, as the second phase of a draft ROOM.
 *
 * This is the SOCKET source — the engine runs on the server and this browser
 * renders what it is sent. The in-process engine is still there and still
 * useful, but it is a solo game against bots, so it belongs behind `#/debug`
 * rather than behind a link you sent a friend.
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
 * `mountInspector` is mounted ONCE here, over this screen's whole root, rather
 * than inside `DraftScreen` — this is the one component the pick screen and
 * the rounds pass through, so one mount covers the hover-to-read behaviour on
 * every card this pod ever draws.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  applyPick as socketPick,
  closeDraft,
  cubeName,
  isComplete,
  startDraft,
  type DraftTransport,
  type SocketDraft,
} from '../draft/socket.ts';
import { initialState, type TableState } from '../draft/table.ts';
import { DraftScreen } from '../components/DraftScreen.tsx';
import type { PackLayout } from '../components/PackView.tsx';
import { mountInspector } from '../play/inspect/index.ts';
import { navigate } from './route.ts';
import { SettingsGear } from '../settings/Settings.tsx';
import type { RoomTable } from '@hadoku/shared';
import { livePodSource, startMyTable, usePodContext, type PodContext, type PodSource } from './pod/client.ts';
import { PodStandings } from './pod/PodStandings.tsx';
import { TableSideboard } from './TableSideboard.tsx';
import { PodTables } from './pod/PodTables.tsx';
import { followMatchOnce } from '../play/live/matchStart.ts';
import { preloadCubeArt } from '../play/live/art-preload.ts';
import { CloseRoom } from '../rooms/CloseRoom.tsx';
import { roomsClient } from '../rooms/api.ts';
import './PodScreen.css';

export interface PodScreenProps {
  /** The ROOM's id. The draft runs against it. */
  draftId: string;
  /** Tests pass a stub. Production leaves it undefined and gets socket.io. */
  makeTransport?: () => DraftTransport;
  /** Tests pass a stub. Production leaves it undefined and reads the room over the feed. */
  podSource?: PodSource;
}

export function PodScreen({ draftId, makeTransport, podSource = livePodSource }: PodScreenProps) {
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
        const stamp = `${d.view.epoch}:${d.view.seq}`;
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

  // Every pack's art, warmed in the background: a page opened mid-draft never came through the lobby.
  useEffect(() => void preloadCubeArt(), []);

  /** The ROOM's own pod state — `null` until the first read answers. */
  const ctx = usePodContext(draftId, podSource);
  const phase = ctx?.pod?.phase;
  const inRounds = phase === 'rounds' || phase === 'done';

  const closeClient = useMemo(() => roomsClient(), []);
  // Closed by its owner: there is nothing left here to show.
  const gone = ctx?.gone === true;
  useEffect(() => {
    if (gone) navigate({ kind: 'lobby' }, { replace: true });
  }, [gone]);

  const myMemberId = ctx?.me ?? null;
  const nameOf = (id: string): string => ctx?.names[id] ?? id;

  /** The header's own rule: a finished draft goes to the builder unless the pod is already playing. */
  const toBuilder = done && ctx !== null && !inRounds;
  useEffect(() => {
    if (toBuilder) navigate({ kind: 'deck', draftId }, { replace: true });
  }, [toBuilder, draftId]);

  /**
   * "A player whose table starts a game is taken to it. Everyone else
   * stays on the pod." Only live during `rounds`: `building`'s tables do
   * not exist yet, and `done`'s games are all over.
   */
  useEffect(() => {
    if (myMemberId === null || ctx === null || phase !== 'rounds') return;
    const mine = myCurrentTable(ctx, myMemberId);
    if (mine?.matchId != null) followMatchOnce(mine.matchId, false);
  }, [phase, ctx, myMemberId]);

  /**
   * My table's next series starts with nobody pressing anything: draft →
   * build → Play → the game (the operator, 2026-10-18: *"it should just go
   * immediately into a game"*). Being on this screen in `rounds` with a table
   * that has no game is the whole signal — I readied my table by being here,
   * the other player by being on theirs, and the second of us starts it
   * (`startMyTable`; against the AI there is no second). Asked once per table;
   * a refusal shows Play at the table to ask again.
   */
  const [startTableError, setStartTableError] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const startTable = (table: RoomTable, ask: string = table.id): void => {
    asked.current = ask;
    setStartTableError(null);
    startMyTable(draftId, table).then((r) => {
      if (!r.ok) setStartTableError(r.message);
    });
  };
  const retryTable = (tableId: string): void => {
    const table = ctx?.tables.find((t) => t.id === tableId);
    if (table !== undefined) startTable(table);
  };
  useEffect(() => {
    if (myMemberId === null || ctx === null || phase !== 'rounds') return;
    const mine = myCurrentTable(ctx, myMemberId);
    // `playing` with no match is a game that died (`releaseTableMatch`): it is
    // started again, as a series' first game is — once per game of the series.
    if (mine === undefined || mine.matchId !== null || (mine.series.phase !== 'seating' && mine.series.phase !== 'playing')) return;
    const ask = `${mine.id}:${mine.series.games.length}:${mine.series.phase}`;
    if (asked.current === ask) return;
    startTable(mine, ask);
  }, [phase, ctx, myMemberId]);

  /** The room's bar: on top of the pod, or at the top of the draft's side column while drafting. */
  const bar = (
    <>
      <div className="pod__who">
        <a
          className="shell__link"
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            navigate({ kind: 'lobby' });
          }}
        >
          ← Lobby
        </a>
        {ctx !== null && ctx.name !== '' && <strong className="pod__name" data-testid="pod-name">{ctx.name}</strong>}
        {draft !== null && cubeName(draft) !== null && <span className="pod__cube">{cubeName(draft)}</span>}
      </div>

      <PodSeats
        connected={draft?.connected === true}
        everConnected={draft?.everConnected === true}
        seated={seats.length}
        humans={humans}
        bots={bots}
        open={open}
      />

      {ctx?.leader === true && <CloseRoom roomId={draftId} rooms={closeClient} />}
      <SettingsGear />
    </>
  );
  const rounds = done && ctx?.pod !== null && ctx?.pod !== undefined && inRounds;
  const drafting = !rounds && !done && table !== null;

  return (
    <div className="shell" data-testid="pod" ref={host}>
      {!drafting && <header className="pod__bar">{bar}</header>}

      {draft !== null && draft.lastError !== null && (
        <p className="pod__error" role="alert" data-testid="pod-error">
          The server refused that: <strong>{draft.lastError.code}</strong>
          {draft.lastError.detail === undefined ? null : ` — ${draft.lastError.detail}`}
        </p>
      )}

      {rounds ? (
        <PodRoom ctx={ctx!} draftId={draftId} myMemberId={myMemberId} nameOf={nameOf} startTableError={startTableError} retryTable={retryTable} />
      ) : done ? null : table === null ? (
        <div className="pod__waiting" data-testid="pod-waiting">
          <h1>{draft?.everConnected === true ? 'Waiting for the table' : 'Joining the pod'}</h1>
        </div>
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
          side={<div className="pod__bar pod__bar--side">{bar}</div>}
        />
      )}
      <div className="pod__zoom" data-board-zoom="" />
    </div>
  );
}

/* ── the rounds: the round, my sideboard step or the standings, and the tables ── */

/** My table in the CURRENT round — an earlier round's table is still mine, and finished. */
function myCurrentTable(ctx: PodContext, myMemberId: string): RoomTable | undefined {
  const current = new Set(ctx.pod?.pairings.map((p) => p.tableId) ?? []);
  return ctx.tables.find((t) => current.has(t.id) && t.players.some((p) => p.memberId === myMemberId));
}

/** Every table the pod has played at: this round's first, then earlier rounds', newest first. The room's own first table seats nobody in a pod. */
export function podTablesInOrder(ctx: PodContext): RoomTable[] {
  const current = new Set(ctx.pod?.pairings.map((p) => p.tableId) ?? []);
  const played = ctx.tables.filter((t) => t.players.length > 0);
  return [...played.filter((t) => current.has(t.id)), ...played.filter((t) => !current.has(t.id)).reverse()];
}

function PodRoom({
  ctx,
  draftId,
  myMemberId,
  nameOf,
  startTableError,
  retryTable,
}: {
  ctx: PodContext;
  draftId: string;
  myMemberId: string | null;
  nameOf: (id: string) => string;
  startTableError: string | null;
  retryTable: (tableId: string) => void;
}) {
  const pod = ctx.pod!;
  const mine = myMemberId === null ? undefined : myCurrentTable(ctx, myMemberId);
  // Between games of my series, the room is where the sideboard step is, whichever page I came back by.
  const sideboarding = pod.phase === 'rounds' && mine !== undefined && mine.matchId === null && mine.series.phase === 'sideboarding';
  return (
    <div className="pod__room">
      <div className="pod__rounds" data-testid={pod.phase === 'rounds' ? 'pod-rounds' : 'pod-final'}>
        {pod.phase === 'rounds' ? (
          <h2 data-testid="pod-round">
            Round {pod.round} of {pod.rounds}
          </h2>
        ) : (
          <h1>Standings</h1>
        )}
        {startTableError !== null && (
          <p className="pod__error" role="alert" data-testid="pod-table-start-error">
            {startTableError}
          </p>
        )}
        {sideboarding ? (
          <TableSideboard key={`${mine.id}:${mine.series.games.length}`} roomId={draftId} tableId={mine.id} refresh={ctx} />
        ) : (
          <PodStandings rows={pod.standings} results={pod.results} nameOf={nameOf} myMemberId={myMemberId} />
        )}
      </div>
      <footer className="pod__tables">
        <PodTables
          tables={podTablesInOrder(ctx)}
          myMemberId={myMemberId}
          byeId={pod.phase === 'rounds' ? pod.bye : null}
          nameOf={nameOf}
          onPlay={startTableError === null ? undefined : retryTable}
        />
      </footer>
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
