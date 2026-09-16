/*
 * A pod: `#/draft/<draftId>`.
 *
 * This is the route an invite link points at, and it is the SOCKET source —
 * the engine runs on the server and this browser renders what it is sent. The
 * in-process engine is still there and still useful, but it is a solo game
 * against bots, so it belongs behind `#/debug` rather than behind a link you
 * sent a friend.
 *
 * ## Joining is the whole protocol
 *
 * There is no "create pod" call. The server's `join` handler opens the room if
 * it is not open yet (`apps/server/src/room/socket.ts` → `rooms.open`), deals
 * the draft on first open, and seats the joiner — humans evict bots. So
 * mounting this screen with an id nobody has used yet creates the pod, and
 * mounting it with an id a friend sent joins theirs. Same code, same effect,
 * no branch.
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
 * passes a stub, the same way `socket.test.ts` does, so the lobby can be driven
 * end to end without a server and without an open handle.
 */

import { useEffect, useMemo, useReducer, useState } from 'react';

import {
  applyPick as socketPick,
  closeDraft,
  cubeName,
  cubeSize,
  mySeat,
  myPool,
  isComplete,
  startDraft,
  type DraftTransport,
  type SocketDraft,
} from '../draft/socket.ts';
import { initialState, type TableState } from '../draft/table.ts';
import { DraftScreen } from '../components/DraftScreen.tsx';
import type { PackLayout } from '../components/PackView.tsx';
import { inviteUrl, navigate } from './route.ts';

export interface PodScreenProps {
  draftId: string;
  /** Tests pass a stub. Production leaves it undefined and gets socket.io. */
  makeTransport?: () => DraftTransport;
}

export function PodScreen({ draftId, makeTransport }: PodScreenProps) {
  const [draft, setDraft] = useState<SocketDraft | null>(null);
  const [table, setTable] = useState<TableState | null>(null);
  const [layout, setLayout] = useState<PackLayout>('fan');
  /**
   * The driver is a mutable handle — a socket's state changes under you. This
   * is what tells React something happened; the handle keeps its identity so
   * `socketPick(draft, …)` reads the same as the in-process engine's call.
   */
  const [, changed] = useReducer((n: number) => n + 1, 0);

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

  const link = useMemo(
    () => inviteUrl(draftId, globalThis.location ?? { origin: '', pathname: '' }),
    [draftId],
  );

  const view = table?.view ?? null;
  const seats = view?.seats ?? [];
  const humans = seats.filter((s) => s.occupant?.kind === 'human').length;
  const bots = seats.filter((s) => s.occupant?.kind === 'bot').length;
  const open = seats.filter((s) => s.occupant === null).length;
  const seatId = draft === null ? null : mySeat(draft);
  const done = draft !== null && isComplete(draft);

  return (
    <div className="shell" data-testid="pod">
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
      </header>

      {draft !== null && draft.lastError !== null && (
        <p className="pod__error" role="alert" data-testid="pod-error">
          The server refused that: <strong>{draft.lastError.code}</strong>
          {draft.lastError.detail === undefined ? null : ` — ${draft.lastError.detail}`}
        </p>
      )}

      {done && draft !== null ? (
        <div className="pod__done">
          <h1>Draft complete</h1>
          <p>Every pick is in. The pool below is what the server says you took.</p>
          <ol className="pod__pool">
            {myPool(draft).map((card) => (
              <li key={card.cardId}>{card.name}</li>
            ))}
          </ol>
        </div>
      ) : table === null ? (
        <div className="pod__waiting" data-testid="pod-waiting">
          <h1>{draft?.everConnected === true ? 'Waiting for the table' : 'Joining the pod'}</h1>
          <p>
            Send the link above while you wait — the pod exists the moment the server
            answers, and anyone who opens it takes a seat.
          </p>
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
