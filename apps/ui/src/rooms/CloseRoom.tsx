/*
 * The room owner's Close (the operator, 2026-10-19: *"lobby owner needs to be
 * able to 'close' a tournament"*): asked once more in place, then the room ends
 * for everyone — its games stop, it leaves the list, and every screen on it
 * goes back to the lobby. A pod that played a round is kept for the stats
 * popout's Tournaments tab.
 */

import { useState } from 'react';

import { navigate } from '../screens/route.ts';
import type { RoomsClient } from './api.ts';
import './CloseRoom.css';

export function CloseRoom({ roomId, rooms }: { roomId: string; rooms: Pick<RoomsClient, 'close'> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!asking) {
    return (
      <button type="button" className="room-close" data-testid="room-close" onClick={() => setAsking(true)}>
        Close
      </button>
    );
  }
  const close = (): void => {
    setBusy(true);
    setError(null);
    rooms.close(roomId).then((r) => {
      if (r.ok) {
        navigate({ kind: 'lobby' });
        return;
      }
      setBusy(false);
      setError(r.message);
    });
  };
  return (
    <span className="room-close__ask" data-testid="room-close-ask">
      <button type="button" className="room-close" data-testid="room-close-no" autoFocus disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </button>
      <button type="button" className="room-close room-close--danger" data-testid="room-close-yes" disabled={busy} onClick={close}>
        Close room
      </button>
      {error !== null && (
        <span className="lobby__error" role="alert" data-testid="room-close-error">
          {error}
        </span>
      )}
    </span>
  );
}
