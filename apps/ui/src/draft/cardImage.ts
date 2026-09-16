/*
 * The only place in this project where a card image URL exists.
 *
 * ## D13, precisely
 *
 * The rule is not "no card images". It is `docs/LICENSING.md` §Concrete rules:
 *
 *   2. Never commit or host card images. Card art belongs to WotC and the
 *      artists — *nobody* can license it to us, Scryfall included.
 *   3. **Client-side image fetching only.** The browser fetches images from an
 *      upstream source directly; our server never proxies, caches or stores
 *      them. **This keeps us a link, not a host.**
 *
 * So: the payload carries Scryfall's card *id*. This module turns an id into a
 * URL **in the browser, at render time**. The URL is never committed, never
 * serialised into a payload, and never seen by our server — which serves
 * `apps/ui/dist` and an API and has no image route at all.
 *
 * That distinction is the whole rule. A cached copy, a proxy endpoint, or a
 * `pool.json` full of URLs would each make us a host. An `<img src>` the
 * browser resolves against `cards.scryfall.io` makes us a link.
 *
 * ## Why `normal`, and why not `art_crop`
 *
 * `normal` is the whole card face — frame, type line, and **the copyright and
 * artist credit printed on the card itself**. Scryfall's image guidelines are
 * about presentation: don't cover, crop or clip off the copyright or artist
 * name; don't distort, skew, stretch, blur, sharpen or recolour; don't add your
 * own watermark. Serving the unmodified whole card satisfies all of them by
 * construction, with nothing for us to remember.
 *
 * `art_crop` would oblige us to surface the artist and copyright ourselves
 * somewhere in the same interface. That is a promise the UI would have to keep
 * forever, and the first redesign that moved a caption would quietly break it.
 *
 * ## No WotC marks — still true, and not in tension
 *
 * D13 also forbids WotC trademarks in *our* UI: no mana symbols, set symbols,
 * tap symbol, card frames, or the Magic wordmark drawn by us. That governs the
 * chrome we author — which is why `ManaPip` draws its own circles and renders
 * `{T}` as the word TAP. A card image is the card, fetched from upstream and
 * unmodified; it is not us drawing their marks.
 */

/** Scryfall's image sizes, in the URL shape they publish. */
export type CardImageSize = 'small' | 'normal' | 'large';

const HOST = 'https://cards.scryfall.io';

/**
 * Build the image URL for a card, or `null` when there is no id to build from.
 *
 * The path shape is `<size>/front/<id[0]>/<id[1]>/<id>.jpg` — Scryfall shards
 * by the first two characters of the id. Deterministic, so nothing has to be
 * looked up and no request is made to find out where an image lives.
 *
 * Returns `null` rather than a placeholder for the 47 cards in our cube that do
 * not resolve (Forge set codes with no Scryfall mapping). The caller renders
 * the text tile, which is a complete card on its own.
 */
export function cardImageUrl(
  scryfallId: string | undefined,
  size: CardImageSize = 'normal',
): string | null {
  if (typeof scryfallId !== 'string' || scryfallId.length < 2) return null;
  // Guard the shape rather than trusting it: an id that is not a uuid would
  // build a URL that 404s, and a 404 per card is a slow, silent way to look
  // broken. Cheap enough to do per render.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scryfallId)) {
    return null;
  }
  const a = scryfallId[0];
  const b = scryfallId[1];
  return `${HOST}/${size}/front/${a}/${b}/${scryfallId}.jpg`;
}

/**
 * Deliberately no `srcset`.
 *
 * A card tile is `--card-w: 190px`. Scryfall's `normal` is 488px wide, which
 * covers that to ~2.5x device pixel ratio — so `large` (672px) is never the
 * right choice for this UI, at any display density.
 *
 * The first cut shipped a srcset with `sizes="var(--card-w)"`. A CSS variable
 * is not a valid length in a `sizes` attribute, so the browser discarded it,
 * fell back to `100vw`, and picked the LARGEST candidate every time: 780x1086
 * images for a 190px slot, verified in a real browser. Fifteen of those per
 * pack is roughly three times the bytes for no visible difference, and it is a
 * good part of why the table felt slow.
 *
 * One size, chosen correctly, beats a responsive set that resolves wrong.
 */
