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
 * name comes from `lookup.ts` — so the tile is built here from just the name,
 * and the art is resolved exactly as the board resolves it: through the w19
 * art-id table (`adapter.ts`'s `KNOWN_ART_IDS`, `@hadoku/carddata/art`) by
 * `scryfallIdFor`'s bare-name row, then by `CardTile` → `cardImageUrl`. No
 * prompt names an image host, and none ever builds a URL.
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
export function promptCardTile(forgeId: number, name: string): DraftCard {
  const card: DraftCard = {
    cardId: `w${forgeId}`,
    name,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: '',
    oracleText: '',
    setCode: '',
    collectorNumber: '',
    // The rarity letter the board's tiles draw for a card whose rarity the
    // wire did not carry (`adapter.ts` maps unknown the same way).
    rarity: 'special',
  };
  const scryfallId = scryfallIdFor(KNOWN_ART_IDS, name, '');
  if (scryfallId !== undefined) card.scryfallId = scryfallId;
  return card;
}
