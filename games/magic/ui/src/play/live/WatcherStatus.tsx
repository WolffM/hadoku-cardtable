/*
 * A watcher's line: the word, and the one control a watcher has, turning the table around
 * (`match.ts`'s `flipPerspective`, client-only). The operator, 2026-11-01: *"Spectators should be
 * able to have the switch perspective button"*, then, on its look: *"let's put the watching button
 * between the two avatars instead."*
 *
 * It sits on the centre line between the two seats, centred on their marks (`.seat__ident
 * .face__art`), in the gap the two bars leave there (`card.css`: each keeps 16px on its centre side
 * so the priority rings stand apart). Nothing else of either bar is in that gap: the clocks and the
 * life totals are on each mark's outer side. Where the marks are is the board's own layout, so it
 * is measured, not restated here: once drawn, and again whenever the board or a seat changes size.
 *
 * Not drawn for the front page's card (`followsTurn`): that board follows the turn by itself, and
 * the card says LIVE or REPLAY in its own title.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { usePortraitLayout } from '../portrait.ts';
import { flipPerspective, type LiveMatch } from './match.ts';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How close the line may come to the board's left edge. */
const EDGE_PX = 4;

/**
 * Where the line's centre goes, in `root`'s coordinates: halfway between the top seat's mark and
 * the bottom seat's, on their shared centre — moved right only as far as keeps a line `width` wide
 * off the board's left edge. Null until both marks are drawn.
 */
export function watchSpot(root: Box, top: Box | null, bottom: Box | null, width: number): { x: number; y: number } | null {
  if (top === null || bottom === null) return null;
  const x = (top.left + top.right + bottom.left + bottom.right) / 4 - root.left;
  const y = (top.bottom + bottom.top) / 2 - root.top;
  return { x: Math.max(x, width / 2 + EDGE_PX), y };
}

const MARK = '.seat__ident .face__art';

function useWatchSpot(lineRef: RefObject<HTMLElement | null>, drawn: boolean): { x: number; y: number } | null {
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const line = lineRef.current;
    // The box the line is placed in: the live board's root, which also holds both seats.
    const root = line?.offsetParent ?? null;
    if (line === null || root === null || !drawn) return undefined;
    const measure = (): void => {
      const box = (el: Element | null): Box | null => el?.getBoundingClientRect() ?? null;
      const next = watchSpot(root.getBoundingClientRect(), box(root.querySelector(`.seat:not([data-viewer]) ${MARK}`)), box(root.querySelector(`.seat[data-viewer] ${MARK}`)), line.offsetWidth);
      setSpot((was) => (was?.x === next?.x && was?.y === next?.y ? was : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    for (const seat of root.querySelectorAll('.seat')) ro.observe(seat);
    return () => ro.disconnect();
  }, [lineRef, drawn]);
  return spot;
}

export function WatcherStatus({ match }: { match: LiveMatch }) {
  const lineRef = useRef<HTMLParagraphElement>(null);
  // A phone held upright draws no seat column to stand between, and a watcher has no action bar
  // there: the line takes the bar's place on the bottom edge (`live.css`), and is placed by it.
  const portrait = usePortraitLayout();
  const spot = useWatchSpot(lineRef, match.view !== null && !portrait);
  return (
    <p
      ref={lineRef}
      className="live__watching"
      role="status"
      data-testid="watcher-status"
      data-role="watcher"
      data-placed={portrait || spot !== null ? '' : undefined}
      style={portrait || spot === null ? undefined : { left: `${spot.x}px`, top: `${spot.y}px` }}
    >
      <span>Watching</span>
      <button type="button" className="live__flip" data-testid="perspective-flip" aria-label="Switch sides" disabled={match.view === null} onClick={() => flipPerspective(match)}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M3 5.5h7.2L8.6 3.9 9.7 2.8 13.2 6.3 9.7 9.8 8.6 8.7l1.6-1.6H3Z" />
          <path d="M13 10.5H5.8l1.6 1.6-1.1 1.1L2.8 9.7 6.3 6.2l1.1 1.1-1.6 1.6H13Z" />
        </svg>
      </button>
    </p>
  );
}
