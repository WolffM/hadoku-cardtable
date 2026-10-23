/*
 * A titled panel over a dimmed page, drawn the way the room list's create form is (`../rooms/RoomList.tsx`):
 * Escape, its close button and a press on the backdrop close it.
 */

import { useEffect, useId, type ReactNode } from 'react';
import { Icon } from '@wolffm/themes';

import { uiLength } from '../settings/ui-scale.ts';
import './Modal.css';

export function Modal({ title, testId, onClose, children }: { title: string; testId: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.document?.addEventListener('keydown', onKey);
    return () => globalThis.document?.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="ct-modal"
      data-testid={`${testId}-backdrop`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ct-modal__panel ct-surface ct-panel" data-testid={testId} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="ct-modal__head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="ct-modal__close" aria-label="Close" data-testid={`${testId}-close`} onClick={onClose}>
            <Icon name="close" size={uiLength('1rem')} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
