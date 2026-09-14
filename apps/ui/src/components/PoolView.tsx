/**
 * The picked pool — everything this seat has taken, and only this seat.
 *
 * Grouped by mana value, because the question a drafter asks of their own pool
 * mid-pack is "what does my curve look like", and a flat list in pick order
 * answers a question nobody asks. Colour counts sit above it for the same
 * reason: they are what the next pick is decided against.
 *
 * Pool cards are not pickable and render without a button, so a stray click on
 * your own pool cannot send anything.
 */

import type { DraftCard, ManaColor } from '../draft/types.ts';
import { CardTile } from './CardTile.tsx';
import { ManaPip } from './ManaPip.tsx';

const COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

function byManaValue(cards: readonly DraftCard[]): Array<[number, DraftCard[]]> {
  const buckets = new Map<number, DraftCard[]>();
  for (const card of cards) {
    const key = card.manaValue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(card);
    else buckets.set(key, [card]);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
}

export function PoolView({ cards }: { cards: readonly DraftCard[] }) {
  const counts = COLORS.map(
    (c) => [c, cards.filter((card) => card.colors.includes(c)).length] as const,
  );

  return (
    <section className="pool" data-testid="pool" aria-label="Your picked pool">
      <header className="pool__head">
        <h2 className="pool__title">
          Your pool <span data-testid="pool-count">{cards.length}</span>
        </h2>
        <div className="pool__colors">
          {counts.map(([color, n]) => (
            <span
              key={color}
              className={n === 0 ? 'pool__color pool__color--none' : 'pool__color'}
              data-testid={`pool-color-${color}`}
            >
              <ManaPip token={color} />
              <span className="pool__color-n">{n}</span>
            </span>
          ))}
        </div>
      </header>

      {cards.length === 0 ? (
        <p className="pool__note">Nothing picked yet.</p>
      ) : (
        <div className="pool__curve">
          {byManaValue(cards).map(([mv, bucket]) => (
            <div key={mv} className="pool__bucket">
              <h3 className="pool__bucket-title">
                {mv} <span className="pool__bucket-n">({bucket.length})</span>
              </h3>
              <div className="pool__bucket-cards">
                {bucket.map((card) => (
                  <CardTile key={card.cardId} card={card} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
