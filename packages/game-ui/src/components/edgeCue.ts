/*
 * A sideways scroller's edge cue (`./EdgeCue.css`): the fade and chevron on each edge it can still
 * scroll toward. The direction is the information, so there is no count and no element: two classes
 * on the scroller, toggled imperatively, since a scroll fires every frame while a finger drags it and
 * two class toggles cost far less than a React render for the same frame.
 */

import { useEffect, useLayoutEffect, type RefObject } from 'react';

import './EdgeCue.css';

const SCROLLS = new Set(['auto', 'scroll']);

/**
 * Mark `el`'s edges: `edge-cue--l` while it can scroll left, `edge-cue--r` while it can scroll right.
 * Drawn only where `el` also has the class `edge-cue`, which its owner gives it (portrait's lanes have it
 * only in portrait, so a lane measured once in portrait draws nothing back on the desktop board).
 */
export function measureEdgeCue(el: HTMLElement): void {
  // A strip that overflows without scrolling (a game drawing the seats in a row that spills on purpose) has no edge to cue.
  const scrolls = SCROLLS.has(getComputedStyle(el).overflowX);
  // A pixel of slack either way, for a fractional `scrollLeft`.
  const room = scrolls ? el.scrollWidth - el.clientWidth : 0;
  el.classList.toggle('edge-cue--l', el.scrollLeft > 1);
  el.classList.toggle('edge-cue--r', el.scrollLeft < room - 1);
}

/**
 * Keep `ref`'s scroller's edge cue current: on its scroll, on a change of its own size (a window
 * resized across a breakpoint), and after every commit of the component that draws it, since an item
 * arriving or leaving changes its `scrollWidth` without resizing its box.
 */
export function useEdgeCue(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (ref.current !== null) measureEdgeCue(ref.current);
  });
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const measure = () => measureEdgeCue(el);
    el.addEventListener('scroll', measure, { passive: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resized?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      resized?.disconnect();
    };
  }, [ref]);
}
