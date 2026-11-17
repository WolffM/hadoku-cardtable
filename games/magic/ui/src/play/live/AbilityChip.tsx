import { useEffect, useState } from 'react';
import { BACK_FACE } from '@hadoku/carddata/art';
import type { DraftCard } from '@hadoku/shared';
import { apiUrl, bodyOf, getJson, isRecord, pageFetch, readOnce, type Fetch } from '@hadoku/game-ui/http.ts';

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
 *
 * ## A source the committed artist table never covered
 *
 * `useArtist` answers from `art-artists.json`, a committed table built to cover the bundled cube and
 * the committed `art-ids.json` rows (`scripts/art/build-art-artists.ts`) — fast, and no request, for
 * the cards it knows. A CONSTRUCTED deck can name any card ever printed, and a table built to cover
 * all of them would be most of Scryfall, which is not what a lazy chunk is for. So an id the table
 * answers `null` for (checked and not found — never `undefined`, which means it is still loading)
 * falls back to the server's own live lookup, `GET /api/art/<id>/artist` (`card-art.ts`), which reads
 * the same Scryfall corpus the catalog's own daily refresh keeps current. Dragonologist's chip, then
 * Betor, Kin to All's, drew no art for exactly this reason: `play/art-ids.ts` resolved their id fine
 * (neither 404s, neither needs a mirror row), the committed table just never heard of either.
 */
function useLiveArtist(artId: string | null, enabled: boolean): string | null | undefined {
  const [artist, setArtist] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled || artId === null) return;
    let live = true;
    setArtist(undefined);
    void liveArtistOf(artId).then(
      (found) => {
        if (live) setArtist(found);
      },
      () => {
        if (live) setArtist(null);
      },
    );
    return () => {
      live = false;
    };
  }, [artId, enabled]);
  return artId === null ? null : enabled ? artist : undefined;
}

/** `fetch`, swappable for a test's stub (`configureLiveArtistForTests`); the page's own otherwise. */
let liveArtistFetch: Fetch = pageFetch;

/** For a test: a stub `fetch` for `useLiveArtist`'s own lookup, and forget what the real one answered. `null` restores the page's own. */
export function configureLiveArtistForTests(fetchImpl: Fetch | null): void {
  liveArtistFetch = fetchImpl ?? pageFetch;
}

/** The artist `GET /api/art/<id>/artist` answers for `artId` (an art id: a Scryfall id, or one carrying {@link BACK_FACE}), read once per id for the page's life; `null` for an id the corpus has none for, so a later render with the same id finds it already answered. A failed read is not kept, so the next render asks again. */
function liveArtistOf(artId: string): Promise<string | null> {
  const back = artId.endsWith(BACK_FACE);
  const id = back ? artId.slice(0, -BACK_FACE.length) : artId;
  const url = apiUrl(`art/${id}${back ? '/back' : ''}/artist`);
  return readOnce(liveArtistFetch, url, async () => {
    const res = await getJson(url, liveArtistFetch);
    if (!res.ok) return null;
    const body = await bodyOf(res);
    return isRecord(body) && typeof body.artist === 'string' ? body.artist : null;
  });
}

export function AbilityChip({ source, name, text }: { readonly source: DraftCard | null; readonly name: string; readonly text: string }) {
  const artId = source?.scryfallId ?? null;
  const tableArtist = useArtist(artId);
  const liveArtist = useLiveArtist(artId, tableArtist === null);
  const artist = tableArtist === null ? liveArtist : tableArtist;
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
