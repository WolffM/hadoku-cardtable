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

export function CardTile({ card, onPick, disabled = false }: CardTileProps) {
  const identity = card.colors.length === 0 ? 'colorless' : card.colors.join('').toLowerCase();
  const stat =
    card.loyalty !== undefined
      ? card.loyalty
      : card.power !== undefined && card.toughness !== undefined
        ? `${card.power}/${card.toughness}`
        : null;

  const body = (
    <>
      <span className="card__stripe" data-identity={identity} aria-hidden="true" />
      <span className="card__head">
        <span className="card__name">{card.name}</span>
        <ManaCost cost={card.manaCost} label={`${card.name} costs ${card.manaCost.join(' ')}`} />
      </span>
      <span className="card__type">{card.typeLine}</span>
      <span className="card__rules">
        {card.oracleText
          .split('\n')
          .filter((l) => l !== '')
          .map((line, i) => (
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
