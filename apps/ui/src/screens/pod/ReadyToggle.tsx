/*
 * My Ready beside a strip of seats: a pod's lobby, and a tournament table's own start (a Gauntlet's
 * draw waits on both seats' Ready). One control, so both read and behave the same (the operator,
 * 2026-10-23: *"can we instead retain the logic of the ready button from the lobby?"*).
 */

import type { ReactNode } from 'react';

import { ActionButton } from '../../components/ActionButton.tsx';

export interface ReadyToggleProps {
  ready: boolean;
  disabled: boolean;
  onReady: (ready: boolean) => void;
  /** Beside Ready: where the room stands (a draft's "Dealing"). */
  note?: ReactNode;
}

export function ReadyToggle({ ready, disabled, onReady, note }: ReadyToggleProps) {
  return (
    <div className="pod-strip__side">
      {note}
      <ActionButton action={ready ? 'unready' : 'ready'} className="lobby__go" data-testid="ready-toggle" aria-pressed={ready} disabled={disabled} onPress={() => onReady(!ready)}>
        {ready ? 'Stand down' : 'Ready'}
      </ActionButton>
    </div>
  );
}
