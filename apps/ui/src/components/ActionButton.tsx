/*
 * A button that does one thing, and stays the element of that one thing.
 *
 * The class this exists for: a control replaced in place by its inverse. A
 * pod seat's "AI" and the "Remove" the room draws once the AI sits are the
 * same position in the same row, so React reused the one `<button>` and only
 * swapped its label and handler — a press aimed at "AI" that landed after the
 * room's update removed the AI it had just seated (forge.yml 39844107553:
 * AI seat 2, seat 2 given back, AI seat 3, from a driver that only ever
 * pressed AI). A person's double click does the same thing by hand.
 *
 * Two rules, both here so no screen re-derives them:
 *
 * - `action` names what a press does, and is the button's key: a different
 *   action is a different element, so anything that resolved the old one (a
 *   test driver's handle, a press already on its way) finds it detached
 *   instead of firing the new one. Keyboard focus moves to the replacement.
 * - The second click of a double click (`detail` ≥ 2) fires only on the
 *   element that took the first: a control drawn because of the first click
 *   never catches the second.
 */

import { useCallback, useRef, type ComponentPropsWithoutRef, type MouseEvent } from 'react';

/** The element that took the first click of the current click sequence. */
let sequenceStart: EventTarget | null = null;

/** Whether this click is a press of the element it landed on (see the header). */
export function pressLandsOn(event: MouseEvent<Element>): boolean {
  if (event.detail <= 1) {
    sequenceStart = event.currentTarget;
    return true;
  }
  return event.currentTarget === sequenceStart;
}

export type ActionButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'onClick' | 'type' | 'ref'> & {
  /** What a press does; two actions are two elements, never one morphed into the other. */
  action: string;
  onPress: () => void;
};

export function ActionButton({ action, onPress, ...button }: ActionButtonProps) {
  const carryFocus = useRef(false);
  const ref = useCallback((node: HTMLButtonElement) => {
    if (carryFocus.current) {
      carryFocus.current = false;
      node.focus();
    }
    return () => {
      carryFocus.current = node.ownerDocument.activeElement === node;
    };
  }, []);
  return (
    <button
      key={action}
      ref={ref}
      type="button"
      data-action={action}
      {...button}
      onClick={(e) => {
        if (pressLandsOn(e)) onPress();
      }}
    />
  );
}
