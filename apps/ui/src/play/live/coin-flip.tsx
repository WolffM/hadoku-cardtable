/*
 * A coin flipped in the game, as the table draws it (the operator, 2026-10-27: "for coin flip we
 * should just use the coinflip animation we already have"): the match-start coin (`CoinToss.tsx`),
 * flipping to the face Forge's flip came up. Forge tells a flip only as a word ("heads", or "win" for a
 * called flip); the bridge reads the flip where Forge still holds the ability, as it reads a die roll,
 * and hands it to the seat's `message` frame that says it (`@hadoku/forge-wire`'s `CoinFlipSchema`).
 * `match.ts` keeps each as a {@link ShownFlip}; {@link CoinFlips} draws the ones still fresh, in the
 * question column as the toss is, side by side when several land together.
 *
 * Each new flip sounds the toss's own coin (`onFlip`, quieter for the other seat's, as their sounds
 * are) and is a beat of the board (`../motion.ts`'s `noteBoardDrawing`): the pacer holds what the
 * other seat did next until the coin has landed, and never holds the seat's own acts (`./pace.ts`).
 * Fast Mode holds nothing; reduced motion lands the coin at once and holds nothing either.
 */

import { useEffect, useRef, useState } from 'react';

import type { CoinFlip } from '@hadoku/forge-wire';

import { noteBoardDrawing, prefersReducedMotion } from '../motion.ts';
import { CoinToss, FLIP_MS, SideFace } from './CoinToss.tsx';
import { QuestionHost } from './movable.tsx';

/** A flip as the table draws it: numbered once for the page's life, when it arrived, and the words Forge said it in. */
export interface ShownFlip {
  readonly id: number;
  readonly at: number;
  readonly player: number;
  /** Null: the flip was called by a player whose call the bridge never saw. */
  readonly outcome: 'heads' | 'tails' | null;
  /** Null: nobody called it. */
  readonly won: boolean | null;
  readonly source: number | null;
  readonly text: string;
}

let lastFlipId = 0;

/** The wire's flip, numbered and stamped as it arrives, with the message that said it. */
export function shownFlip(flip: CoinFlip, text: string, at: number = Date.now()): ShownFlip {
  lastFlipId += 1;
  return { id: lastFlipId, at, player: flip.player.id, outcome: flip.outcome, won: flip.won, source: flip.source?.id ?? null, text };
}

/** How long a landed coin stays before it goes: its result is in the log after that. */
export const FLIP_LINGER_MS = 1500;

/** The most coins drawn at once: a run of flips (each player flipping, again and again) shows its latest. */
export const FLIPS_SHOWN = 4;

/** The flips still on the table at `now`: flipping, or landed less than {@link FLIP_LINGER_MS} ago, the latest few. */
export function freshFlips(flips: readonly ShownFlip[], now: number): ShownFlip[] {
  return flips.filter((f) => now - f.at < FLIP_MS + FLIP_LINGER_MS).slice(-FLIPS_SHOWN);
}

/**
 * The game's fresh flips, each a coin, in a question host of their own. `viewer` is the seat's player
 * (null for a watcher); `onFlip` is told of each flip new to this screen, once, as it starts.
 */
export function CoinFlips({ flips, viewer, onFlip }: { flips: readonly ShownFlip[]; viewer: number | null; onFlip: (flip: ShownFlip) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<Set<number> | null>(null);
  seen.current ??= new Set(flips.filter((f) => Date.now() - f.at >= FLIP_MS).map((f) => f.id));
  const fresh = freshFlips(flips, now);
  useEffect(() => {
    const started = Date.now();
    setNow(started);
    for (const flip of flips) {
      if (seen.current!.has(flip.id)) continue;
      seen.current!.add(flip.id);
      const left = FLIP_MS - (started - flip.at);
      if (left <= 0) continue;
      onFlip(flip);
      if (!prefersReducedMotion()) noteBoardDrawing(new Promise((landed) => setTimeout(landed, left)));
    }
  }, [flips]);
  // Redrawn as the oldest coin on the table runs out, so it goes.
  useEffect(() => {
    const oldest = fresh[0];
    if (oldest === undefined) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, oldest.at + FLIP_MS + FLIP_LINGER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [fresh[0]?.id, now]);
  if (fresh.length === 0) return null;
  return (
    <QuestionHost data-testid="live-coin-flip-host">
      <div className="coin-flips">
        {fresh.map((f) => (
          <CoinToss
            key={f.id}
            testId="coin-flip"
            front={f.outcome === null ? null : <SideFace side={f.outcome} />}
            back={<SideFace side={f.outcome === 'heads' ? 'tails' : 'heads'} />}
            caption={f.text}
            at={f.at}
            won={f.won}
            data={{ 'data-flip': f.id, 'data-outcome': f.outcome ?? undefined, 'data-flipper': f.player === viewer ? 'you' : 'them' }}
          />
        ))}
      </div>
    </QuestionHost>
  );
}
