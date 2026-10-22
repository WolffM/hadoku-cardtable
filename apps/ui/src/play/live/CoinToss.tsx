/*
 * The coin toss, on BOTH screens — the operator, three times (ledger R2, W1,
 * AE17: *"both players should see the coinflip"*). Forge tosses and asks only
 * the winner "play or draw"; the loser is sent nothing for this moment, so the
 * server tells both seats the result (`forge:seats`' `coinToss`) and this draws
 * it: a coin with one player's face on each side that flips for `FLIP_MS` and
 * lands on the winner's face with the winner's name under it — no sentence. The winner's own Play/Draw question is
 * drawn beside it (`LiveBoard.tsx`); the loser keeps the landed coin where
 * "Waiting for {name}…" used to be, until the winner answers.
 *
 * A toss older than `FLIP_MS` when it arrives (a reload, a late joiner) lands
 * at once; `prefers-reduced-motion` lands at once too (`coin-toss.css`).
 */
import { useEffect, useState, type CSSProperties } from 'react';

import { Avatar } from '../../components/Avatar.tsx';

import './coin-toss.css';

/** The flip's length — `coin-toss.css` reads it as `--flip-ms` and spends it on six half-turns (the operator, 2026-10-09: "too fast and flips too many times"). */
export const FLIP_MS = 2400;

/**
 * Whether the toss stamped `at` is still flipping — `FLIP_MS` old or more is
 * landed. Measured from the server's own stamp, so both screens land together
 * even when one got the fact later; the coin and the winner's Play/Draw
 * question read this one clock.
 */
export function useCoinFlipping(at: number | null): boolean {
  const [flipping, setFlipping] = useState(() => at !== null && Date.now() - at < FLIP_MS);
  useEffect(() => {
    if (at === null) {
      setFlipping(false);
      return;
    }
    const left = FLIP_MS - (Date.now() - at);
    if (left <= 0) {
      setFlipping(false);
      return;
    }
    setFlipping(true);
    const timer = setTimeout(() => setFlipping(false), left);
    return () => clearTimeout(timer);
  }, [at]);
  return flipping;
}

/** One side of the coin: a player's avatar, or the silhouette when they have none. */
function CoinFace({ avatarId, side }: { avatarId: string | undefined; side: 'front' | 'back' }) {
  return (
    <div className={`coin-toss__face coin-toss__face--${side}`}>
      <Avatar id={avatarId} fallback="mark" className="coin-toss__avatar" fallbackClassName="coin-toss__mark" />
    </div>
  );
}

export function CoinToss({
  winner,
  name,
  avatarId,
  loserAvatarId,
  at,
  waiting = false,
}: {
  winner: number;
  name: string;
  avatarId: string | undefined;
  loserAvatarId: string | undefined;
  at: number;
  /** This screen waits on the winner's play-or-draw choice (the seat that lost, or a spectator). */
  waiting?: boolean;
}) {
  const flipping = useCoinFlipping(at);
  // How far into the flip this screen arrived, fixed at mount — a later render must not move the animation.
  const [joinedAt] = useState(() => Math.max(0, Date.now() - at));
  return (
    <section
      className="coin-toss"
      data-testid="coin-toss"
      data-winner={winner}
      data-flipping={flipping || undefined}
      role="status"
      aria-live="polite"
      style={{ '--flip-ms': `${FLIP_MS}ms`, '--flip-delay': `${-joinedAt}ms` } as CSSProperties}
    >
      <div className="coin-toss__coin" aria-hidden="true">
        <CoinFace avatarId={avatarId} side="front" />
        <CoinFace avatarId={loserAvatarId} side="back" />
      </div>
      <p className="coin-toss__name">{name}</p>
      {waiting && !flipping && (
        <p className="coin-toss__wait" data-testid="coin-toss-wait">
          {name} is choosing to play or draw…
        </p>
      )}
    </section>
  );
}
