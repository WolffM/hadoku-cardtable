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
 *   loading  — says so; the create form is already usable underneath
 *   failed   — says why, and offers Retry
 *   empty    — says so, and points at the create form, which is right there
 *   rooms    — the list
 *
 * ## Freshness
 *
 * Polled every five seconds while the tab is visible, and refreshed the
 * moment it becomes visible again. A friend's new room shows up without a
 * reload, and a backgrounded tab costs the server nothing. A poll that fails
 * after the list has loaded keeps the list and says it is stale, rather than
 * throwing away rooms a person may be about to click.
 *
 * This does not mount a `RoomChrome`: `App` mounts exactly one, and a second
 * would share and then tear down the first's socket.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { navigate } from '../screens/route.ts';
import {
  CLIENT_MODES,
  clientModeLabel,
  GAME_TYPES,
  gameTypeLabel,
  roomsClient,
  type ClientMode,
  type GameType,
  type RoomView,
  type RoomsClient,
} from './api.ts';
import './rooms.css';

export const POLL_MS = 5000;

type ListState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; rooms: RoomView[]; stale: string | null };

export interface RoomListProps {
  /** Tests pass a client over a stubbed fetch. Production passes nothing. */
  client?: RoomsClient;
}

export function RoomList({ client: given }: RoomListProps) {
  const client = useRef(given ?? roomsClient()).current;
  const [state, setState] = useState<ListState>({ kind: 'loading' });

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const rooms = await client.list();
      setState({ kind: 'ready', rooms, stale: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => (prev.kind === 'ready' ? { ...prev, stale: message } : { kind: 'failed', message }));
    }
  }, [client]);

  useEffect(() => {
    let live = true;
    const tick = (): void => {
      if (live) void refresh();
    };
    tick();
    const timer = setInterval(() => {
      if (globalThis.document?.visibilityState !== 'hidden') tick();
    }, POLL_MS);
    const onVisible = (): void => {
      if (globalThis.document?.visibilityState === 'visible') tick();
    };
    globalThis.document?.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      globalThis.document?.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const retry = (): void => {
    setState({ kind: 'loading' });
    void refresh();
  };

  return (
    <section className="rooms" data-testid="rooms" aria-labelledby="rooms-title">
      <h2 id="rooms-title" className="rooms__title">
        Rooms
      </h2>

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

      {state.kind === 'ready' && state.rooms.length === 0 && (
        <p className="rooms__status" data-testid="rooms-empty">
          No rooms yet.
        </p>
      )}

      {state.kind === 'ready' && state.rooms.length > 0 && (
        <ul className="rooms__list" data-testid="room-list">
          {state.rooms.map((room) => (
            <RoomRow key={room.id} room={room} client={client} onGone={() => void refresh()} />
          ))}
        </ul>
      )}

      {state.kind === 'ready' && state.stale !== null && (
        <p className="rooms__stale" data-testid="rooms-stale">
          List may be out of date.
        </p>
      )}

      <CreateRoom client={client} />
    </section>
  );
}

/* ── one row ─────────────────────────────────────────────────────────── */

function RoomRow({ room, client, onGone }: { room: RoomView; client: RoomsClient; onGone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enter = async (withPassword?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const outcome = await client.join(room.id, withPassword);
    setBusy(false);
    if (outcome.ok) {
      navigate({ kind: 'room', roomId: outcome.room.id });
      return;
    }
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
    if (room.locked) {
      setAsking(true);
      setError(null);
      return;
    }
    void enter();
  };

  const onPassword = (e: FormEvent): void => {
    e.preventDefault();
    if (password === '') {
      setError('Password required.');
      return;
    }
    void enter(password);
  };

  const names = room.members.map((m) => m.name);

  return (
    <li className="rooms__row" data-testid="room-row" data-room-id={room.id}>
      <div className="rooms__info">
        <span className="rooms__name" data-testid="room-name">
          {room.name}
        </span>
        <span className="rooms__meta">
          <span data-testid="room-type">{gameTypeLabel(room.gameType)}</span>
          {/* Every row, not just the streamed ones: "no mode shown" would have
              to mean "builtin", and a reader cannot tell that apart from a
              row that simply forgot. */}
          <span className="rooms__mode" data-testid="room-mode" data-mode={room.clientMode}>
            {clientModeLabel(room.clientMode)}
          </span>
          {room.locked && (
            <span className="rooms__lock" data-testid="room-locked">
              password
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
        </span>
        <span className="rooms__members" data-testid="room-members">
          {names.length === 0 ? 'Nobody here yet' : names.join(', ')}
        </span>
      </div>

      {!asking && (
        <button
          type="button"
          className="rooms__enter"
          data-testid="room-enter"
          aria-label={`Enter ${room.name}`}
          disabled={busy}
          onClick={onEnterClick}
        >
          Enter
        </button>
      )}

      {asking && (
        <form className="rooms__password" onSubmit={onPassword}>
          <label htmlFor={`room-password-${room.id}`}>Password for {room.name}</label>
          <input
            id={`room-password-${room.id}`}
            data-testid="room-password"
            type="password"
            maxLength={200}
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
        <p className="rooms__error" role="alert" data-testid="room-join-error">
          {error}
        </p>
      )}
    </li>
  );
}

/* ── create ──────────────────────────────────────────────────────────── */

function CreateRoom({ client }: { client: RoomsClient }) {
  const [name, setName] = useState('');
  const [gameType, setGameType] = useState<GameType>('constructed-1v1');
  const [clientMode, setClientMode] = useState<ClientMode>('builtin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Name required.');
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await client.create({ name: trimmed, gameType, clientMode, password });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    navigate({ kind: 'room', roomId: outcome.room.id });
  };

  return (
    <form
      className="rooms__create"
      data-testid="room-create"
      aria-labelledby="room-create-title"
      onSubmit={(e) => void submit(e)}
    >
      <h3 id="room-create-title">Create a room</h3>

      <label htmlFor="room-create-name">Name</label>
      <input
        id="room-create-name"
        data-testid="room-create-name"
        value={name}
        maxLength={60}
        placeholder="Friday night"
        autoComplete="off"
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
      />

      <label htmlFor="room-create-type">Game type</label>
      <select
        id="room-create-type"
        data-testid="room-create-type"
        value={gameType}
        onChange={(e) => setGameType(e.target.value as GameType)}
      >
        {GAME_TYPES.map((t) => (
          <option key={t.value} value={t.value} disabled={!t.ready}>
            {t.label}
          </option>
        ))}
      </select>

      {/* The mode is the ROOM's, chosen here and never again (D19a) — one pick
          for constructed rooms and draft pods alike, because a pod is a lobby
          room with `gameType: 'draft'`. Two radios rather than a select: the
          whole choice, and what each half costs you, is readable without
          opening anything. */}
      <fieldset className="rooms__modes" data-testid="room-create-mode">
        <legend>Which client</legend>
        {CLIENT_MODES.map((m) => (
          <label key={m.value} className="rooms__mode-pick" htmlFor={`room-create-mode-${m.value}`}>
            <input
              id={`room-create-mode-${m.value}`}
              data-testid={`room-create-mode-${m.value}`}
              type="radio"
              name="room-create-mode"
              value={m.value}
              checked={clientMode === m.value}
              onChange={() => setClientMode(m.value)}
            />
            <span className="rooms__mode-name">{m.label}</span>
          </label>
        ))}
      </fieldset>
      <label htmlFor="room-create-password">Password (optional)</label>
      <input
        id="room-create-password"
        data-testid="room-create-password"
        type="password"
        maxLength={200}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" className="lobby__go" data-testid="room-create-submit" disabled={busy}>
        Create room
      </button>

      {error !== null && (
        <p className="rooms__error" role="alert" data-testid="room-create-error">
          {error}
        </p>
      )}
    </form>
  );
}
