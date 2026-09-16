import { memo, useMemo } from 'react';
/**
 * One card, drawn as our own layout.
 *
 * ## What this deliberately is not
 *
 * It is not a Magic card frame. There is no art box, no beveled border, no set
 * symbol, no rarity gem, no type icon, and no image of any kind — D13 and the
 * repo's trademark rule both point the same way, and the cheapest way to stay
 * on the right side of them is to build a layout that could not be mistaken for
 * the printed object: a flat panel, name and cost on one row, type line, rules
 * text, and a stat badge. Colour identity shows as a stripe down the leading
 * edge, which is ours.
 *
 * Rarity is a letter, not a gem: `C U R M S`.
 *
 * ## Oracle text keeps its newlines
 *
 * Abilities are newline-separated in the payload and each one is its own line
 * here. Collapsing them into a paragraph makes a five-ability planeswalker
 * unreadable, which is the card you most need to read before picking.
 */

import type { DraftCard } from '../draft/types.ts';
import { ManaCost, ManaPip } from './ManaPip.tsx';
import { cardImageUrl } from '../draft/cardImage.ts';

const RARITY_LETTER: Record<string, string> = {
  common: 'C',
  uncommon: 'U',
  rare: 'R',
  mythic: 'M',
  special: 'S',
};

/**
 * Inline `{T}`/`{G}`-style symbols inside rules text, rendered with the same
 * pips as the cost. Without this an activated ability reads `{R}, {T}, Exile…`
 * with literal braces, which is the one place a text-only card actually gets
 * harder to read than a printed one.
 */
function RulesLine({ line }: { line: string }) {
  const pieces = line.split(/(\{[^}]{1,5}\})/g).filter((p) => p !== '');
  return (
    <span className="card__rules-line">
      {pieces.map((piece, i) => {
        const symbol = /^\{([^}]{1,5})\}$/.exec(piece);
        if (!symbol) return <span key={i}>{piece}</span>;
        if (symbol[1] === 'T') {
          // The tap symbol is a WotC mark. This is our word for it.
          return (
            <span key={i} className="pip pip--generic pip--wide" title="tap">
              <span className="pip__label">TAP</span>
            </span>
          );
        }
        return <ManaPip key={i} token={symbol[1]} />;
      })}
    </span>
  );
}

export interface CardTileProps {
  card: DraftCard;
  /** Present on a pack card, absent in the pool. */
  onPick?: (cardId: string) => void;
  disabled?: boolean;
}

function CardTileImpl({ card, onPick, disabled = false }: CardTileProps) {
  const identity = card.colors.length === 0 ? 'colorless' : card.colors.join('').toLowerCase();
  // Splitting oracle text runs a regex per line. It is small per card and
  // ruinous in aggregate: a late-draft screen holds 15 pack tiles plus a pool
  // of up to 45, and without this every one of them re-parsed its rules on
  // every pick. Keyed on the text, so it is computed once per card for the
  // lifetime of the tile.
  const rulesLines = useMemo(
    () => card.oracleText.split('\n').filter((l) => l !== ''),
    [card.oracleText],
  );
  const stat =
    card.loyalty !== undefined
      ? card.loyalty
      : card.power !== undefined && card.toughness !== undefined
        ? `${card.power}/${card.toughness}`
        : null;

  // The image URL is built HERE, in the browser, from an id the payload
  // carries. It is never stored, never serialised, and never touches our
  // server — D13's "a link, not a host". See ../draft/cardImage.ts.
  const imageUrl = cardImageUrl(card.scryfallId);

  const body = (
    <>
      {imageUrl !== null && (
        // The whole unmodified card face, which carries its own copyright and
        // artist credit — so Scryfall's presentation rules are satisfied by
        // construction rather than by remembering to add a caption.
        //
        // `loading="lazy"` because a pack is 15 cards and a pool reaches 45;
        // `decoding="async"` so decode never blocks a pick. On error the img
        // removes itself and the text tile underneath is what you see, which
        // is a complete card on its own — the 47 cards in this cube with no
        // Scryfall mapping take that path every time.
        <img
          className="card__art"
          src={imageUrl}
          // No srcSet: one correctly-chosen size beats a responsive set that
          // resolves to the largest candidate. See cardImage.ts.
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
      <span className="card__stripe" data-identity={identity} aria-hidden="true" />
      <span className="card__head">
        <span className="card__name">{card.name}</span>
        <ManaCost cost={card.manaCost} label={`${card.name} costs ${card.manaCost.join(' ')}`} />
      </span>
      <span className="card__type">{card.typeLine}</span>
      <span className="card__rules">
        {rulesLines.map((line, i) => (
          <RulesLine key={i} line={line} />
        ))}
      </span>
      <span className="card__foot">
        <span className="card__print">
          {card.setCode} {card.collectorNumber}
          <span className="card__rarity" title={card.rarity}>
            {RARITY_LETTER[card.rarity] ?? '?'}
          </span>
        </span>
        {stat !== null && (
          <span className="card__stat" title={card.loyalty !== undefined ? 'loyalty' : 'power / toughness'}>
            {stat}
          </span>
        )}
      </span>
    </>
  );

  if (!onPick) {
    return (
      <article className="card" data-card-id={card.cardId} data-testid="card">
        {body}
      </article>
    );
  }

  return (
    <button
      type="button"
      className="card card--pickable"
      data-card-id={card.cardId}
      data-testid="card"
      disabled={disabled}
      onClick={() => onPick(card.cardId)}
      aria-label={`Pick ${card.name}`}
    >
      {body}
    </button>
  );
}

/**
 * Memoised on purpose.
 *
 * A card is immutable for the life of a draft — `cardId` is stable and nothing
 * about a printed card changes — so a tile only ever needs to re-render when it
 * is handed a different card. Without this, one pick re-rendered every tile on
 * screen: 15 in the pack plus the whole pool, which grows to 45. That is the
 * lag, and it got worse the further into a draft you were.
 *
 * `onPick` must be referentially stable for this to bite — see the `useCallback`
 * in DraftScreen. A fresh closure per render would defeat the comparison and
 * quietly restore the old behaviour.
 */
export const CardTile = memo(CardTileImpl);
