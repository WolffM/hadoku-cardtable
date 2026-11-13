import type { DraftCard } from '@hadoku/shared';

import { artCredit, useArtist } from '../../draft/artists.ts';
import { cardImageUrl } from '../../draft/cardImage.ts';
import { RulesText } from '../prompts/RulesText.tsx';
import './placed.css';

/**
 * AE29 (the operator, 2026-10-09: "ability chip is the correct thing to do"): an ability is an EFFECT
 * of its card, never a second copy of it — half a card tall, the source's art as a band with its
 * name, the ability's own text beneath, rounded, no frame, an accent glow. Mock-up: the operator's
 * `ae29-options.html`, option 1. Drawn for an ability on the stack (`placed.ts`) and for a
 * player's emblems, which the avatar's hover enlarges (`Board.tsx`'s `SeatFace`).
 *
 * The band is the art without the card's frame, so it carries the illustrator and copyright itself
 * (Scryfall's image guidelines for art shown cropped), and shows no art it cannot credit. A source
 * with no printed art of its own — an emblem, an effect, a token the art index has no row for — has
 * no art id, so its band is its name alone: no art, no credit.
 */
export function AbilityChip({ source, name, text }: { readonly source: DraftCard | null; readonly name: string; readonly text: string }) {
  const artId = source?.scryfallId ?? null;
  const artist = useArtist(artId);
  const art = artId === null || typeof artist !== 'string' ? null : cardImageUrl(artId);
  return (
    <div className="placed__chip" data-ability-chip="">
      <div className="placed__chip-band">
        {art === null ? null : <img className="placed__chip-art" src={art} alt="" aria-hidden="true" draggable={false} />}
        {art === null || typeof artist !== 'string' ? null : <span className="placed__chip-credit">{artCredit(artist)}</span>}
        <span className="placed__chip-name">{name}</span>
      </div>
      <div className="placed__chip-text">
        <RulesText text={text} />
      </div>
    </div>
  );
}
