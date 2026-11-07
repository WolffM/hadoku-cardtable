/*
 * A box's skeleton, then its content, crossfaded in the same place (the operator, 2026-10-31, of the
 * front page: *"introduce a loading skeleton … that waits for things to be ready. help me with a nice
 * transition between the loading skeleton and the page"*).
 *
 * Both layers sit in one grid cell, so the content lands exactly where its skeleton stood. The content
 * is mounted from the start, hidden: whatever it reads or measures while it waits, it has done by the
 * time it is shown. `shown` going true fades the content in over the skeleton (`reveal.css`), then the
 * skeleton is dropped; going false again (a Retry) brings the skeleton back.
 *
 * `data-reveal` names the box and `data-phase` says where it is, for `e2e/front-skeleton.spec.ts`.
 * `onShown` hears when the crossfade has finished (and when the skeleton comes back): work that must
 * wait until the box is shown waits on this, never on a timer of its own the same length as the fade.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import './reveal.css';

/** How long the crossfade runs: `reveal.css`'s own `--reveal-ms`. */
export const REVEAL_MS = 280;

type Phase = 'waiting' | 'fading' | 'shown';

export interface RevealProps {
  /** The content is ready to be seen. */
  shown: boolean;
  /** What stands in its place until then, in the content's own boxes. */
  skeleton: ReactNode;
  children: ReactNode;
  /** The box's name, for `data-reveal`. */
  name: string;
  /** Classes for the box itself (how it sits in its parent). */
  className?: string;
  /** Classes for each of the two layers (how each lays out what it holds), so both lay out alike. */
  layerClassName?: string;
  /** Told, after the box is drawn that way, whether it is shown: true once the crossfade is done. */
  onShown?: (shown: boolean) => void;
}

export function Reveal({ shown, skeleton, children, name, className, layerClassName, onShown }: RevealProps) {
  const [phase, setPhase] = useState<Phase>(shown ? 'shown' : 'waiting');
  const told = useRef(onShown);
  told.current = onShown;
  useEffect(() => {
    told.current?.(phase === 'shown');
  }, [phase]);
  useEffect(() => {
    if (!shown) {
      setPhase('waiting');
      return undefined;
    }
    setPhase((p) => (p === 'shown' ? p : 'fading'));
    const done = setTimeout(() => setPhase('shown'), REVEAL_MS);
    return () => clearTimeout(done);
  }, [shown]);

  const layer = layerClassName === undefined ? 'reveal__layer' : `reveal__layer ${layerClassName}`;
  return (
    <div className={className === undefined ? 'reveal' : `reveal ${className}`} data-reveal={name} data-phase={phase}>
      {phase !== 'shown' && (
        <div className={`${layer} reveal__skeleton`} aria-hidden="true">
          {skeleton}
        </div>
      )}
      <div className={`${layer} reveal__content`}>{children}</div>
    </div>
  );
}
