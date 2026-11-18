/*
 * Passing the room's crown, behind a confirmation. A Lead press used to hand the
 * room over on the spot, and one stray click gave it away for good (only the new
 * leader can give it back). Every Lead button in Magic's rooms — the seat rows,
 * the pod grid, the spectator row — opens this sheet instead.
 *
 * Same shape as Concede's ask (`play/live/LiveBoard.tsx`): `role="alertdialog"`,
 * Cancel focused, so Enter on a sheet nobody read does not give the room away,
 * and Escape cancels.
 */
import { useState, type ReactNode } from 'react';

import { ConfirmPrompt } from '../../play/prompts/ConfirmPrompt.tsx';
import './LeaderAsk.css';

export interface LeaderAsk {
  /** Open the sheet for `memberId`. Nothing is sent until its Make leader is pressed. */
  ask: (memberId: string) => void;
  /** The sheet while one is open, else null; the caller renders it anywhere in its tree. */
  sheet: ReactNode;
}

/** `nameOf` names the member on the sheet; `pass` is the one path to the server. */
export function useLeaderAsk(nameOf: (memberId: string) => string | undefined, pass: (memberId: string) => void): LeaderAsk {
  const [target, setTarget] = useState<string | null>(null);
  const close = (): void => setTarget(null);
  const sheet =
    target === null ? null : (
      <div
        className="leader-ask"
        data-testid="leader-ask"
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        <ConfirmPrompt
          testId="leader-ask-sheet"
          role="alertdialog"
          title="Pass leader"
          message={`Make ${nameOf(target) ?? 'them'} the room leader?`}
          button1={{
            label: 'Make leader',
            enabled: true,
            testId: 'leader-ask-yes',
            onClick: () => {
              close();
              pass(target);
            },
          }}
          button2={{ label: 'Cancel', enabled: true, testId: 'leader-ask-no', isDefault: true, onClick: close }}
        />
      </div>
    );
  return { ask: setTarget, sheet };
}
