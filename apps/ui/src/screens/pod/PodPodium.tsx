/*
 * A finished tournament's podium (the operator, 2026-10-23: *"i didn't see an end of tournament screen,
 * nor a victory screen for the winner. it's a bit jarring that it just suddenly ends"*; 2026-11-02: *"a
 * sort of 'olympic avatars standing on the podiums' banner"*), built from the canvas "Tournament over"
 * artboard: second, first and third on rising blocks banded in their medal, each player's character
 * dropping on to theirs, a crown and a glow on the winner, confetti in the five colours.
 *
 * Drawn from the standings the server ranked, the first three rows (`PodStandingsRow.rank`); a record and
 * points under each name. `prefers-reduced-motion` gets it still: no rise, no drop, no confetti.
 *
 * `compact` is the Tournaments page's (`../../stats/Tournaments.tsx`): the same podium at the size of a
 * column beside the standings (the operator, 2026-11-08: *"a nice graphic next to the table scores with the
 * podium animation"*). A page lists many, so each holds its first frame until it is scrolled to, plays
 * from there, and stops its loops (confetti, sparkles, the winner's bob) while it is off screen.
 */

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { PodMatchResult } from '@hadoku/shared';

import { Avatar, type Face } from '@hadoku/game-ui/components/Avatar.tsx';
import { PlayerName } from '@hadoku/game-ui/room/look.tsx';
import { records, recordText } from './swiss.ts';
import type { PodStandingsRowLike } from './PodStandings.tsx';
import './PodPodium.css';

export interface PodPodiumProps {
  rows: readonly PodStandingsRowLike[];
  results: readonly PodMatchResult[];
  nameOf: (memberId: string) => string;
  avatarOf: (memberId: string) => Face;
  myMemberId: string | null;
  /** Column-sized, for beside the standings. */
  compact?: boolean;
}

/**
 * `waiting` until the podium is first on screen, then `shown`; `idle` whenever it is off screen again.
 * Without an IntersectionObserver it is simply shown.
 */
function useOnScreen(el: RefObject<HTMLElement | null>): 'waiting' | 'shown' | 'idle' {
  const [phase, setPhase] = useState<'waiting' | 'shown' | 'idle'>(typeof IntersectionObserver === 'undefined' ? 'shown' : 'waiting');
  useEffect(() => {
    const node = el.current;
    if (node === null || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => {
      if (e === undefined) return;
      setPhase((was) => (e.isIntersecting ? 'shown' : was === 'waiting' ? 'waiting' : 'idle'));
    });
    io.observe(node);
    return () => io.disconnect();
  }, [el]);
  return phase;
}

/** Left to right: second, first, third. */
const STAND: readonly (1 | 2 | 3)[] = [2, 1, 3];

/** The colour pie, by its letters (`--c-*`). */
const MANA = ['w', 'u', 'b', 'r', 'g'] as const;
const CONFETTI = Array.from({ length: 34 }, (_, i) => ({
  left: `${(i * 37 + 11) % 100}%`,
  colour: MANA[i % MANA.length]!,
  dur: `${4.5 + ((i * 7) % 5) * 0.6}s`,
  delay: `${1.2 + ((i * 13) % 17) * 0.35}s`,
  w: 6 + (i % 3) * 2,
  h: 10 + (i % 4) * 2,
}));
const SPARKLES = [[-120, 120], [118, 96], [-96, 210], [104, 230], [-150, 40], [146, 40], [0, 18], [60, 150]] as const;

export function PodPodium({ rows, results, nameOf, avatarOf, myMemberId, compact = false }: PodPodiumProps) {
  const el = useRef<HTMLElement>(null);
  const phase = useOnScreen(el);
  if (rows.length < 2) return null;
  const rec = records({ results: [...results] });
  return (
    <section ref={el} className={compact ? 'podium podium--compact' : 'podium'} data-testid="pod-podium" data-phase={phase} aria-label="Podium">
      <div className="podium__confetti" aria-hidden="true">
        {CONFETTI.map((c, i) => (
          <span key={i} data-mana={c.colour} style={{ left: c.left, width: c.w, height: c.h, animationDuration: c.dur, animationDelay: c.delay } as CSSProperties} />
        ))}
      </div>
      <div className="podium__stands">
        {STAND.map((place) => {
          const row = rows[place - 1];
          if (row === undefined) return null;
          const r = rec.get(row.id) ?? { w: 0, l: 0, d: 0 };
          return (
            <div key={place} className="podium__stand" data-place={place} data-mine={row.id === myMemberId ? '' : undefined} data-testid={`pod-podium-${place}`}>
              <div className="podium__figure">
                {place === 1 && (
                  <svg className="podium__crown" viewBox="0 0 44 30" aria-hidden="true">
                    <path d="M3 26 L7 6 L16 16 L22 2 L28 16 L37 6 L41 26 Z" />
                  </svg>
                )}
                <span className="podium__frame">
                  <Avatar {...avatarOf(row.id)} fallback="initial" name={nameOf(row.id)} className="podium__face" fallbackClassName="podium__face podium__face--none" width={128} height={128} />
                </span>
              </div>
              <PlayerName name={nameOf(row.id)} face={avatarOf(row.id)} className="podium__name" />
              <div className="podium__line">
                {recordText(r)} · {row.matchPoints} pts
              </div>
              <div className="podium__block">
                <span className="podium__number">{place}</span>
              </div>
            </div>
          );
        })}
      </div>
      {SPARKLES.map(([dx, y], i) => (
        <span key={i} className="podium__sparkle" aria-hidden="true" style={{ left: `calc(50% + ${dx}px * var(--podium-scale))`, top: `calc(${y}px * var(--podium-scale))`, animationDelay: `${1.8 + i * 0.27}s`, animationDuration: `${1.6 + (i % 3) * 0.4}s` }} />
      ))}
    </section>
  );
}
