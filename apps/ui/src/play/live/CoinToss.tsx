/*
 * The one coin: the toss for who goes first, and every coin flipped in the game.
 *
 * The toss, on BOTH screens — the operator, three times (ledger R2, W1, AE17: *"both players should
 * see the coinflip"*). Forge tosses and asks only the winner "play or draw"; the loser is sent nothing
 * for this moment, so the server tells both seats the result (`forge:seats`' `coinToss`) and the coin
 * has one player's face on each side, lands on the winner's face with the winner's name under it — no
 * sentence. The winner's own Play/Draw question is drawn beside it (`LiveBoard.tsx`); the loser keeps
 * the landed coin where "Waiting for {name}…" used to be, until the winner answers.
 *
 * A flip in the game (the operator, 2026-10-27: "for coin flip we should just use the coinflip
 * animation we already have"): the same coin, heads on one side and tails on the other, landing on the
 * face Forge's flip came up (`./coin-flip.ts`), with Forge's own words for it under it. A called flip
 * lands ringed in the theme's success or danger colour: the call won or lost.
 *
 * A coin older than `FLIP_MS` when it arrives (a reload, a late joiner) lands at once;
 * `prefers-reduced-motion` lands at once too (`coin-toss.css`).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { Avatar } from '../../components/Avatar.tsx';

import './coin-toss.css';

/** The flip's length — `coin-toss.css` reads it as `--flip-ms` and spends it on six half-turns (the operator, 2026-10-09: "too fast and flips too many times"). */
export const FLIP_MS = 2400;

/**
 * Whether the coin stamped `at` is still flipping — `FLIP_MS` old or more is landed. Measured from the
 * stamp, so both screens land together even when one got the fact later; the coin and the toss winner's
 * Play/Draw question read this one clock.
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

/** A side of the coin that is a player: their avatar, or the silhouette when they have none. */
export function PlayerFace({ avatarId }: { avatarId: string | undefined }) {
  return <Avatar id={avatarId} fallback="mark" className="coin-toss__avatar" fallbackClassName="coin-toss__mark" />;
}

/** A side of the coin that is heads or tails: its letter, as a coin is marked. */
export function SideFace({ side }: { side: 'heads' | 'tails' }) {
  return <span className="coin-toss__side">{side === 'heads' ? 'H' : 'T'}</span>;
}

export function CoinToss({
  front,
  back,
  caption,
  at,
  won,
  after,
  testId = 'coin-toss',
  data,
}: {
  /** The side it lands on. */
  front: ReactNode;
  back: ReactNode;
  /** Under the coin: the toss winner's name, a flip's own words. */
  caption: string;
  at: number;
  /** A called flip: whether the call was won. Absent when nobody called it. */
  won?: boolean | null;
  /** Under the caption, once the coin has landed. */
  after?: ReactNode;
  testId?: string;
  /** `data-*` attributes for the coin's own section. */
  data?: Record<`data-${string}`, string | number | undefined>;
}) {
  const flipping = useCoinFlipping(at);
  // How far into the flip this screen arrived, fixed at mount — a later render must not move the animation.
  const [joinedAt] = useState(() => Math.max(0, Date.now() - at));
  return (
    <section
      className="coin-toss"
      data-testid={testId}
      data-flipping={flipping || undefined}
      data-won={won == null ? undefined : String(won)}
      {...data}
      role="status"
      aria-live="polite"
      style={{ '--flip-ms': `${FLIP_MS}ms`, '--flip-delay': `${-joinedAt}ms` } as CSSProperties}
    >
      <div className="coin-toss__coin" aria-hidden="true">
        <div className="coin-toss__face coin-toss__face--front">{front}</div>
        <div className="coin-toss__face coin-toss__face--back">{back}</div>
      </div>
      <p className="coin-toss__name">{caption}</p>
      {!flipping && after}
    </section>
  );
}

/** The toss for who goes first: a player's face on each side, landing on the winner's, the winner's name under it. */
export function TossCoin({
  toss,
  waiting = false,
}: {
  toss: { winner: number; name: string; avatarId: string | undefined; loserAvatarId: string | undefined; at: number };
  /** This screen waits on the winner's play-or-draw choice (the seat that lost, or a spectator). */
  waiting?: boolean;
}) {
  return (
    <CoinToss
      front={<PlayerFace avatarId={toss.avatarId} />}
      back={<PlayerFace avatarId={toss.loserAvatarId} />}
      caption={toss.name}
      at={toss.at}
      data={{ 'data-winner': toss.winner }}
      after={
        waiting && (
          <p className="coin-toss__wait" data-testid="coin-toss-wait">
            {toss.name} is choosing to play or draw…
          </p>
        )
      }
    />
  );
}
