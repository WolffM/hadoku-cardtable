/*
 * The Library's Cards tab (`#/library/cards`): which printing each of your cards is drawn as.
 *
 * The box searches every card (`GET /api/cards/search`); empty, the grid is the cards you have
 * picked art for. A card opens its printings beside the grid, oldest first as the server sends
 * them (`GET /api/cards/printings`), each named by its set and year. The oldest wears an hourglass,
 * the default a dot, your pick a check and the accent ring; the large art above them is the one
 * your card draws (your pick, else the oldest when "Always use oldest art" is on, else the default),
 * credited as a deck tile's art is (`DeckArt`). Reset to default clears the pick.
 *
 * The rules are the server's (`GET`/`PUT /api/me/art`, `../deck/artRules.ts`), never the browser's.
 * A press draws its change at once and writes it; a refused write draws the rules as they were.
 * "Always use oldest art" itself is a Settings toggle (`../settings/GameSettings.tsx`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@wolffm/themes';
import type { DraftCard } from '@hadoku/shared';
import { uiLength } from '@hadoku/ui-shell/settings';

import { CardTile } from '../components/CardTile.tsx';
import { cardImageUrl } from '../draft/cardImage.ts';
import { artClient, changeArt, pickKey, withPick, type ArtClient, type ArtRules, type CardPrinting } from '../deck/artRules.ts';
import { cardSearch, facesForNames, SEARCH_LIMIT, type CardSearch } from '../deck/builtDecks.ts';
import { ChipFilterBar } from './DeckFilterBar.tsx';
import { deckCardArtId, useNamedArt } from './libraryPeek.ts';
import { DeckArt } from './ConstructedScreen.tsx';
import './LibraryCards.css';

/** How long typing rests before the search is asked. */
const SEARCH_DELAY_MS = 250;

/** One printing as the strip draws it. */
export interface StripPrinting extends CardPrinting {
  oldest: boolean;
  isDefault: boolean;
  picked: boolean;
  year: string | null;
}

/** The strip: the server's order (oldest first), the first marked oldest, the default and the pick marked. */
export function printingStrip(printings: readonly CardPrinting[], pick: string | undefined, defaultId: string | undefined): StripPrinting[] {
  return printings.map((p, i) => ({ ...p, oldest: i === 0, isDefault: p.scryfallId === defaultId, picked: p.scryfallId === pick, year: p.releasedAt?.slice(0, 4) ?? null }));
}

/** The printing a card of yours draws as: your pick, else the oldest when that rule is on, else the default. */
export function drawnPrinting(strip: readonly StripPrinting[], oldest: boolean, defaultId: string | undefined): string | undefined {
  return strip.find((p) => p.picked)?.scryfallId ?? (oldest ? strip[0]?.scryfallId : undefined) ?? defaultId;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function LibraryCards({ art: givenArt, search: givenSearch }: { art?: ArtClient; search?: CardSearch }) {
  const art = useMemo(() => givenArt ?? artClient(), [givenArt]);
  const search = useMemo(() => givenSearch ?? cardSearch(), [givenSearch]);
  const [rules, setRules] = useState<ArtRules | null>(null);
  const [query, setQuery] = useState('');
  const [cards, setCards] = useState<readonly DraftCard[]>([]);
  const [open, setOpen] = useState<DraftCard | null>(null);
  const [printings, setPrintings] = useState<readonly CardPrinting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useNamedArt();

  useEffect(() => {
    let live = true;
    art.getArt().then(
      (r) => live && setRules(r),
      (err: unknown) => live && setError(message(err)),
    );
    return () => {
      live = false;
    };
  }, [art]);

  // The box's answer; empty, the cards you have picked art for (a search each, so the first page of them).
  const pickedNames = rules === null ? null : Object.keys(rules.picks).sort().slice(0, SEARCH_LIMIT).join('\n');
  useEffect(() => {
    const q = query.trim();
    if (q === '' && pickedNames === null) return;
    let live = true;
    const ask = q === '' ? () => facesForNames(search, pickedNames === '' || pickedNames === null ? [] : pickedNames.split('\n'), []) : () => search(q, []);
    const timer = setTimeout(
      () =>
        ask().then(
          (found) => live && setCards(found),
          (err: unknown) => live && setError(message(err)),
        ),
      q === '' ? 0 : SEARCH_DELAY_MS,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, pickedNames, search]);

  useEffect(() => {
    if (open === null) return;
    let live = true;
    setPrintings(null);
    art.printings(open.name).then(
      (p) => live && setPrintings(p),
      (err: unknown) => live && setError(message(err)),
    );
    return () => {
      live = false;
    };
  }, [art, open?.name]);

  const choose = useCallback((cardId: string) => setOpen(cards.find((c) => c.cardId === cardId) ?? null), [cards]);

  const pick = (name: string, scryfallId: string | null): void => {
    if (rules === null) return;
    const before = rules;
    setRules(withPick(rules, name, scryfallId));
    void changeArt(art, (r) => withPick(r, name, scryfallId)).then((r) => {
      if (r.ok) {
        setRules(r.rules);
        setError(null);
      } else {
        setRules(before);
        setError(r.message);
      }
    });
  };

  const pickOf = (name: string): string | undefined => rules?.picks[pickKey(name)];
  const defaultId = open === null ? undefined : deckCardArtId(open.name);
  const strip = printings === null || open === null ? null : printingStrip(printings, pickOf(open.name), defaultId);

  return (
    <section className="lobby__card library-cards" data-testid="library-cards">
      {error !== null && (
        <p className="ct-error" role="alert" data-testid="library-cards-error">
          {error}
        </p>
      )}
      <div className="lobby__setsrow library__toolbar">
        <ChipFilterBar testId="library-cards-filter" sets={[]} search={{ testId: 'library-cards-search', placeholder: 'Card', ariaLabel: 'Card name', value: query, onChange: setQuery }} />
      </div>
      <div className="library-cards__body">
        <div className="library-cards__grid" data-testid="library-cards-grid">
          {cards.map((card) => {
            const picked = pickOf(card.name);
            return (
              <div key={card.cardId} className="library-cards__result" data-testid="library-card" data-name={card.name} data-open={open?.name === card.name ? '' : undefined}>
                <CardTile card={picked === undefined ? card : { ...card, scryfallId: picked }} onPick={choose} />
                {picked !== undefined && (
                  <span className="library-cards__mark" data-testid="library-card-picked">
                    <Icon name="check" size={uiLength('0.75rem')} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {open !== null && (
          <aside className="library-cards__picker" aria-label={open.name} data-testid="library-printings">
            <h2 className="library-cards__name">
              {open.name}
              {printings !== null && <span className="library__count">{printings.length}</span>}
            </h2>
            <div className="library-cards__preview">
              <DeckArt artId={strip === null ? undefined : drawnPrinting(strip, rules?.oldest ?? false, defaultId)} />
            </div>
            <div className="library-cards__strip">
              {strip?.map((p) => (
                <button
                  key={p.scryfallId}
                  type="button"
                  className="library-cards__printing"
                  aria-pressed={p.picked}
                  aria-label={`${p.set} ${p.collectorNumber}${p.year === null ? '' : ` ${p.year}`}`}
                  data-testid="library-printing"
                  data-scryfall-id={p.scryfallId}
                  data-oldest={p.oldest ? '' : undefined}
                  data-default={p.isDefault ? '' : undefined}
                  disabled={rules === null}
                  onClick={() => pick(open.name, p.scryfallId)}
                >
                  <img src={cardImageUrl(p.scryfallId, 'small') ?? undefined} alt="" loading="lazy" />
                  <span className="library-cards__marks">
                    {p.oldest && <Icon name="hourglass" size={uiLength('0.75rem')} />}
                    {p.isDefault && <Icon name="circle-dot" size={uiLength('0.75rem')} />}
                    {p.picked && <Icon name="check" size={uiLength('0.75rem')} />}
                  </span>
                  <span className="library-cards__set">
                    <span>{p.set}</span>
                    {p.year !== null && <span>{p.year}</span>}
                  </span>
                </button>
              ))}
            </div>
            <button type="button" className="ct-action library-cards__reset" data-testid="library-art-reset" disabled={rules === null || pickOf(open.name) === undefined} onClick={() => pick(open.name, null)}>
              <span className="ct-action__label">Reset to default</span>
            </button>
          </aside>
        )}
      </div>
    </section>
  );
}
