/*
 * The frame every prompt draws in: a title, Forge's message, the body, the
 * reasons the current answer cannot be sent yet, and the buttons.
 *
 * The submit button is disabled while `problems` is non-empty, and `problems`
 * always comes from `rules.ts`. That is the whole enforcement story: the rules
 * are pure and tested on their own, and the shell makes them the only way out.
 *
 * This is also where the lane's one shared piece lives: `promptCardTile`, the
 * card-as-tile every prompt below renders (operator, wave 20: *"prompts are
 * cards"* — a tutor choice is the board's card look, never a text list).
 */

import type { ReactNode } from 'react';

import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import type { DraftCard } from '@hadoku/shared';

import './prompts.css';
import type { PromptLookup } from './lookup.ts';
import type { PromptMethod } from './types.ts';

export interface PromptShellProps {
  method: PromptMethod;
  title: string;
  message?: string;
  problems?: readonly string[];
  submitLabel?: string;
  /** Omit for a prompt that answers without a button (the zone prompts). */
  onSubmit?: () => void;
  /** Buttons beside submit, e.g. "Decline" on an optional choice. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function PromptShell({
  method,
  title,
  message,
  problems = [],
  submitLabel = 'OK',
  onSubmit,
  actions,
  children,
}: PromptShellProps) {
  return (
    <section className="prompt" data-prompt={method} role="dialog" aria-label={title}>
      <h3 className="prompt__title">{title}</h3>
      {message !== undefined && message !== '' && <p className="prompt__message">{message}</p>}
      {children}
      {problems.length > 0 && (
        <ul className="prompt__problems" data-testid="prompt-problems" aria-live="polite">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {(onSubmit !== undefined || actions !== undefined) && (
        <div className="prompt__actions">
          {actions}
          {onSubmit !== undefined && (
            <button
              type="button"
              className="prompt__submit"
              data-testid="prompt-submit"
              disabled={problems.length > 0}
              onClick={onSubmit}
            >
              {submitLabel}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A card a prompt was asked about, as the board's own `CardTile` draws it.
 *
 * An ask never carries a card — it carries a `{ kind: 'card', id }` ref and the
 * name and printing come from `lookup.ts` — so the tile is built here from
 * those two facts, and the art is resolved exactly as the board resolves it:
 * through the w19 art-id table (`adapter.ts`'s `KNOWN_ART_IDS`,
 * `@hadoku/carddata/art`) by `scryfallIdFor(index, name, setCode)`, then by
 * `CardTile` → `cardImageUrl`. No prompt names an image host, and none ever
 * builds a URL.
 *
 * **The `setCode` argument is wave 24 §D.3.** It used to be `''` here, so a
 * prompt tile could only ever hit the table's bare-name row while the board hit
 * `Name|SET` first — the same card, two printings, and nothing at all for a
 * card whose only row is the exact printing. `PromptCardFacts.setCode` now
 * carries Forge's own `SetCode` for the face on show, so a prompt and the board
 * ask the table the same question and get the same answer.
 *
 * What the board has and this has not — cost, type line, oracle text, stats —
 * the lookup does not carry (it is a prompt's seam, not a board's). The tile
 * shows the name and, when the table knows the card, its art; a card the table
 * does not know draws the text tile, which is the same fallback the board
 * makes. Nothing here invents a fact the wire did not send.
 *
 * `cardId` is `w<forge id>` on purpose: that is the draft's namespace
 * `CardTile` stamps its own `data-card-id` in, which the DOM contract
 * (`Board.tsx`) already accounts for — the prompt's tile wrapper carries the
 * bare forge id beside it.
 */
export function promptCardTile(forgeId: number, name: string, setCode = ''): DraftCard {
  const card: DraftCard = {
    cardId: `w${forgeId}`,
    name,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: '',
    oracleText: '',
    setCode,
    collectorNumber: '',
    // The rarity letter the board's tiles draw for a card whose rarity the
    // wire did not carry (`adapter.ts` maps unknown the same way).
    rarity: 'special',
  };
  const scryfallId = scryfallIdFor(KNOWN_ART_IDS, name, setCode);
  if (scryfallId !== undefined) card.scryfallId = scryfallId;
  return card;
}

/**
 * The tile for a card an ask named, built from the lookup alone — the one place
 * a prompt turns a `{ kind: 'card', id }` into a face.
 *
 * Every card-drawing prompt goes through this rather than reaching for the
 * name and the set code separately, so "a prompt resolves art the way the board
 * does" is one function instead of a convention. `label` overrides the name for
 * the asks where Forge pre-renders it (`getChoices`, `order`); the printing
 * still comes from the lookup, because a label is not a card name.
 */
export function promptTileFor(lookup: PromptLookup, forgeId: number, label?: string): DraftCard {
  const facts = lookup.card(forgeId);
  return promptCardTile(forgeId, label ?? facts?.name ?? `card #${forgeId}`, facts?.setCode ?? '');
}
