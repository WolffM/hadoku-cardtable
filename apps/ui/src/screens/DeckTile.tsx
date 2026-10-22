/*
 * The room's deck tile, on its own: the `deckpick__option` box with the deck's art band, its name,
 * its play-style mark, its colours and its pilot, and the `chosen` chip when it is the one chosen
 * (`screens.css` draws it). The room's picker (`ConstructedScreen.tsx`'s `DeckChooser`) and the
 * Gauntlet's board (`gauntlet/`) draw a deck with this one tile; each passes the button's own
 * behaviour (its role, its handlers, its test id) and may lay something over it as `children`.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

import { DeckColors } from '../components/DeckView.tsx';
import { DeckArt, type DeckOption } from './ConstructedScreen.tsx';
import { DeckStyleTag } from './DeckStyleTag.tsx';

export type DeckTileProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-checked'> & {
  option: DeckOption;
  /** The chosen deck: `aria-checked` and the `chosen` chip. Absent on a tile that is not a choice. */
  checked?: boolean;
  ref?: Ref<HTMLButtonElement>;
  /** Drawn over the tile, after its own parts. */
  children?: ReactNode;
  /** Data attributes pass through to the button. */
  [data: `data-${string}`]: string | number | boolean | undefined;
};

export function DeckTile({ option, checked, className, children, ref, ...button }: DeckTileProps) {
  // A deck with a list opens its peek on hover, which names it and its style; a native tooltip on top doubles it.
  const peekable = option.list !== undefined;
  return (
    <button
      ref={ref}
      type="button"
      className={className === undefined ? 'deckpick__option' : `deckpick__option ${className}`}
      data-deck-id={option.value}
      data-colors={option.colors.join('')}
      data-style={option.deckStyle}
      aria-checked={checked}
      {...button}
    >
      <DeckArt artId={option.artId} />
      <span className="deckpick__name" title={peekable ? undefined : option.label}>
        {option.name ?? option.label}
      </span>
      {option.deckStyle !== undefined && <DeckStyleTag style={option.deckStyle} markOnly titled={!peekable} />}
      <DeckColors colors={option.colors} titled={!peekable} label={`${option.label}: ${option.colors.length === 0 ? 'colourless' : option.colors.join(' ')}`} />
      {option.pilot !== undefined && <span className="deckpick__pilot">{option.pilot}</span>}
      {checked === true && (
        <span className="deckpick__mark" aria-hidden="true">
          chosen
        </span>
      )}
      {children}
    </button>
  );
}
