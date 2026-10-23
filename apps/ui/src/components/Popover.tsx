/*
 * A small titled panel opened from a button and placed beside it: the settings gear's
 * (`../settings/Settings.tsx`) and a room's Match rules (`../rooms/MatchRules.tsx`).
 * Escape, its close button and a press anywhere outside it close it; a press on the button that
 * opened it is that button's to handle (`usePopover`'s toggle).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@wolffm/themes';

import { useDismiss } from '../popover.ts';
import { uiLength } from '../settings/ui-scale.ts';
import './Popover.css';

/** The gap between the popover and what opened it, and its distance from the viewport's edges. */
const GAP = 8;

interface Placement {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/** Above an anchor in the lower half, below one in the upper; aligned to the anchor's nearer side. */
function place(anchor: DOMRect): Placement {
  const vw = globalThis.innerWidth;
  const vh = globalThis.innerHeight;
  const vertical = anchor.top + anchor.height / 2 > vh / 2 ? { bottom: Math.max(GAP, vh - anchor.top + GAP) } : { top: anchor.bottom + GAP };
  const horizontal = anchor.left + anchor.width / 2 > vw / 2 ? { right: Math.max(GAP, vw - anchor.right) } : { left: Math.max(GAP, anchor.left) };
  return { ...vertical, ...horizontal };
}

export interface PopoverProps {
  /** What opened it: the popover is placed beside it, and a press on it is the trigger's to handle. */
  trigger: Element;
  onClose: () => void;
  title: string;
  /** The panel's test id; its close button's is `<testId>-close`. */
  testId: string;
  children?: ReactNode;
}

export function Popover({ trigger, onClose, title, testId, children }: PopoverProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>(() => place(trigger.getBoundingClientRect()));
  useLayoutEffect(() => setPlacement(place(trigger.getBoundingClientRect())), [trigger]);

  useDismiss(onClose, useCallback((target: Node) => ref.current?.contains(target) !== false || trigger.contains(target), [trigger]));
  useEffect(() => ref.current?.focus(), []);

  return (
    <div ref={ref} className="ct-popover ct-surface ct-panel" role="dialog" aria-labelledby={titleId} data-testid={testId} tabIndex={-1} style={placement}>
      <div className="ct-popover__head">
        <h2 id={titleId} className="ct-popover__title ct-panel__title">
          {title}
        </h2>
        <button type="button" className="ct-popover__close" aria-label={`Close ${title.toLowerCase()}`} data-testid={`${testId}-close`} onClick={onClose}>
          <Icon name="close" size={uiLength('1rem')} />
        </button>
      </div>
      {children}
    </div>
  );
}

/** Which trigger has the popover open, if any. Pressing that trigger again closes it. */
export function usePopover(): { trigger: Element | null; toggle: (el: Element) => void; close: () => void } {
  const [trigger, setTrigger] = useState<Element | null>(null);
  const close = useCallback(() => setTrigger(null), []);
  const toggle = useCallback((el: Element) => setTrigger((open) => (open === null ? el : null)), []);
  return { trigger, toggle, close };
}
