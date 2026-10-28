/*
 * A coin flipped in the game, as the table draws it (the operator, 2026-10-27: "for coin flip we
 * should just use the coinflip animation we already have"): the match-start coin (`CoinToss.tsx`),
 * flipping to the face Forge's flip came up. Forge tells a flip only as a word ("heads", or "win" for a
 * called flip); the bridge reads the flip where Forge still holds the ability, as it reads a die roll,
 * and hands it to the seat's `message` frame that says it (`@hadoku/forge-wire`'s `CoinFlipSchema`).
 * `match.ts` keeps each as a {@link ShownFlip} (`./shown.ts`); {@link CoinFlips} draws the ones still fresh over the
 * table, beside the question column rather than in it (a flip's resolution is often followed at once by a
 * question, which it must not cover), side by side when several land together.
 *
 * Each new flip sounds Coin flip, which falls back to the toss's coin (`onFlip`, quieter for the other seat's, as their sounds
 * are) and is a beat of the board (`../motion.ts`'s `noteBoardDrawing`): the pacer holds every
 * frame after it, the seat's own and in Fast Mode too, until the coin has landed (`./pace.ts`'s
 * `inTheAir`, as for a die). Reduced motion lands the coin at once and holds nothing.
 */

import { useEffect, useRef, useState } from 'react';

import { noteBoardDrawing, prefersReducedMotion } from '../motion.ts';
import { CoinToss, FLIP_MS, SideFace } from './CoinToss.tsx';
import type { ShownFlip } from './shown.ts';

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
    <div className="coin-flips" data-testid="live-coin-flip-host">
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
  );
}
