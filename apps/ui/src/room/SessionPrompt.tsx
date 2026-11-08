/*
 * The two questions of one live tab per player per room (`./session.ts`), each a modal over the dimmed,
 * inert page that cannot be put away, only answered:
 *
 *   - `held`: this account plays the room in another live tab. Yes takes it from there; no goes back
 *     to the front page without joining.
 *   - `taken`: another tab took it. The one answer takes it back, the same way.
 *
 * A question and its answers, nothing else (the operator's rule: no explanatory text).
 */

import { useEffect, useState } from 'react';

import { ActionButton } from '../components/ActionButton.tsx';
import { Modal } from '../components/Modal.tsx';
import { navigate } from '../screens/route.ts';
import { roomSession, type RoomSession, type SessionState } from './session.ts';

/** This tab's claim on `room`, for as long as the screen is in it. Null: no room, nothing to claim. */
export function useRoomSession(room: string | null, screen: string): { state: SessionState | null; take: () => void } {
  const [session, setSession] = useState<RoomSession | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  useEffect(() => {
    if (room === null) {
      setSession(null);
      setState(null);
      return;
    }
    const opened = roomSession(room);
    setSession(opened);
    setState(opened.state());
    const stop = opened.subscribe(() => setState(opened.state()));
    return () => {
      stop();
      opened.close();
    };
  }, [room]);
  // Another kind of screen in the same room (the room → its match): whether this account plays here may have changed.
  useEffect(() => {
    session?.reclaim();
  }, [session, screen]);
  return { state, take: () => session?.take() };
}

/** Whether the screen stands down for a question: it is not drawn, and the page behind is inert. */
export function sessionBlocks(state: SessionState | null): boolean {
  return state === 'held' || state === 'taken';
}

export function SessionPrompt({ state, take }: { state: SessionState | null; take: () => void }) {
  if (state === 'held') {
    return (
      <Modal
        title="Play here instead?"
        testId="session-ask"
        actions={
          <>
            <ActionButton action="session-no" className="button" data-testid="session-ask-no" onPress={() => navigate({ kind: 'lobby' })}>
              No
            </ActionButton>
            <ActionButton action="session-yes" className="button ct-modal__primary" data-testid="session-ask-yes" onPress={take}>
              Yes
            </ActionButton>
          </>
        }
      />
    );
  }
  if (state === 'taken') {
    return (
      <Modal
        title="Open in another tab"
        testId="session-taken"
        actions={
          <ActionButton action="session-take-back" className="button ct-modal__primary" data-testid="session-take-back" onPress={take}>
            Play here
          </ActionButton>
        }
      />
    );
  }
  return null;
}
