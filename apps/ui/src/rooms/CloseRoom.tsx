/*
 * The room owner's Close (the operator, 2026-10-19: *"lobby owner needs to be
 * able to 'close' a tournament"*): asked once more in place, then the room ends
 * for everyone — its games stop, it leaves the list, and every screen on it
 * goes back to the lobby. A pod that played a round is kept for the stats
 * popout's Tournaments tab.
 *
 * Reset beside it (the operator, 2026-11-11: *"leader needs a way to clean up
 * a room"*), asked once more the same way: the room stays, with its people,
 * seats, settings and link, and every table starts over (`Lobby.resetRoom`).
 * A pod under way has no Reset (`resettable={false}`): its rounds end with Close.
 */

import { useState } from 'react';

import { navigate } from '../screens/route.ts';
import { resetRoom } from '../screens/tableActions.ts';
import type { RoomsClient } from './api.ts';
import './CloseRoom.css';

type Verb = 'close' | 'reset';

export function CloseRoom({
  roomId,
  rooms,
  resettable = true,
  reset = resetRoom,
}: {
  roomId: string;
  rooms: Pick<RoomsClient, 'close'>;
  resettable?: boolean;
  /** The server's reset: null once it has it, else its sentence. */
  reset?: (roomId: string) => Promise<string | null>;
}) {
  const [asking, setAsking] = useState<Verb | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (asking === null) {
    return (
      <>
        {resettable && (
          <button type="button" className="room-close" data-testid="room-reset" onClick={() => setAsking('reset')}>
            Reset
          </button>
        )}
        <button type="button" className="room-close" data-testid="room-close" onClick={() => setAsking('close')}>
          Close
        </button>
      </>
    );
  }
  const done = (message: string | null): void => {
    setBusy(false);
    setError(message);
    if (message === null) setAsking(null);
  };
  const confirm = (): void => {
    setBusy(true);
    setError(null);
    if (asking === 'reset') {
      void reset(roomId).then(done);
      return;
    }
    void rooms.close(roomId).then((r) => {
      if (r.ok) {
        navigate({ kind: 'lobby' });
        return;
      }
      done(r.message);
    });
  };
  return (
    <span className="room-close__ask" data-testid={`room-${asking}-ask`}>
      <button
        type="button"
        className="room-close"
        data-testid={`room-${asking}-no`}
        autoFocus
        disabled={busy}
        onClick={() => {
          setAsking(null);
          setError(null);
        }}
      >
        Cancel
      </button>
      <button type="button" className="room-close room-close--danger" data-testid={`room-${asking}-yes`} disabled={busy} onClick={confirm}>
        {asking === 'reset' ? 'Reset room' : 'Close room'}
      </button>
      {error !== null && (
        <span className="ct-error" role="alert" data-testid={`room-${asking}-error`}>
          {error}
        </span>
      )}
    </span>
  );
}
