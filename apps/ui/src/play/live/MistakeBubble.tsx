/*
 * AF409 (2026-10-26, the operator: "you can ship it"): the seat's own character says what it got
 * wrong. Ported from the approved preview's "Speech + card" variant
 * (`~/.cache/cardtable-manager/af409-preview/src/preview.tsx`, `preview.css`) — the look is theirs,
 * not redesigned; only the anchor measurement is adapted for the real app (the preview owned its
 * own isolated stage div; this one does not, so it anchors through a document-wide query and a
 * `position: fixed` portal instead of a stage-relative `position: absolute`).
 *
 * `match.mistake` (`./match.ts`, set beside `match.refused` by `./mistakes.ts`'s classifier) names
 * the line; `[data-player-face][data-viewer] .face__hit` — the same node the settings popover
 * anchors from (`Board.tsx`) — is always this seat's OWN face, never the opponent's or a watcher's
 * (a watcher's window has no `data-viewer` face at all when it has turned the table around, and in
 * any case never receives a `match.mistake` — `match.ts`'s own watcher gate on `reportRefusedClick`,
 * and `refuse()` never runs for a seat that never acts). The existing card shake (`match.refused`,
 * drawn by `Board.tsx`/`card.css`) is untouched and keeps marking the card either way.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { MISTAKE_LINES, type MistakeKey } from './mistakes.ts';

import './mistake.css';

/** How long a line stays up, then how long its exit takes — the preview's own timing, mirrored by `match.ts`'s `MISTAKE_SAY_MS`/`MISTAKE_EXIT_MS` (the clock that actually clears `match.mistake`). */
export const MISTAKE_SAY_MS = 3200;
export const MISTAKE_EXIT_MS = 260;

const FACE_HIT_SELECTOR = '[data-player-face][data-viewer] .face__hit';

/** The viewer's own face, in viewport coordinates — `position: fixed` reads these directly, no stage to subtract. */
function useFaceBox(): DOMRect | null {
  const [box, setBox] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const measure = (): void => {
      const face = document.querySelector(FACE_HIT_SELECTOR);
      setBox(face === null ? null : face.getBoundingClientRect());
    };
    measure();
    const face = document.querySelector(FACE_HIT_SELECTOR);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (face !== null) ro?.observe(face);
    // A fallback poll, same as the preview: the face can move (a resize, a layout change) without
    // firing the observer when it is the PAGE that scrolled under a fixed-position bubble.
    const t = window.setInterval(measure, 500);
    return () => {
      ro?.disconnect();
      window.clearInterval(t);
    };
  }, []);
  return box;
}

export interface MistakeBubbleProps {
  /** `LiveMatch.mistake` — null draws nothing. */
  mistake: { key: MistakeKey; seq: number } | null;
  /** The "Say my mistakes" setting (`./prefs.ts`'s `mistakeBubbles`, default on). Off draws nothing here; the card shake stays, drawn elsewhere. */
  enabled: boolean;
}

/** The seat's own character says what it got wrong — a speech bubble out of its own face, with a tail. */
export function MistakeBubble({ mistake, enabled }: MistakeBubbleProps) {
  const box = useFaceBox();
  const [leaving, setLeaving] = useState(false);
  const shownSeq = useRef<number | null>(null);

  useEffect(() => {
    if (mistake === null) {
      shownSeq.current = null;
      setLeaving(false);
      return undefined;
    }
    if (shownSeq.current === mistake.seq) return undefined;
    shownSeq.current = mistake.seq;
    setLeaving(false);
    const t = window.setTimeout(() => setLeaving(true), MISTAKE_SAY_MS);
    return () => window.clearTimeout(t);
  }, [mistake]);

  if (!enabled || mistake === null || box === null) return null;

  const left = box.right + 12;
  const style = {
    left,
    top: box.top + box.height * 0.3,
    maxWidth: Math.max(140, window.innerWidth - left - 12),
  };
  return createPortal(
    <div className="mistake" data-leaving={leaving || undefined} data-testid="mistake-bubble" data-mistake={mistake.key} role="status" aria-live="polite" style={style}>
      {MISTAKE_LINES[mistake.key]}
    </div>,
    document.body,
  );
}
