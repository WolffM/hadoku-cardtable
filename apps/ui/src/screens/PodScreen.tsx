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
  cubeSize,
  mySeat,
  isComplete,
  startDraft,
  type DraftTransport,
  type SocketDraft,
} from '../draft/socket.ts';
import { initialState, type TableState } from '../draft/table.ts';
import { DraftScreen } from '../components/DraftScreen.tsx';
import type { PackLayout } from '../components/PackView.tsx';
import { mountInspector } from '../play/inspect/index.ts';
import { appLocation, navigate, routeUrl } from './route.ts';
import { SettingsGear } from '../settings/Settings.tsx';
import { useWhoami } from '../room/whoami.ts';
import { livePodSource, startTableMatch, usePodContext, type PodSource } from './pod/client.ts';
import { PodStandings } from './pod/PodStandings.tsx';
import { PodTables } from './pod/PodTables.tsx';
import './PodScreen.css';

export interface PodScreenProps {
  /** The ROOM's id. The draft runs against it, and the invite link points at it. */
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

  /**
   * The invite is the ROOM's url, not a pod's.
   *
   * There is no pod route any more, and `#/room/<id>` is the link that works in
   * both phases: before the draft is dealt it lands a friend in the lobby where
   * they can ready up, and after it is dealt it lands them in this pod, where
   * they evict a bot. One link, whenever it is clicked.
   */
  const link = useMemo(
    () => routeUrl({ kind: 'room', roomId: draftId }, appLocation()),
    [draftId],
  );

  const view = table?.view ?? null;
  const seats = view?.seats ?? [];
  const humans = seats.filter((s) => s.occupant?.kind === 'human').length;
  const bots = seats.filter((s) => s.occupant?.kind === 'bot').length;
  const open = seats.filter((s) => s.occupant === null).length;
  const seatId = draft === null ? null : mySeat(draft);
  const done = draft !== null && isComplete(draft);

  /** The ROOM's own pod state — `null` until the first read answers. */
  const ctx = usePodContext(draftId, podSource);
  const phase = ctx?.pod?.phase;
  const inRounds = phase === 'rounds' || phase === 'done';

  const who = useWhoami();
  const myMemberId = who === 'pending' || who === null ? null : who.userId;
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
    const mine = ctx.tables.find((t) => t.players.some((p) => p.memberId === myMemberId));
    if (mine?.matchId != null) navigate({ kind: 'match', matchId: mine.matchId });
  }, [phase, ctx, myMemberId]);

  /**
   * Starts round 1's first game at my own seated table. Confirmed against
   * the real server (not a guess from the wire contract's wording):
   * `pod/rounds` only seats the pairing, and a pod table is gated the SAME
   * way a constructed one is — both seats have to ready before
   * `POST /api/play/matches` succeeds. `pod/client.ts`'s `startTableMatch`
   * does both in one call and reports the first player's "other seat not
   * ready yet" as success with no match yet, not an error. The auto-
   * navigate effect above carries me once the table's own `matchId` lands.
   */
  const [startingTable, setStartingTable] = useState(false);
  const [startTableError, setStartTableError] = useState<string | null>(null);
  const playTable = (tableId: string): void => {
    setStartingTable(true);
    setStartTableError(null);
    startTableMatch(draftId, tableId)
      .then((r) => {
        if (!r.ok) setStartTableError(r.message);
      })
      .finally(() => setStartingTable(false));
  };

  return (
    <div className="shell" data-testid="pod" ref={host}>
      <header className="pod__bar">
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
          <strong className="pod__id">{draftId}</strong>
          <span className="pod__cube">
            {draft === null || cubeName(draft) === null
              ? 'waiting for the table'
              : `${cubeName(draft)}${cubeSize(draft) === null ? '' : ` · ${cubeSize(draft)} cards`}`}
          </span>
        </div>

        <PodSeats
          connected={draft?.connected === true}
          everConnected={draft?.everConnected === true}
          seated={seats.length}
          capacity={view?.capacity ?? null}
          humans={humans}
          bots={bots}
          open={open}
          seatId={seatId}
        />

        <Invite url={link} />
        <SettingsGear />
      </header>

      {draft !== null && draft.lastError !== null && (
        <p className="pod__error" role="alert" data-testid="pod-error">
          The server refused that: <strong>{draft.lastError.code}</strong>
          {draft.lastError.detail === undefined ? null : ` — ${draft.lastError.detail}`}
        </p>
      )}

      {done && ctx?.pod?.phase === 'rounds' ? (
        <div className="pod__rounds" data-testid="pod-rounds">
          <h2 data-testid="pod-round">
            Round {ctx.pod.round} of {ctx.pod.rounds}
          </h2>
          <PodTables tables={ctx.tables} myMemberId={myMemberId} byeId={ctx.pod.bye} nameOf={nameOf} onPlay={playTable} starting={startingTable} />
          {startTableError !== null && (
            <p className="pod__error" role="alert" data-testid="pod-table-start-error">
              {startTableError}
            </p>
          )}
          <PodStandings rows={ctx.pod.standings} nameOf={nameOf} myMemberId={myMemberId} />
        </div>
      ) : done && ctx?.pod?.phase === 'done' ? (
        <div className="pod__rounds" data-testid="pod-final">
          <h1>Final standings</h1>
          <PodStandings rows={ctx.pod.standings} nameOf={nameOf} myMemberId={myMemberId} />
        </div>
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
        />
      )}
      <div className="pod__zoom" data-board-zoom="" />
    </div>
  );
}

/* ── who is at the table ─────────────────────────────────────────────── */

interface PodSeatsProps {
  connected: boolean;
  everConnected: boolean;
  seated: number;
  capacity: number | null;
  humans: number;
  bots: number;
  open: number;
  seatId: number | null;
}

/**
 * The seat count, from the server's snapshot and from nothing else.
 *
 * Before the first payload there are no seats to report, and it says so rather
 * than showing a plausible `0 / 8` that the server has not confirmed.
 */
function PodSeats(props: PodSeatsProps) {
  const { connected, everConnected, seated, capacity, humans, bots, open, seatId } = props;
  const size = capacity ?? seated;

  return (
    <div className="pod__seats" data-testid="pod-seats">
      <span className={connected ? 'pod__dot pod__dot--on' : 'pod__dot'} aria-hidden="true" />
      <span className="pod__conn">
        {connected ? 'connected' : everConnected ? 'reconnecting' : 'connecting'}
      </span>
      {seated === 0 ? (
        <span className="pod__tally">no seats yet</span>
      ) : (
        <span className="pod__tally" data-testid="pod-tally">
          {humans} {humans === 1 ? 'person' : 'people'} · {bots} {bots === 1 ? 'bot' : 'bots'}
          {open === 0 ? '' : ` · ${open} open`} of {size} seats
          {seatId === null ? ' · no seat yet' : ` · you are seat ${seatId}`}
        </span>
      )}
    </div>
  );
}

/* ── the link you send ───────────────────────────────────────────────── */

/**
 * The invite.
 *
 * A read-only input rather than a bare string, because the fallback when the
 * clipboard is unavailable — and it is unavailable over plain HTTP, in older
 * browsers, and whenever permission is refused — has to be "select it and copy
 * it yourself", which needs a real input to select.
 */
function Invite({ url }: { url: string }) {
  const [said, setSaid] = useState<string | null>(null);

  const copy = (): void => {
    const write = globalThis.navigator?.clipboard?.writeText;
    if (write === undefined) {
      setSaid('Select the link and copy it.');
      return;
    }
    write
      .call(globalThis.navigator.clipboard, url)
      .then(() => setSaid('Copied.'))
      .catch(() => setSaid('Select the link and copy it.'));
  };

  return (
    <div className="pod__invite">
      <label className="pod__invite-label" htmlFor="invite-url">
        Send this link
      </label>
      <input
        id="invite-url"
        data-testid="invite-url"
        className="pod__invite-url"
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" data-testid="copy-invite" onClick={copy}>
        Copy
      </button>
      {said !== null && (
        <span className="pod__invite-said" role="status">
          {said}
        </span>
      )}
    </div>
  );
}
