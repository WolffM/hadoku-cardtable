/*
 * A titled panel over a dimmed page, drawn the way the room list's create form is (`../rooms/RoomList.tsx`):
 * Escape, its close button and a press on the backdrop close it. Its `actions`, when it has any, sit
 * along its foot, the affirmative last (bottom right).
 *
 * It portals into the app's chrome root: `.shell` carries `contain: layout` (`../screens/screens.css`),
 * which makes it the containing block for `position: fixed`, so a modal drawn inside it covered only
 * the shell — under the header and past the window's foot. The chrome root still carries the theme.
 */

import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@wolffm/themes';

import { uiLength } from '../settings/ui-scale.ts';
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

  const drawn = (
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
  );
  const host = globalThis.document?.querySelector('.cardtable-chrome') ?? globalThis.document?.body;
  return host === undefined ? drawn : createPortal(drawn, host);
}
