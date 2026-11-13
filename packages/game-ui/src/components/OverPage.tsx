/*
 * Where a layer placed in the window's own coordinates is drawn: the app's chrome root, outside every
 * screen's box.
 *
 * A fit screen (`.shell--fit`, `../screens/screens.css`) carries `contain: layout`, which makes it the
 * containing block of every `position: fixed` box inside it. Drawn there, a layer placed from
 * `getBoundingClientRect()` is offset by the screen's own corner, scrolls with its content, and counts
 * toward its scroll extent: a deck peek open beside the room's grid made the room scroll sideways
 * (`e2e/lobby-fit.spec.ts`), and a modal covered only the screen. Every such layer (a modal, a
 * popover, a peek, a backdrop) is drawn through this instead, where `fixed` means the window. The
 * chrome root carries the theme; inside the embed's shadow root it is looked up there.
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { documentScope } from '../dom.ts';

export function OverPage({ children }: { children: ReactNode }) {
  if (globalThis.document === undefined) return children;
  const scope = documentScope();
  const host = scope.querySelector('.cardtable-chrome') ?? scope.querySelector('body') ?? document.body;
  return createPortal(children, host);
}
