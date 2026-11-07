/*
 * A titled panel over a dimmed page, drawn the way the room list's create form is (`../rooms/RoomList.tsx`):
 * Escape, its close button and a press on the backdrop close it. Its `actions`, when it has any, sit
 * along its foot, the affirmative last (bottom right).
 *
 * It is drawn over the page (`./OverPage.tsx`), never inside the screen that opened it.
 */

import { useEffect, useId, type ReactNode } from 'react';
import { Icon } from '@wolffm/themes';

import { uiLength } from '@hadoku/ui-shell/settings';
import { OverPage } from './OverPage.tsx';
import './Modal.css';

export function Modal({
  title,
  testId,
  onClose,
  children,
  actions,
  wide = false,
}: {
  title: string;
  testId: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  /** A reading panel (long text) rather than a short question: wider than the default. */
  wide?: boolean;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.document?.addEventListener('keydown', onKey);
    return () => globalThis.document?.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <OverPage>
      <div
        className="ct-modal"
        data-testid={`${testId}-backdrop`}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="ct-modal__panel ct-surface ct-panel" data-wide={wide || undefined} data-testid={testId} role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className="ct-modal__head">
            <h3 id={titleId}>{title}</h3>
            <button type="button" className="ct-modal__close" aria-label="Close" data-testid={`${testId}-close`} onClick={onClose}>
              <Icon name="close" size={uiLength('1rem')} />
            </button>
          </div>
          {children}
          {actions !== undefined && <div className="ct-modal__actions">{actions}</div>}
        </div>
      </div>
    </OverPage>
  );
}
