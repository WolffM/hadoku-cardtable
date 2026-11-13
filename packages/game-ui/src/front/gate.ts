/*
 * The front page shows itself once: every part that reads something stands as its skeleton until
 * every one of them has its answer, then they all crossfade in together (`../components/Reveal.tsx`)
 * — the operator, 2026-10-31: *"a loading skeleton … that waits for things to be ready"*. Measured
 * before: the parts arrived one at a time over two seconds, and the live slot's late answer moved
 * every card beside it (`e2e/front-skeleton.spec.ts`).
 *
 * A slow part never holds the page past `HOLD_MS`: the page shows what it has, and the late part
 * stays a skeleton in its own box until its answer lands, then fades in there alone.
 *
 * Outside the front page (a test mounting one card, a card on another screen) there is no gate: a
 * part shows the moment it is ready.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { FIRST_VISIT, loadFrontShape, saveFrontShape, type FrontShape } from './shape.ts';

/**
 * The parts that read before they can draw. Patch notes ship in the bundle and never wait. `trim` is
 * the site's look (`../settings/siteTrim.ts`), drawn on the whole page: the page is not shown before it.
 */
export type FrontPart = 'rooms' | 'live' | 'upcoming' | 'wildcard' | 'trim';

const PARTS: readonly FrontPart[] = ['rooms', 'live', 'upcoming', 'wildcard', 'trim'];

/** The longest the page waits on a slow part before showing the rest. The wildcard's own wait is 2 s. */
export const HOLD_MS = 2_500;

export interface FrontGate {
  /** The page has shown itself: a ready part may draw. */
  revealed: boolean;
  /** A part has its answer. */
  settle: (part: FrontPart) => void;
  /** The page's shape last visit (`./shape.ts`): what the skeleton draws. */
  shape: FrontShape;
  /** A part says what it drew this time, for the next visit's skeleton. */
  remember: (seen: Partial<FrontShape>) => void;
}

const UNGATED: FrontGate = { revealed: true, settle: () => undefined, shape: FIRST_VISIT, remember: () => undefined };

export const FrontGateContext = createContext<FrontGate>(UNGATED);

/** The gate itself, held by the front page: revealed once every part has settled, or `HOLD_MS` has passed. */
export function useFrontGateState(holdMs: number = HOLD_MS): FrontGate {
  const [waiting, setWaiting] = useState<ReadonlySet<FrontPart>>(() => new Set(PARTS));
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHeld(true), holdMs);
    return () => clearTimeout(timer);
  }, [holdMs]);
  const settle = useCallback((part: FrontPart): void => {
    setWaiting((prev) => {
      if (!prev.has(part)) return prev;
      const next = new Set(prev);
      next.delete(part);
      return next;
    });
  }, []);
  const shape = useState(loadFrontShape)[0];
  const seen = useRef<FrontShape>(shape);
  const remember = useCallback((next: Partial<FrontShape>): void => {
    seen.current = { ...seen.current, ...next };
    saveFrontShape(seen.current);
  }, []);
  const revealed = held || waiting.size === 0;
  return useMemo(() => ({ revealed, settle, shape, remember }), [revealed, settle, shape, remember]);
}

/** Whether `part` draws its content now: it is ready, and the page has shown itself. */
export function usePartShown(part: FrontPart, ready: boolean): boolean {
  const { revealed, settle } = useContext(FrontGateContext);
  useEffect(() => {
    if (ready) settle(part);
  }, [ready, part, settle]);
  return revealed && ready;
}
