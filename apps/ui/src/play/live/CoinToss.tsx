/*
 * The coin toss, on BOTH screens — the operator, three times (ledger R2, W1,
 * AE17: *"both players should see the coinflip"*). Forge tosses and asks only
 * the winner "play or draw"; the loser is sent nothing for this moment, so the
 * server tells both seats the result (`forge:seats`' `coinToss`) and this draws
 * it: a coin that flips for `FLIP_MS` and lands on the winner's face with the
 * winner's name under it — no sentence. The winner's own Play/Draw question is
 * drawn beside it (`LiveBoard.tsx`); the loser keeps the landed coin where
 * "Waiting for {name}…" used to be, until the winner answers.
 *
 * A toss older than `FLIP_MS` when it arrives (a reload, a late joiner) lands
 * at once; `prefers-reduced-motion` lands at once too (`coin-toss.css`).
 */
import { useEffect, useState } from 'react';

import { avatarSquareUrl } from '../../room/avatar.ts';

import './coin-toss.css';

/** The flip's length — the house curve in `coin-toss.css` spends it on ten half-turns. */
export const FLIP_MS = 1200;

export function CoinToss({ winner, name, avatarId, at }: { winner: number; name: string; avatarId: string | undefined; at: number }) {
  // Flipping until the toss is `FLIP_MS` old — measured from the server's own
  // stamp, so both screens land together even when one got the fact later.
  const [flipping, setFlipping] = useState(() => Date.now() - at < FLIP_MS);
  useEffect(() => {
    const left = FLIP_MS - (Date.now() - at);
    if (left <= 0) {
      setFlipping(false);
      return;
    }
    const timer = setTimeout(() => setFlipping(false), left);
    return () => clearTimeout(timer);
  }, [at]);
  const avatar = avatarId === undefined ? null : avatarSquareUrl(avatarId);
  return (
    <section className="coin-toss" data-testid="coin-toss" data-winner={winner} data-flipping={flipping || undefined} role="status" aria-live="polite">
      <div className="coin-toss__coin" aria-hidden="true">
        <div className="coin-toss__face coin-toss__face--front">
          {avatar === null ? (
            <svg className="coin-toss__mark" viewBox="0 0 48 48" focusable="false">
              <circle cx="24" cy="19" r="10" />
              <path d="M8 42a16 16 0 0 1 32 0Z" />
            </svg>
          ) : (
            <img className="coin-toss__avatar" src={avatar} alt="" />
          )}
        </div>
        <div className="coin-toss__face coin-toss__face--back" />
      </div>
      <p className="coin-toss__name">{name}</p>
    </section>
  );
}
